const { app } = require('electron');

app.commandLine.appendSwitch('--disable-gpu');
app.commandLine.appendSwitch('--disable-gpu-compositing');
app.commandLine.appendSwitch('--disable-gpu-sandbox');
app.commandLine.appendSwitch('--enable-software-rasterizer');
app.commandLine.appendSwitch('--force-cpu-draw');
app.commandLine.appendSwitch('--no-sandbox');
app.commandLine.appendSwitch('--disable-setuid-sandbox');

app.disableHardwareAcceleration();

const { BrowserWindow, ipcMain, Menu, globalShortcut, screen, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');

// 尝试加载C++模块
let highPriorityShortcut = null;
let highPriorityTopmost = null;
try {
  highPriorityShortcut = require('../native/lib/binding.js');
  console.log('Successfully loaded high-priority shortcut module');
} catch (err) {
  console.log('Failed to load high-priority shortcut module:', err);
  highPriorityShortcut = {
    installHook: () => { console.warn('C++ shortcuts not available, using fallback'); },
    registerShortcuts: () => { console.warn('C++ shortcuts not available'); },
    uninstallHook: () => { console.warn('C++ shortcuts not available'); }
  };
}

try {
  highPriorityTopmost = require('../native/lib/topmost.js');
  console.log('Successfully loaded high-priority topmost module');
} catch (err) {
  console.log('Failed to load high-priority topmost module:', err);
  highPriorityTopmost = {
    startMonitoring: () => { console.warn('C++ topmost not available'); return false; },
    stopMonitoring: () => { console.warn('C++ topmost not available'); return false; },
    setTopmost: () => { console.warn('C++ topmost not available'); return false; },
    isAvailable: () => false
  };
}

// 防抖工具函数
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// 默认快捷键（唯一来源：主进程 store 默认值与 C++ 注册共用，避免多处硬编码）
const DEFAULT_SHORTCUTS = {
  toggleBrowser: 'Insert',
  playPause: 'F1',
  rewind: 'F2',
  forward: 'F3',
  increaseOpacity: 'Control+Up',
  decreaseOpacity: 'Control+Down',
  toggleMouseLock: 'Control+Shift+L'
};

// 配置存储
const store = new Store({
  defaults: {
    mainWindowBounds: { width: 800, height: 600 },
    browserWindowBounds: { width: 400, height: 720, x: 50, y: 50 },
    lastUrl: 'https://www.bilibili.com',
    shortcuts: { ...DEFAULT_SHORTCUTS },
    browserOpacity: 0.8,
    enableGpuAcceleration: false,
    bookmarks: [],
    zoomLevel: 1.0
  }
});



// 主窗口和播放器窗口
let mainWindow = null;
let browserWindow = null;

// 浏览器窗口「鼠标锁定」状态。
//   false = 浏览器正常接收鼠标输入
//   true  = 浏览器完全忽略鼠标输入，鼠标事件穿透到下层窗口/游戏（全局快捷键不受影响）
// 注意：与 Pinned/HUD 模式是两个独立概念。
//   Pinned Mode  = WS_EX_NOACTIVATE，控制「激活/焦点」行为（native）
//   Mouse Lock   = setIgnoreMouseEvents，控制「鼠标输入是否穿透」（Electron）
// 两者互不依赖，四种组合（HUD±, Lock±）都必须成立。
// 该状态刻意不写入 store：启动时始终为 false，但浏览器窗口重建时沿用内存中的当前值。
let browserMouseLocked = false;

// 快捷键处理函数
function handleShortcut(action) {
  console.log('Shortcut triggered:', action);

  // 通知渲染进程高亮对应的快捷键提示（主窗口 UI 反馈）
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('shortcut-triggered', action);
  }

  switch (action) {
    case 'toggleBrowser':
      toggleBrowserVisibility();
      break;
    case 'playPause':
    case 'rewind':
    case 'forward':
      executeMediaAction(action);
      break;
    case 'increaseOpacity':
      adjustBrowserOpacity(0.1);
      break;
    case 'decreaseOpacity':
      adjustBrowserOpacity(-0.1);
      break;
    case 'toggleMouseLock':
      toggleBrowserMouseLock();
      break;
    default:
      console.log('Unknown shortcut action:', action);
  }
}

