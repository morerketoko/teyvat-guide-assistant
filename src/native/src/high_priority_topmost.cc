#include <napi.h>
#include <windows.h>
#include <thread>
#include <atomic>
#include <functional>
#include <chrono>
#include <string>
#include <vector>

// ============================================================
// High-priority topmost module - HWND-direct, Z-order precise
//
// FIX vs old implementation:
//   - No more title-string lookup (brittle: case-sensitive match,
//     dynamic web-page titles, hidden windows being skipped).
//   - Window handle is passed directly as a Napi Buffer (from
//     Electron's getNativeWindowHandle()) / BigInt / Number.
//   - Dual-mode: interactive mode (default) keeps WS_EX_NOACTIVATE
//     cleared so the window can take focus when summoned; pinned
//     (HUD) mode dynamically attaches WS_EX_NOACTIVATE via
//     setWindowPinnedMode so the window stays topmost-pinned but
//     never steals focus from the game.
//   - Monitor thread uses a precise GW_HWNDPREV check instead of
//     the fuzzy "walk top N windows" heuristic, and re-asserts
//     TOPMOST without activating (SWP_NOACTIVATE) on a 200ms
//     cadence so it wins the Z-order race against fullscreen games.
// ============================================================

// Global state
std::atomic<bool> monitoringActive{false};
std::thread monitorThread;
HWND trackedHwnd = NULL;

// Extract an HWND from a Napi argument (Buffer / BigInt / Number)
HWND GetHWNDFromArg(const Napi::CallbackInfo& info, size_t index) {
    if (info.Length() <= index) return NULL;

    if (info[index].IsBuffer()) {
        Napi::Buffer<char> buf = info[index].As<Napi::Buffer<char>>();
        if (buf.Length() >= sizeof(HWND)) {
            return *reinterpret_cast<HWND*>(buf.Data());
        }
        return NULL;
    }
    if (info[index].IsBigInt()) {
        bool lossless = false;
        int64_t v = info[index].As<Napi::BigInt>().Int64Value(&lossless);
        return reinterpret_cast<HWND>(static_cast<uintptr_t>(v));
    }
    if (info[index].IsNumber()) {
        return reinterpret_cast<HWND>(
            static_cast<uintptr_t>(info[index].As<Napi::Number>().Int64Value()));
    }
    return NULL;
}

// Set / clear topmost; never leaves WS_EX_NOACTIVATE set
bool SetWindowAlwaysOnTop(HWND hwnd, bool topmost) {
    if (!IsWindow(hwnd)) return false;

    HWND insertAfter = topmost ? HWND_TOPMOST : HWND_NOTOPMOST;
    UINT flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;

    if (topmost) {
        // FIX: clear WS_EX_NOACTIVATE - it blocked activation, which is why
        // summoned windows could not take focus in front of games.
        LONG_PTR exStyle = GetWindowLongPtr(hwnd, GWL_EXSTYLE);
        if (exStyle & WS_EX_NOACTIVATE) {
            SetWindowLongPtr(hwnd, GWL_EXSTYLE, exStyle & ~WS_EX_NOACTIVATE);
        }
    }

    bool result = SetWindowPos(hwnd, insertAfter, 0, 0, 0, 0, flags);

    // Re-assert topmost a few times for stubborn fullscreen apps
    if (topmost && result) {
        for (int i = 0; i < 3; i++) {
            SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags);
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
    }
    return result;
}

