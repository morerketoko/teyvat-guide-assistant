#include <napi.h>
#include <windows.h>
#include <thread>
#include <map>
#include <string>
#include <vector>
#include <algorithm>
#include <cctype>
#include <sstream>

// Global state variables
std::thread hotkeyThread;
std::thread mouseHookThread;
DWORD hotkeyThreadId = 0;
bool isRunning = false;
bool mouseHookRunning = false;
bool keyboardHookRunning = false;
Napi::ThreadSafeFunction tsfn;
std::map<int, std::string> idToActionMap;
std::map<std::pair<UINT, UINT>, std::string> mouseKeyMap; // (modifiers, mouseButton) -> action
std::map<std::pair<UINT, UINT>, std::string> keyboardHookMap; // (modifiers, vkCode) -> action
HHOOK mouseHook = NULL;
HHOOK keyboardHook = NULL;

    // FIX: dedicated pump-thread globals for the low-level hooks
    std::thread hookMessageThread;
    DWORD hookMessageThreadId = 0;
    bool hookMessageLoopRunning = false;

// Track modifier key states
bool isShiftPressed = false;
bool isCtrlPressed = false;
bool isAltPressed = false;
bool isWinPressed = false;

// GAME-COMPATIBLE KEYBOARD HOOK - BASED ON CSDN RESEARCH!
LRESULT CALLBACK KeyboardHookProc(int nCode, WPARAM wParam, LPARAM lParam) {
    // CRITICAL: Always process HC_ACTION, ignore nCode < 0 (as per CSDN article)
    if (nCode == HC_ACTION && keyboardHookRunning) {
        KBDLLHOOKSTRUCT* pKeyboard = (KBDLLHOOKSTRUCT*)lParam;
        DWORD vkCode = pKeyboard->vkCode;
        bool isKeyDown = (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN);
        bool isKeyUp = (wParam == WM_KEYUP || wParam == WM_SYSKEYUP);
        
        // GAME COMPATIBILITY: Ignore injected events to prevent infinite loops
        if (pKeyboard->flags & LLKHF_INJECTED) {
            return CallNextHookEx(keyboardHook, nCode, wParam, lParam);
        }
        
        // Track modifier key states with ULTRA precision
        if (isKeyDown || isKeyUp) {
            bool pressed = isKeyDown;
            switch (vkCode) {
                case VK_LSHIFT:
                case VK_RSHIFT:
                    isShiftPressed = pressed;
                    break;
                case VK_LCONTROL:
                case VK_RCONTROL:
                    isCtrlPressed = pressed;
                    break;
                case VK_LMENU:
                case VK_RMENU:
                    isAltPressed = pressed;
                    break;
                case VK_LWIN:
                case VK_RWIN:
                    isWinPressed = pressed;
                    break;
            }
        }
        
        // GAME MODE: Only process key down events for shortcuts
        if (isKeyDown) {
            // Build current modifier mask with HIGH precision
            UINT modifiers = 0;
            if (isShiftPressed) modifiers |= MOD_SHIFT;
            if (isCtrlPressed) modifiers |= MOD_CONTROL;
            if (isAltPressed) modifiers |= MOD_ALT;
            if (isWinPressed) modifiers |= MOD_WIN;
            
            // Check if this key combination is registered
            auto key = std::make_pair(modifiers, vkCode);
            auto it = keyboardHookMap.find(key);
            if (it != keyboardHookMap.end()) {
                std::string action = it->second;
                
                // ULTRA-FAST callback execution for games
                if (tsfn) {
                    tsfn.NonBlockingCall([action](Napi::Env env, Napi::Function jsCallback) {
                        jsCallback.Call({Napi::String::New(env, action)});
                    });
                }
                
                // GAME COMPATIBILITY: Always consume registered shortcuts
                // This prevents games from receiving our hotkeys
                return 1;
            }
        }
    }
    
    // CRITICAL: Always call next hook for system stability
    return CallNextHookEx(keyboardHook, nCode, wParam, lParam);
}