// ===== 鼠标锁定 (Mouse Lock) =====
// 唯一的窗口级落地函数：只调 setIgnoreMouseEvents，不碰窗口样式/置顶/位置/大小。
function applyBrowserMouseLockToWindow() {
  if (!browserWindow || browserWindow.isDestroyed()) {
    return false;
  }
  try {
    browserWindow.setIgnoreMouseEvents(browserMouseLocked);
    return true;
  } catch (err) {
    console.error('[Teyvat Debug] failed to set browser mouse lock:', err);
    return false;
  }
}

// 统一状态入口：所有锁定状态变化（快捷键 / IPC / 未来其它来源）都必须走这里，
// 禁止在多个 IPC、快捷键分支里散调 setIgnoreMouseEvents。
function setBrowserMouseLock(locked) {
  const next = !!locked;
  const changed = browserMouseLocked !== next;
  browserMouseLocked = next;

  if (changed) {
    console.log(next ? '[Teyvat Debug] browser mouse lock enabled' : '[Teyvat Debug] browser mouse lock disabled');
  }

  const applied = applyBrowserMouseLockToWindow();

  if (changed) {
    // 锁定时若浏览器正持有焦点，主动让出焦点（复用现有的 blur 机制），
    // 避免锁定后键盘输入仍被攻略窗口吃掉。不改变置顶状态、不调 forceForegroundAndTopmost。
    if (next && browserWindow && !browserWindow.isDestroyed()) {
      try {
        if (browserWindow.isFocused()) {
          browserWindow.blur();
        }
      } catch (err) {
        console.error('[Teyvat Debug] failed to release browser focus:', err);
      }
    }

    // 同步主窗口 UI 状态
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mouse-lock-changed', browserMouseLocked);
    }
  }

  return applied;
}

function toggleBrowserMouseLock() {
  return setBrowserMouseLock(!browserMouseLocked);
}

// 合并默认快捷键：老版本 store 里没有 toggleMouseLock，补齐后 C++ 模块才能注册它
function getShortcutsWithDefaults() {
  const stored = store.get('shortcuts') || {};
  const merged = { ...DEFAULT_SHORTCUTS, ...stored };
  const missing = Object.keys(DEFAULT_SHORTCUTS).filter(key => !(key in stored));
  if (missing.length > 0) {
    store.set('shortcuts', merged);
    console.log('[Teyvat Debug] shortcuts config migrated, added defaults:', missing.join(', '));
  }
  return merged;
}

// 执行媒体操作
function executeMediaAction(action) {
  if (!browserWindow) {
    console.log('Browser window not available for media action:', action);
    return;
  }

  // 检查浏览器窗口是否有效
  if (browserWindow.isDestroyed()) {
    console.log('Browser window is destroyed');
    return;
  }

  // 确保浏览器窗口可见并获得焦点
  try {
    if (!browserWindow.isVisible()) {
      browserWindow.show();
    }
    if (browserWindow.isMinimized()) {
      browserWindow.restore();
    }
  } catch (err) {
    console.error('Failed to manage browser window:', err);
    return;
  }

  // 向浏览器窗口发送媒体控制指令
  switch (action) {
    case 'playPause':
      executeMediaScript(`
        (function() {
          try {
            // 尝试查找B站播放器的播放/暂停按钮
            const bilibiliPlayBtn = document.querySelector('.bpx-player-ctrl-play, .bilibili-player-video-btn-start');
            if (bilibiliPlayBtn) {
              bilibiliPlayBtn.click();
              return 'B站播放器: 播放/暂停';
            } else {
              // 通用视频元素控制
              const videos = document.querySelectorAll('video');
              if (videos.length > 0) {
                const video = videos[0];
                if (video.paused) {
                  video.play();
                  return '通用视频: 播放';
                } else {
                  video.pause();
                  return '通用视频: 暂停';
                }
              } else {
                return '未找到可控制的媒体元素';
              }
            }
          } catch (e) {
            return 'Error: ' + e.message;
          }
        })();
      `, action);
      break;

    case 'rewind':
      executeMediaScript(`
        (function() {
          try {
            const videos = document.querySelectorAll('video');
            if (videos.length > 0) {
              const video = videos[0];
              video.currentTime = Math.max(0, video.currentTime - 5);
              return '视频后退5秒';
            } else {
              return '未找到视频元素';
            }
          } catch (e) {
            return 'Error: ' + e.message;
          }
        })();
      `, action);
      break;

    case 'forward':
      executeMediaScript(`
        (function() {
          try {
            const videos = document.querySelectorAll('video');
            if (videos.length > 0) {
              const video = videos[0];
              video.currentTime = Math.min(video.duration || video.currentTime + 5, video.currentTime + 5);
              return '视频快进5秒';
            } else {
              return '未找到视频元素';
            }
          } catch (e) {
            return 'Error: ' + e.message;
          }
        })();
      `, action);
      break;

    default:
      console.log('Unknown media action:', action);
  }
}