// Burst-summon: force foreground + topmost, breaking the Windows foreground
// lock that fullscreen / borderless games rely on.
bool ForceForegroundAndTopmost(HWND hwnd) {
    if (!hwnd || !IsWindow(hwnd)) return false;

    // 1. Ensure the window can take focus
    LONG_PTR exStyle = GetWindowLongPtr(hwnd, GWL_EXSTYLE);
    if (exStyle & WS_EX_NOACTIVATE) {
        SetWindowLongPtr(hwnd, GWL_EXSTYLE, exStyle & ~WS_EX_NOACTIVATE);
    }

    // 2. AttachThreadInput - documented workaround for the foreground lock
    HWND foregroundWindow = GetForegroundWindow();
    DWORD currentThreadId = GetCurrentThreadId();
    DWORD foregroundThreadId = 0;
    bool attached = false;
    if (foregroundWindow && foregroundWindow != hwnd) {
        foregroundThreadId = GetWindowThreadProcessId(foregroundWindow, NULL);
        if (currentThreadId != 0 && foregroundThreadId != 0) {
            AttachThreadInput(currentThreadId, foregroundThreadId, TRUE);
            attached = true;
        }
    }

    // 3. Show, elevate to TOPMOST, bring to top, grab foreground + focus
    ShowWindow(hwnd, SW_SHOW);
    SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    BringWindowToTop(hwnd);
    SetForegroundWindow(hwnd);
    SetFocus(hwnd);
    SetActiveWindow(hwnd);

    if (attached) {
        AttachThreadInput(currentThreadId, foregroundThreadId, FALSE);
    }

    bool grabbed = (GetForegroundWindow() == hwnd);
    OutputDebugStringA(grabbed
        ? "[Teyvat Debug] forceForegroundAndTopmost: OK"
        : "[Teyvat Debug] forceForegroundAndTopmost: forward not confirmed");
    return grabbed;
}

// Monitor thread: precise Z-order check. If ANY window sits above the target,
// re-assert TOPMOST without activating (SWP_NOACTIVATE), so the window stays
// on top without stealing focus from the game mid-play.
void MonitorThreadLoop(HWND targetHwnd, std::atomic<bool>& running) {
    while (running.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
        if (!IsWindow(targetHwnd) || !IsWindowVisible(targetHwnd)) {
            continue;
        }
        // GW_HWNDPREV = window directly above in the Z-order; NULL means we
        // are already at the very top.
        if (GetWindow(targetHwnd, GW_HWNDPREV) != NULL) {
            SetWindowPos(targetHwnd, HWND_TOPMOST, 0, 0, 0, 0,
                         SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOSENDCHANGING);
        }
    }
}

// Start monitoring a window by direct HWND
Napi::Value StartWindowMonitoring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    HWND targetWindow = GetHWNDFromArg(info, 0);
    if (!targetWindow) {
        Napi::TypeError::New(env, "Valid HWND required (Buffer / BigInt / Number)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    // Stop any previous monitoring (detached thread exits within ~200ms)
    monitoringActive.exchange(false);
    if (monitorThread.joinable()) {
        monitorThread.join();
    }

    // Elevate immediately and grab the front once
    SetWindowAlwaysOnTop(targetWindow, true);
    ForceForegroundAndTopmost(targetWindow);

    trackedHwnd = targetWindow;
    monitoringActive = true;
    monitorThread = std::thread(MonitorThreadLoop, targetWindow, std::ref(monitoringActive));
    monitorThread.detach();

    OutputDebugStringA("[Teyvat Debug] startWindowMonitoring(HWND): monitor thread started");
    return Napi::Boolean::New(env, true);
}

// Stop monitoring
Napi::Value StopWindowMonitoring(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    monitoringActive.exchange(false);
    if (monitorThread.joinable()) {
        monitorThread.join();
    }
    trackedHwnd = NULL;
    return Napi::Boolean::New(env, true);
}

// Set a window topmost (HWND version)
Napi::Value SetWindowTopmost(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    HWND targetWindow = GetHWNDFromArg(info, 0);
    if (!targetWindow) {
        return Napi::Boolean::New(env, false);
    }
    bool topmost = (info.Length() > 1 && info[1].IsBoolean())
        ? info[1].As<Napi::Boolean>().Value() : true;
    return Napi::Boolean::New(env, SetWindowAlwaysOnTop(targetWindow, topmost));
}

// Export wrapper for the burst summon
Napi::Value ForceForegroundAndTopmostExport(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    HWND targetWindow = GetHWNDFromArg(info, 0);
    if (!targetWindow) {
        return Napi::Boolean::New(env, false);
    }
    return Napi::Boolean::New(env, ForceForegroundAndTopmost(targetWindow));
}

// Dual-mode support: toggle WS_EX_NOACTIVATE on the target window.
//   - isPinned = true  -> HUD/pinned mode: attach WS_EX_NOACTIVATE so the
//     window keeps showing (topmost-pinned) but cannot steal focus from the
//     game, which keeps running in the background.
//   - isPinned = false -> interactive mode: detach WS_EX_NOACTIVATE so the
//     window can be activated and focused again (typing / searching).
Napi::Value SetWindowPinnedMode(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        return Napi::Boolean::New(env, false);
    }

    HWND targetWindow = GetHWNDFromArg(info, 0);
    if (!targetWindow || !::IsWindow(targetWindow)) {
        return Napi::Boolean::New(env, false);
    }

    bool isPinned = info[1].As<Napi::Boolean>().Value();

    LONG_PTR exStyle = ::GetWindowLongPtr(targetWindow, GWL_EXSTYLE);
    if (isPinned) {
        exStyle |= WS_EX_NOACTIVATE;
    } else {
        exStyle &= ~static_cast<LONG_PTR>(WS_EX_NOACTIVATE);
    }
    ::SetWindowLongPtr(targetWindow, GWL_EXSTYLE, exStyle);

    // Force the style change through: refresh frame, keep current Z-order
    // and activation state untouched.
    ::SetWindowPos(targetWindow, NULL, 0, 0, 0, 0,
                   SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED | SWP_NOACTIVATE);

    return Napi::Boolean::New(env, true);
}