// Mouse hook procedure
LRESULT CALLBACK MouseHookProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode >= 0 && mouseHookRunning) {
        UINT mouseButton = 0;
        if (wParam == WM_XBUTTONDOWN) {
            MSLLHOOKSTRUCT* pMouseStruct = (MSLLHOOKSTRUCT*)lParam;
            WORD xButton = HIWORD(pMouseStruct->mouseData);
            if (xButton == XBUTTON1) mouseButton = 1; // Mouse side button 1
            else if (xButton == XBUTTON2) mouseButton = 2; // Mouse side button 2
            
            // Get current modifier key states from our tracking
            UINT modifiers = 0;
            if (isShiftPressed) modifiers |= MOD_SHIFT;
            if (isCtrlPressed) modifiers |= MOD_CONTROL;
            if (isAltPressed) modifiers |= MOD_ALT;
            if (isWinPressed) modifiers |= MOD_WIN;
            
            auto key = std::make_pair(modifiers, mouseButton);
            auto it = mouseKeyMap.find(key);
            if (it != mouseKeyMap.end()) {
                std::string action = it->second;
                if (tsfn) {
                    tsfn.NonBlockingCall([action](Napi::Env env, Napi::Function jsCallback) {
                        jsCallback.Call({Napi::String::New(env, action)});
                    });
                }
                return 1; // Consume this event
            }
        }
    }
    return CallNextHookEx(mouseHook, nCode, wParam, lParam);
}

// Stop hotkey listener
void StopHotkeyListener() {
    // FIX: signal the hook pump thread to quit first (WM_QUIT wakes GetMessage)
    if (hookMessageLoopRunning) {
        if (hookMessageThreadId != 0) {
            PostThreadMessage(hookMessageThreadId, WM_QUIT, 0, 0);
        }
        hookMessageLoopRunning = false;
        OutputDebugStringA("[Teyvat Debug] StopHotkeyListener: pump thread signaled to quit");
    }

    // Stop keyboard hook - THE ULTIMATE STOPPER!
    if (keyboardHook) {
        UnhookWindowsHookEx(keyboardHook);
        keyboardHook = NULL;
        keyboardHookRunning = false;
    }
    
    // Stop mouse hook
    if (mouseHook) {
        UnhookWindowsHookEx(mouseHook);
        mouseHook = NULL;
        mouseHookRunning = false;
    }
    
    // Stop legacy hotkey listening (kept as backup)
    if (isRunning && hotkeyThreadId != 0) {
        PostThreadMessage(hotkeyThreadId, WM_QUIT, 0, 0);
        if (hotkeyThread.joinable()) {
            hotkeyThread.join();
        }
        hotkeyThreadId = 0;
        isRunning = false;
    }
    
    // Reset modifier key states
    isShiftPressed = false;
    isCtrlPressed = false;
    isAltPressed = false;
    isWinPressed = false;
    
    // Clean up resources
    if (tsfn) {
        tsfn.Release();
        tsfn = nullptr;
    }
    
    mouseKeyMap.clear();
    keyboardHookMap.clear();
}