// 安全执行媒体脚本的辅助函数
function executeMediaScript(script, action) {
  if (!browserWindow || browserWindow.isDestroyed()) {
    console.log('Browser window unavailable for', action);
    return;
  }

  browserWindow.webContents.executeJavaScript(script)
    .then(result => {
      console.log('Media action result:', result);
    })
    .catch(err => {
      console.error(`媒体控制失败 (${action}):`, err.message);
      // 尝试重新获得窗口焦点
      try {
        if (browserWindow && !browserWindow.isDestroyed()) {
          browserWindow.focus();
        }
      } catch (focusErr) {
        console.error('Failed to focus browser window:', focusErr.message);
      }
    });
}

// 初始化C++快捷键模块
function initializeHighPriorityShortcuts() {
  if (!highPriorityShortcut) {
    console.log('Using fallback Electron shortcuts');
    return false;
  }
  
  try {
    // 安装钩子
    highPriorityShortcut.installHook((action) => {
      handleShortcut(action);
    });
    
    // 注册快捷键（含新增的 toggleMouseLock，缺项自动补齐）
    const shortcuts = getShortcutsWithDefaults();
    highPriorityShortcut.registerShortcuts(shortcuts);
    
    console.log('High-priority shortcuts initialized successfully');
    return true;
  } catch (err) {
    console.error('Failed to initialize high-priority shortcuts:', err);
    return false;
  }
}

// 更新快捷键
function updateShortcuts(newShortcuts) {
  // 与默认值合并，避免渲染进程传来的对象缺项时丢掉已有快捷键
  const merged = { ...DEFAULT_SHORTCUTS, ...(newShortcuts || {}) };
  store.set('shortcuts', merged);

  if (highPriorityShortcut) {
    try {
      highPriorityShortcut.registerShortcuts(merged);
      console.log('Shortcuts updated successfully');
    } catch (err) {
      console.error('Failed to update shortcuts:', err);
    }
  }
}