// Get list of all visible windows (debugging)
Napi::Value GetVisibleWindows(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array windowList = Napi::Array::New(env);

    struct EnumData {
        Napi::Env env;
        Napi::Array* array;
        uint32_t index;
    };
    EnumData enumData = { env, &windowList, 0 };

    EnumWindows([](HWND hwnd, LPARAM lParam) -> BOOL {
        EnumData* data = reinterpret_cast<EnumData*>(lParam);
        if (IsWindowVisible(hwnd)) {
            char windowTextA[512];
            wchar_t windowTextW[512];
            GetWindowTextA(hwnd, windowTextA, sizeof(windowTextA));
            GetWindowTextW(hwnd, windowTextW, sizeof(windowTextW)/sizeof(wchar_t));

            std::string title;
            if (wcslen(windowTextW) > 0) {
                int utf8Length = WideCharToMultiByte(CP_UTF8, 0, windowTextW, -1, NULL, 0, NULL, NULL);
                if (utf8Length > 0) {
                    std::vector<char> utf8Buffer(utf8Length);
                    WideCharToMultiByte(CP_UTF8, 0, windowTextW, -1, utf8Buffer.data(), utf8Length, NULL, NULL);
                    title = std::string(utf8Buffer.data());
                }
            } else if (strlen(windowTextA) > 0) {
                title = std::string(windowTextA);
            }

            if (!title.empty()) {
                Napi::Object windowInfo = Napi::Object::New(data->env);
                windowInfo.Set("title", Napi::String::New(data->env, title));
                windowInfo.Set("handle", Napi::Number::New(data->env,
                    reinterpret_cast<uintptr_t>(hwnd)));
                data->array->Set(data->index++, windowInfo);
            }
        }
        return TRUE;
    }, reinterpret_cast<LPARAM>(&enumData));

    return windowList;
}

// Module initialization
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("startWindowMonitoring", Napi::Function::New(env, StartWindowMonitoring));
    exports.Set("stopWindowMonitoring", Napi::Function::New(env, StopWindowMonitoring));
    exports.Set("setWindowTopmost", Napi::Function::New(env, SetWindowTopmost));
    exports.Set("getVisibleWindows", Napi::Function::New(env, GetVisibleWindows));
    exports.Set("forceForegroundAndTopmost", Napi::Function::New(env, ForceForegroundAndTopmostExport));
    exports.Set("setWindowPinnedMode", Napi::Function::New(env, SetWindowPinnedMode));
    return exports;
}

NODE_API_MODULE(high_priority_topmost, Init)