// Enhanced function to convert string to virtual key code and modifiers
bool StringToVk(const std::string& keyString, UINT& vkCode, UINT& modifiers, UINT& mouseButton) {
    vkCode = 0;
    modifiers = 0;
    mouseButton = 0;
    
    // Split key string
    std::vector<std::string> parts;
    std::stringstream ss(keyString);
    std::string part;
    while (std::getline(ss, part, '+')) {
        // Remove spaces
        part.erase(std::remove_if(part.begin(), part.end(), ::isspace), part.end());
        if (!part.empty()) {
            parts.push_back(part);
        }
    }
    
    if (parts.empty()) return false;

    // Process modifier keys
    for (size_t i = 0; i < parts.size() - 1; ++i) {
        std::string modifier = parts[i];
        std::transform(modifier.begin(), modifier.end(), modifier.begin(), ::toupper);
        
        if (modifier == "SHIFT") modifiers |= MOD_SHIFT;
        else if (modifier == "CONTROL" || modifier == "CTRL") modifiers |= MOD_CONTROL;
        else if (modifier == "ALT") modifiers |= MOD_ALT;
        else if (modifier == "WIN" || modifier == "WINDOWS" || modifier == "CMD") modifiers |= MOD_WIN;
    }

    // Process the main key
    std::string key = parts.back();
    std::transform(key.begin(), key.end(), key.begin(), ::toupper);

    // Check if it's a mouse side button
    if (key == "XBUTTON1" || key == "X1" || key == "MOUSESIDE1") {
        mouseButton = 1;
        return true;
    } else if (key == "XBUTTON2" || key == "X2" || key == "MOUSESIDE2") {
        mouseButton = 2;
        return true;
    }

    // Process single character keys
    if (key.length() == 1) {
        char c = key[0];
        if (c >= 'A' && c <= 'Z') vkCode = c;
        else if (c >= '0' && c <= '9') vkCode = c;
        else {
            // Special symbol keys
            switch (c) {
                case '`': case '~': vkCode = VK_OEM_3; break;  // `~
                case '-': case '_': vkCode = VK_OEM_MINUS; break; // -_
                case '=': case '+': vkCode = VK_OEM_PLUS; break;  // =+
                case '[': case '{': vkCode = VK_OEM_4; break;     // [{
                case ']': case '}': vkCode = VK_OEM_6; break;     // ]}
                case '\\': case '|': vkCode = VK_OEM_5; break;    // \|
                case ';': case ':': vkCode = VK_OEM_1; break;     // ;:
                case '\'': case '"': vkCode = VK_OEM_7; break;    // '"
                case ',': case '<': vkCode = VK_OEM_COMMA; break; // ,<
                case '.': case '>': vkCode = VK_OEM_PERIOD; break;// .>
                case '/': case '?': vkCode = VK_OEM_2; break;     // /?
            }
        }
    }
    // Function keys
    else if (key.rfind("F", 0) == 0 && key.length() > 1) {
        try {
            int fkey = std::stoi(key.substr(1));
            if (fkey >= 1 && fkey <= 24) {
                vkCode = VK_F1 + (fkey - 1);
            }
        } catch (...) {}
    }
    // Special keys
    else {
        if (key == "INSERT") vkCode = VK_INSERT;
        else if (key == "DELETE" || key == "DEL") vkCode = VK_DELETE;
        else if (key == "HOME") vkCode = VK_HOME;
        else if (key == "END") vkCode = VK_END;
        else if (key == "PAGEUP" || key == "PGUP") vkCode = VK_PRIOR;
        else if (key == "PAGEDOWN" || key == "PGDN") vkCode = VK_NEXT;
        else if (key == "UP" || key == "UPARROW") vkCode = VK_UP;
        else if (key == "DOWN" || key == "DOWNARROW") vkCode = VK_DOWN;
        else if (key == "LEFT" || key == "LEFTARROW") vkCode = VK_LEFT;
        else if (key == "RIGHT" || key == "RIGHTARROW") vkCode = VK_RIGHT;
        else if (key == "SPACE" || key == "SPACEBAR") vkCode = VK_SPACE;
        else if (key == "TAB") vkCode = VK_TAB;
        else if (key == "ENTER" || key == "RETURN") vkCode = VK_RETURN;
        else if (key == "ESCAPE" || key == "ESC") vkCode = VK_ESCAPE;
        else if (key == "BACKSPACE" || key == "BACK") vkCode = VK_BACK;
        else if (key == "CAPSLOCK" || key == "CAPS") vkCode = VK_CAPITAL;
        else if (key == "NUMLOCK") vkCode = VK_NUMLOCK;
        else if (key == "SCROLLLOCK") vkCode = VK_SCROLL;
        else if (key == "PRINTSCREEN" || key == "PRTSC") vkCode = VK_SNAPSHOT;
        else if (key == "PAUSE") vkCode = VK_PAUSE;
        else if (key == "APPS" || key == "MENU") vkCode = VK_APPS;
        // Numpad keys
        else if (key == "NUMPAD0") vkCode = VK_NUMPAD0;
        else if (key == "NUMPAD1") vkCode = VK_NUMPAD1;
        else if (key == "NUMPAD2") vkCode = VK_NUMPAD2;
        else if (key == "NUMPAD3") vkCode = VK_NUMPAD3;
        else if (key == "NUMPAD4") vkCode = VK_NUMPAD4;
        else if (key == "NUMPAD5") vkCode = VK_NUMPAD5;
        else if (key == "NUMPAD6") vkCode = VK_NUMPAD6;
        else if (key == "NUMPAD7") vkCode = VK_NUMPAD7;
        else if (key == "NUMPAD8") vkCode = VK_NUMPAD8;
        else if (key == "NUMPAD9") vkCode = VK_NUMPAD9;
        else if (key == "MULTIPLY" || key == "NUMPADMULTIPLY") vkCode = VK_MULTIPLY;
        else if (key == "ADD" || key == "NUMPADADD") vkCode = VK_ADD;
        else if (key == "SUBTRACT" || key == "NUMPADSUBTRACT") vkCode = VK_SUBTRACT;
        else if (key == "DECIMAL" || key == "NUMPADDECIMAL") vkCode = VK_DECIMAL;
        else if (key == "DIVIDE" || key == "NUMPADDIVIDE") vkCode = VK_DIVIDE;
        // Media keys
        else if (key == "VOLUMEUP") vkCode = VK_VOLUME_UP;
        else if (key == "VOLUMEDOWN") vkCode = VK_VOLUME_DOWN;
        else if (key == "VOLUMEMUTE") vkCode = VK_VOLUME_MUTE;
        else if (key == "MEDIANEXT") vkCode = VK_MEDIA_NEXT_TRACK;
        else if (key == "MEDIAPREV") vkCode = VK_MEDIA_PREV_TRACK;
        else if (key == "MEDIAPLAYPAUSE") vkCode = VK_MEDIA_PLAY_PAUSE;
        else if (key == "MEDIASTOP") vkCode = VK_MEDIA_STOP;
    }

    return vkCode != 0 || mouseButton != 0;
}