function createMainWindow() {
  const { width, height } = store.get('mainWindowBounds');

  mainWindow = new BrowserWindow({
    width,
    height,
    title: '提瓦特浏览器 - 控制台',
    icon: path.join(__dirname, '../renderer/assets/logo.png'), // 设置窗口图标
    alwaysOnTop: false, // 确保主窗口不置顶
    skipTaskbar: false, // 确保在任务栏显示
    show: true, // 确保窗口显示
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.removeMenu(); // 彻底移除菜单栏，包括Electron默认的菜单

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('Failed to load main window:', {
      errorCode,
      errorDescription,
      validatedURL
    });
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('Render process crashed:', details);
  });

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[Renderer Console] ${message} (${sourceId}:${line})`);
  });

  mainWindow.on('resize', () => {
    const { width, height } = mainWindow.getBounds();
    store.set('mainWindowBounds', { width, height });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // 主窗口关闭时，也关闭播放器窗口
    if (browserWindow) {
      browserWindow.close();
    }
  });
  
  // 确保主窗口在任务栏正常显示且不被置顶
  mainWindow.once('ready-to-show', () => {
    mainWindow.setSkipTaskbar(false);
    mainWindow.setAlwaysOnTop(false);
    console.log('Main window configured: taskbar=true, topmost=false');
  });
}

// 创建播放器窗口
function createBrowserWindow(url) {
  if (browserWindow) {
    browserWindow.focus();
    return;
  }
  
  let { width, height, x, y } = store.get('browserWindowBounds');

  // 验证窗口大小，避免为0
  if (!width || !height) {
    const defaultBounds = store.get('defaults.browserWindowBounds');
    width = defaultBounds.width;
    height = defaultBounds.height;
  }
  
  // 检查窗口是否在屏幕内
  const displays = screen.getAllDisplays();
  const aDisplay = displays.find(d => {
    return x >= d.bounds.x && y >= d.bounds.y &&
           x + width <= d.bounds.x + d.bounds.width &&
           y + height <= d.bounds.y + d.bounds.height;
  });

  if (!aDisplay) {
    // 如果窗口不在任何一个屏幕内，重置到主屏幕的中央
    const primaryDisplay = screen.getPrimaryDisplay();
    x = primaryDisplay.bounds.x + (primaryDisplay.bounds.width - width) / 2;
    y = primaryDisplay.bounds.y + (primaryDisplay.bounds.height - height) / 2;
  }
  
  browserWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    title: '提瓦特浏览器',
    frame: true, // 改回带边框的窗口以确保稳定性
    transparent: false, // 禁用透明
    autoHideMenuBar: true, // 隐藏菜单栏 (文件, 视图等)
    fullscreenable: false, // 禁止窗口进入OS全屏，以优化网页内视频的全屏体验
    icon: path.join(__dirname, '../renderer/assets/logo.png'), // 设置窗口图标
    alwaysOnTop: false, // 初始不置顶，由高级置顶模块控制
    skipTaskbar: false, // 在任务栏显示浏览器窗口
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  // 建窗后立刻套用当前鼠标锁定状态：
  // 锁定状态下关闭浏览器再呼出时，新窗口必须直接进入穿透状态（不闪一次可交互）。
  console.log('[Teyvat Debug] applying browser mouse lock state:', browserMouseLocked);
  applyBrowserMouseLockToWindow();

  browserWindow.once('ready-to-show', () => {
    browserWindow.show();
    
    console.log('Browser window ready, setting topmost');
    
    // 设置浏览器窗口置顶
    setBrowserWindowTopmost();
    
    // 确保主窗口不置顶
    if (mainWindow) {
      mainWindow.setAlwaysOnTop(false);
      console.log('Main window topmost disabled');
    }
    
    // 启用高级置顶功能（如果可用，延迟启动）
    // Start the advanced topmost monitor (HWND-direct, shorter delay)
    if (highPriorityTopmost && highPriorityTopmost.isAvailable()) {
      setTimeout(() => {
        console.log("[Teyvat Debug] starting browser window monitoring");
        try {
          const result = startBrowserWindowMonitoring();
          console.log("[Teyvat Debug] startBrowserWindowMonitoring ->", result);
        } catch (err) {
          console.error("[Teyvat Debug] startBrowserWindowMonitoring error:", err);
        }
      }, 1000);
    }
  });
  
  const urlToLoad = url || store.get('lastUrl');
  browserWindow.loadURL(urlToLoad);
  store.set('lastUrl', urlToLoad);
  
  // 设置初始透明度
  browserWindow.setOpacity(store.get('browserOpacity'));
  
  // 设置初始缩放级别
  const zoomLevel = store.get('zoomLevel', 1.0);
  browserWindow.webContents.setZoomLevel(zoomLevel - 1);

  // 根据焦点状态智能调整透明度
  browserWindow.on('focus', () => {
    browserWindow.setOpacity(1.0);
  });
  browserWindow.on('blur', () => {
    browserWindow.setOpacity(store.get('browserOpacity'));
  });

  // 使用防抖保存窗口位置和大小
  const debouncedSaveBounds = debounce(() => {
    const bounds = browserWindow.getBounds();
    store.set('browserWindowBounds', bounds);
  }, 500);

  browserWindow.on('resize', debouncedSaveBounds);
  browserWindow.on('move', debouncedSaveBounds);

  browserWindow.on('closed', () => {
    // 刻意不重置 browserMouseLocked：
    // 用户可能在游戏中关闭攻略窗口，再次呼出时仍希望保持锁定状态。
    // 新窗口创建时会按当前值重新套用 setIgnoreMouseEvents。
    // 停止topmost监控
    if (highPriorityTopmost && highPriorityTopmost.isAvailable()) {
      try {
        highPriorityTopmost.stopMonitoring();
        console.log('Stopped topmost monitoring for browser window');
      } catch (err) {
        console.error('Error stopping topmost monitoring:', err);
      }
    }
    
    browserWindow = null;
    if (mainWindow) {
      mainWindow.webContents.send('browser-window-closed');
    }
  });
  
  if (mainWindow) {
    mainWindow.webContents.send('browser-window-created');
  }
  

}

// FIX: summon = burst. Fullscreen games re-activate / re-topmost themselves
// every frame, so a single topmost call gets pushed back. Fire
// forceForegroundAndTopmost at 0/50/150ms plus a focus retry at 200ms to win
// the Z-order / foreground race. The window handle is now passed directly as
// the native HWND (getNativeWindowHandle) - the brittle title-string lookup
// is gone.
function summonBrowserWindow() {
  if (!browserWindow || browserWindow.isDestroyed()) {
    console.log("[Teyvat Debug] summonBrowserWindow: window gone, recreating");
    createBrowserWindow();
    return;
  }

  console.log("[Teyvat Debug] summonBrowserWindow: burst start");

  if (browserWindow.isMinimized()) {
    browserWindow.restore();
  }
  browserWindow.show();
  browserWindow.setAlwaysOnTop(true, "screen-saver");

  // Grab the native HWND (Buffer) and pass it straight to the C++ module
  let hwndBuffer = null;
  try {
    hwndBuffer = browserWindow.getNativeWindowHandle();
  } catch (err) {
    console.error("[Teyvat Debug] summonBrowserWindow: getNativeWindowHandle error:", err);
  }

  const burstGrab = () => {
    if (!hwndBuffer || !highPriorityTopmost || !highPriorityTopmost.isAvailable()) {
      return;
    }
    try {
      highPriorityTopmost.forceForegroundAndTopmost(hwndBuffer);
    } catch (err) {
      console.error("[Teyvat Debug] summonBrowserWindow: forceForegroundAndTopmost error:", err);
    }
  };

  // Burst grabs at 0 / 50 / 150 ms + a final focus retry at 200 ms
  burstGrab();
  setTimeout(burstGrab, 50);
  setTimeout(burstGrab, 150);
  setTimeout(() => {
    try {
      browserWindow.focus();
    } catch (err) {
      console.error("[Teyvat Debug] summonBrowserWindow: focus error:", err);
    }
    console.log("[Teyvat Debug] summonBrowserWindow: burst done");
  }, 200);

  if (mainWindow) {
    mainWindow.webContents.send("browser-window-created");
  }
  console.log("[Teyvat Debug] summonBrowserWindow: shown, burst scheduled");
}
function toggleBrowserVisibility() {
  console.log('[Teyvat Debug] toggleBrowserVisibility triggered');

  if (!browserWindow || browserWindow.isDestroyed()) {
    console.log('[Teyvat Debug] no browser window, creating...');
    createBrowserWindow();
    return;
  }

  if (browserWindow.isVisible() && !browserWindow.isMinimized()) {
    if (browserWindow.isFocused()) {
      // 已在前台 → 隐藏
      browserWindow.hide();
      console.log('[Teyvat Debug] window hidden');
      if (mainWindow) {
        mainWindow.webContents.send('browser-window-closed');
      }
    } else {
      // 可见但无焦点（被全屏游戏遮挡）→ 强制呼出到最前
      console.log('[Teyvat Debug] visible but not focused (game overlay) - forcing to front');
      summonBrowserWindow();
    }
  } else {
    // 不可见或已最小化 → 呼出并抢前台
    summonBrowserWindow();
  }
}

// 快捷键功能：最小化/恢复/显示窗口
function handleToggleShortcut() {
  if (!browserWindow) {
    return; // 如果窗口不存在，则不执行任何操作
  }

  if (browserWindow.isMinimized()) {
    browserWindow.restore();
  } else if (!browserWindow.isVisible()) {
    browserWindow.show();
  } else {
    browserWindow.minimize();
  }
  
  // 确保窗口在操作后获得焦点
  if (browserWindow.isVisible() && !browserWindow.isMinimized()) {
    browserWindow.focus();
  }
}
const debouncedToggleShortcut = debounce(handleToggleShortcut, 150);

function adjustBrowserOpacity(delta) {
  if (!browserWindow) return;
  
  let opacity = browserWindow.getOpacity();
  opacity = Math.max(0.2, Math.min(1.0, parseFloat((opacity + delta).toFixed(1))));
  store.set('browserOpacity', opacity);
  browserWindow.setOpacity(opacity);
  
  if (mainWindow) {
    mainWindow.webContents.send('browser-opacity-changed', opacity);
  }
}

// Start the advanced topmost monitor using the DIRECT native HWND.
// A monitor thread keeps the window at the top of the Z-order (precise
// GW_HWNDPREV check, 200ms, no activation) so it stays above the game.
function startBrowserWindowMonitoring() {
  if (!browserWindow || !highPriorityTopmost || !highPriorityTopmost.isAvailable()) {
    console.log("[Teyvat Debug] startBrowserWindowMonitoring: unavailable");
    return false;
  }

  try {
    const hwndBuffer = browserWindow.getNativeWindowHandle();
    const ok = highPriorityTopmost.startMonitoring(hwndBuffer);
    console.log("[Teyvat Debug] startMonitoring(hwnd) ->", ok);

    // Fallback: keep basic topmost if the native monitor is unavailable
    if (!ok) {
      browserWindow.setAlwaysOnTop(true, "screen-saver");
    }
    return ok;
  } catch (err) {
    console.error("[Teyvat Debug] startBrowserWindowMonitoring error:", err);
    browserWindow.setAlwaysOnTop(true, "screen-saver");
    return false;
  }
}

// 简单设置浏览器窗口置顶
function setBrowserWindowTopmost() {
  if (!browserWindow || browserWindow.isDestroyed()) {
    console.log('Browser window not available');
    return false;
  }
  
  console.log('Setting browser window topmost');
  browserWindow.setAlwaysOnTop(true);
  console.log('Browser window topmost status:', browserWindow.isAlwaysOnTop());
  
  return browserWindow.isAlwaysOnTop();
}

// 简化的置顶功能控制（仅针对浏览器窗口）
function toggleAdvancedTopmost(enable = null) {
  if (!browserWindow) {
    console.log('No browser window to apply topmost');
    return false;
  }
  
  const currentTopmost = store.get('advancedTopmost', true);
  const newTopmost = enable !== null ? enable : !currentTopmost;
  
  store.set('advancedTopmost', newTopmost);
  
  if (newTopmost) {
    // 设置基本置顶
    setBrowserWindowTopmost();
    
    // 尝试高级置顶（如果可用）
    if (highPriorityTopmost && highPriorityTopmost.isAvailable()) {
      try {
        const result = startBrowserWindowMonitoring();
        console.log('Advanced topmost result:', result);
      } catch (err) {
        console.error('Error with advanced topmost:', err);
      }
    }
    return true;
  } else {
    // 禁用置顶
    if (highPriorityTopmost && highPriorityTopmost.isAvailable()) {
      highPriorityTopmost.stopMonitoring();
    }
    browserWindow.setAlwaysOnTop(false);
    console.log('Topmost disabled for browser window');
    return true;
  }
}





ipcMain.on('update-shortcuts', (_, newShortcuts) => {
  updateShortcuts(newShortcuts);
});

ipcMain.on('toggle-browser', toggleBrowserVisibility);

// 鼠标锁定：渲染进程只发起「切换」请求，窗口操作统一在主进程里做
// （renderer 不允许直接控制 BrowserWindow）
ipcMain.on('toggle-mouse-lock', () => {
  toggleBrowserMouseLock();
});

// 渲染进程初始化时同步一次当前锁定状态
ipcMain.on('get-mouse-lock-status', (event) => {
  event.reply('mouse-lock-changed', browserMouseLocked);
});

// 双模式切换: 贴片/HUD 与交互/强焦点
ipcMain.on('toggle-pinned-mode', (event, isPinned) => {
  if (!browserWindow || browserWindow.isDestroyed()) {
    console.log('[Teyvat Debug] toggle-pinned-mode: no browser window');
    return;
  }
  const hwndBuffer = browserWindow.getNativeWindowHandle();
  let ok = false;
  if (highPriorityTopmost && highPriorityTopmost.isAvailable()) {
    try {
      ok = highPriorityTopmost.setPinnedMode(hwndBuffer, isPinned);
      console.log('[Teyvat Debug] setPinnedMode ->', ok, 'pinned =', isPinned);
    } catch (err) {
      console.error('[Teyvat Debug] setPinnedMode error:', err);
    }
  }
  if (isPinned) {
    // 贴片模式: 退还焦点给游戏
    browserWindow.blur();
    console.log('[Teyvat Debug] pinned ON, focus back to game');
  } else {
    // 交互模式: 强夺前台并聚焦
    try {
      highPriorityTopmost.forceForegroundAndTopmost(hwndBuffer);
      browserWindow.focus();
    } catch (err) {
      console.error('[Teyvat Debug] re-activate error:', err);
    }
    console.log('[Teyvat Debug] pinned OFF, interactive restored');
  }
  // 通知渲染进程同步按钮状态
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pinned-mode-changed', isPinned);
  }
});


ipcMain.on('navigate-browser', (event, url) => {
  if (browserWindow) {
    browserWindow.loadURL(url);
    store.set('lastUrl', url);
    // 确保窗口可见
    if (!browserWindow.isVisible()) browserWindow.show();
    if (browserWindow.isMinimized()) browserWindow.restore();
    browserWindow.focus();
  } else {
    // 如果窗口不存在，则创建并加载URL
    createBrowserWindow(url);
  }
});

ipcMain.on('adjust-opacity', (_, newOpacity) => {
  if (browserWindow) {
    store.set('browserOpacity', newOpacity);
    browserWindow.setOpacity(newOpacity);
  }
});

ipcMain.on('get-initial-settings', (event) => {
  event.reply('initial-settings', {
    shortcuts: getShortcutsWithDefaults(),
    opacity: store.get('browserOpacity'),
    enableGpu: store.get('enableGpuAcceleration'),
    mouseLocked: browserMouseLocked
  });
});

ipcMain.on('open-external-link', (event, url) => {
  shell.openExternal(url);
});

ipcMain.on('set-gpu-acceleration', (event, enabled) => {
  store.set('enableGpuAcceleration', enabled);
});

ipcMain.on('toggle-advanced-topmost', (event, enabled) => {
  const success = toggleAdvancedTopmost(enabled);
  event.reply('advanced-topmost-result', {
    success,
    enabled: store.get('advancedTopmost', true),
    hasModule: highPriorityTopmost && highPriorityTopmost.isAvailable()
  });
});

ipcMain.on('get-topmost-status', (event) => {
  event.reply('topmost-status', {
    enabled: store.get('advancedTopmost', true),
    hasModule: highPriorityTopmost && highPriorityTopmost.isAvailable(),
    isWindowTopmost: browserWindow ? browserWindow.isAlwaysOnTop() : false
  });
});

ipcMain.on('add-bookmark', (event, bookmark) => {
  const bookmarks = store.get('bookmarks', []);
  if (!bookmarks.find(b => b.url === bookmark.url)) {
    bookmarks.push({
      id: Date.now(),
      title: bookmark.title || '未命名',
      url: bookmark.url,
      icon: bookmark.icon || '',
      createdAt: new Date().toISOString()
    });
    store.set('bookmarks', bookmarks);
    if (mainWindow) {
      mainWindow.webContents.send('bookmarks-updated', bookmarks);
    }
  }
});

ipcMain.on('remove-bookmark', (event, id) => {
  const bookmarks = store.get('bookmarks', []);
  const filtered = bookmarks.filter(b => b.id !== id);
  store.set('bookmarks', filtered);
  if (mainWindow) {
    mainWindow.webContents.send('bookmarks-updated', filtered);
  }
});

ipcMain.on('get-bookmarks', (event) => {
  event.reply('bookmarks-updated', store.get('bookmarks', []));
});

ipcMain.on('navigate-to-bookmark', (event, url) => {
  if (browserWindow) {
    browserWindow.loadURL(url);
    store.set('lastUrl', url);
    browserWindow.show();
  } else {
    createBrowserWindow(url);
  }
});

ipcMain.on('adjust-zoom', (event, delta) => {
  let zoomLevel = store.get('zoomLevel', 1.0);
  zoomLevel = Math.max(0.5, Math.min(2.0, zoomLevel + delta));
  store.set('zoomLevel', zoomLevel);
  
  if (browserWindow) {
    browserWindow.webContents.setZoomLevel(zoomLevel - 1);
  }
  
  if (mainWindow) {
    mainWindow.webContents.send('zoom-level-changed', zoomLevel);
  }
});

ipcMain.on('get-zoom-level', (event) => {
  event.reply('zoom-level-changed', store.get('zoomLevel', 1.0));
});

app.whenReady().then(() => {
  createMainWindow();
  initializeHighPriorityShortcuts();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  // 清理快捷键资源
  if (highPriorityShortcut) {
    try {
      highPriorityShortcut.uninstallHook();
    } catch (err) {
      console.error('Failed to uninstall shortcut hook:', err);
    }
  }
  
  // 清理topmost监控资源
  if (highPriorityTopmost && highPriorityTopmost.isAvailable()) {
    try {
      highPriorityTopmost.stopMonitoring();
      console.log('Cleaned up topmost monitoring resources');
    } catch (err) {
      console.error('Failed to cleanup topmost resources:', err);
    }
  }
  
  globalShortcut.unregisterAll();
});