// Start/register hotkeys
Napi::Value Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    StopHotkeyListener();
    idToActionMap.clear();
    mouseKeyMap.clear();

    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
        Napi::TypeError::New(env, "Shortcut object and callback function required").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Object shortcuts = info[0].As<Napi::Object>();
    Napi::Function callback = info[1].As<Napi::Function>();

    tsfn = Napi::ThreadSafeFunction::New(env, callback, "HotkeyCallback", 0, 1, [](Napi::Env) {});

    struct HotkeyInfo {
        std::string actionName;
        UINT modifiers;
        UINT vkCode;
    };
    std::vector<HotkeyInfo> hotkeysToRegister;
    
    // Parse shortcut configuration
    Napi::Array shortcutNames = shortcuts.GetPropertyNames();
    for (uint32_t i = 0; i < shortcutNames.Length(); i++) {
        Napi::Value key = shortcutNames.Get(i);
        std::string actionName = key.As<Napi::String>().Utf8Value();
        std::string keyString = shortcuts.Get(key).As<Napi::String>().Utf8Value();
        
        UINT vkCode = 0, modifiers = 0, mouseButton = 0;
        if (StringToVk(keyString, vkCode, modifiers, mouseButton)) {
            if (mouseButton != 0) {
                // Mouse side button mapping
                mouseKeyMap[std::make_pair(modifiers, mouseButton)] = actionName;
            } else if (vkCode != 0) {
                // Use THE ULTIMATE KEYBOARD HOOK instead of RegisterHotKey
                keyboardHookMap[std::make_pair(modifiers, vkCode)] = actionName;
                // Keep legacy method as backup
                hotkeysToRegister.push_back({actionName, modifiers, vkCode});
            }
        }
    }

    // FIX: install the low-level hooks inside a dedicated thread that runs a
    // Win32 message pump. WH_KEYBOARD_LL / WH_MOUSE_LL callbacks are only
    // delivered while the owning thread pumps messages; without the pump the
    // hooks are silently dead under fullscreen / borderless games.
    if (!keyboardHookMap.empty() || !mouseKeyMap.empty()) {
        hookMessageLoopRunning = true;
        hookMessageThread = std::thread([]() {
            hookMessageThreadId = GetCurrentThreadId();

            if (!keyboardHookMap.empty()) {
                keyboardHook = SetWindowsHookExW(WH_KEYBOARD_LL, KeyboardHookProc, GetModuleHandle(NULL), 0);
                keyboardHookRunning = (keyboardHook != NULL);
                OutputDebugStringA(keyboardHookRunning
                    ? "[Teyvat Debug] WH_KEYBOARD_LL installed on pump thread"
                    : "[Teyvat Debug] WH_KEYBOARD_LL install FAILED");
            }
            if (!mouseKeyMap.empty()) {
                mouseHook = SetWindowsHookExW(WH_MOUSE_LL, MouseHookProc, GetModuleHandle(NULL), 0);
                mouseHookRunning = (mouseHook != NULL);
                OutputDebugStringA(mouseHookRunning
                    ? "[Teyvat Debug] WH_MOUSE_LL installed on pump thread"
                    : "[Teyvat Debug] WH_MOUSE_LL install FAILED");
            }

            // REQUIRED message pump for low-level hooks
            MSG msg = {0};
            while (hookMessageLoopRunning && GetMessage(&msg, NULL, 0, 0) > 0) {
                TranslateMessage(&msg);
                DispatchMessage(&msg);
            }

            // Cleanup on loop exit
            if (keyboardHook) { UnhookWindowsHookEx(keyboardHook); keyboardHook = NULL; keyboardHookRunning = false; }
            if (mouseHook) { UnhookWindowsHookEx(mouseHook); mouseHook = NULL; mouseHookRunning = false; }
            hookMessageLoopRunning = false;
            hookMessageThreadId = 0;
        });
        hookMessageThread.detach();
    }

    // FIX: always start the RegisterHotKey backup thread. The old condition
    // (!keyboardHookRunning) short-circuited it whenever the LL hook install
    // "succeeded" - even when the hook was dead for lack of a message pump.
    if (!hotkeysToRegister.empty()) {
        isRunning = true;
        hotkeyThread = std::thread([hotkeysToRegister]() {
            hotkeyThreadId = GetCurrentThreadId();
            int nextHotkeyId = 1;
            
            // Register hotkeys
            for (const auto& hotkey : hotkeysToRegister) {
                // RegisterHotKey REQUIRES at least one modifier; bare keys like
                // Insert (modifiers == 0) always fail here - the LL hook covers them.
                if (hotkey.modifiers == 0) {
                    OutputDebugStringA(("[Teyvat Debug] RegisterHotKey skip bare key: " + hotkey.actionName).c_str());
                    continue;
                }
                int id = nextHotkeyId++;
                if (RegisterHotKey(NULL, id, hotkey.modifiers, hotkey.vkCode)) {
                    idToActionMap[id] = hotkey.actionName;
                    OutputDebugStringA(("[Teyvat Debug] RegisterHotKey OK: " + hotkey.actionName).c_str());
                } else {
                    OutputDebugStringA(("[Teyvat Debug] RegisterHotKey FAILED: " + hotkey.actionName).c_str());
                }
            }

            // Message loop
            MSG msg = {0};
            while (GetMessage(&msg, NULL, 0, 0) != 0) {
                if (msg.message == WM_HOTKEY) {
                    int id = static_cast<int>(msg.wParam);
                    auto it = idToActionMap.find(id);
                    if (it != idToActionMap.end()) {
                        std::string action = it->second;
                        if (tsfn) {
                            tsfn.NonBlockingCall([action](Napi::Env env, Napi::Function jsCallback) {
                                jsCallback.Call({Napi::String::New(env, action)});
                            });
                        }
                    }
                }
            }

            // Clean up registered hotkeys
            for (const auto& pair : idToActionMap) {
                UnregisterHotKey(NULL, pair.first);
            }
        });
        hotkeyThread.detach();
    }
    
    return env.Undefined();
}

// Stop hotkey listener
Napi::Value Stop(const Napi::CallbackInfo& info) {
    StopHotkeyListener();
    return info.Env().Undefined();
}

// Module initialization
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("start", Napi::Function::New(env, Start));
    exports.Set("stop", Napi::Function::New(env, Stop));
    return exports;
}

NODE_API_MODULE(high_priority_shortcut, Init)