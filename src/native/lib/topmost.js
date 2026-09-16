const path = require('path');

let native = null;

function loadNativeModule(moduleName) {
  const unpackedPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'native', 'build', 'Release', moduleName);
  const localPath = path.join(__dirname, '..', 'build', 'Release', moduleName);

  try {
    if (process.resourcesPath && require('fs').existsSync(unpackedPath)) {
      return require(unpackedPath);
    }
    return require(localPath);
  } catch (err) {
    console.error(`Failed to load ${moduleName}:`, err);
    return null;
  }
}

native = loadNativeModule('high_priority_topmost.node');

if (!native) {
  native = {
    startWindowMonitoring: () => { console.warn('C++ topmost module not available, window monitoring disabled'); return false; },
    stopWindowMonitoring: () => { console.warn('C++ topmost module not available'); return false; },
    setWindowTopmost: () => { console.warn('C++ topmost module not available'); return false; },
    getVisibleWindows: () => { console.warn('C++ topmost module not available'); return []; },
    forceForegroundAndTopmost: () => { console.warn('C++ topmost module not available'); return false; }
  };
}

// Wrapper API: HWND-based (Buffer from Electron's getNativeWindowHandle())
const api = {
  /**
   * Start keeping a window (by direct HWND) at the top of the Z-order.
   * Also performs one immediate force-foreground+topmost.
   * @param {Buffer|BigInt|Number} hwndHandle - native window handle
   * @returns {boolean}
   */
  startMonitoring: function(hwndHandle) {
    if (!native || !native.startWindowMonitoring) {
      throw new Error('C++ topmost module not available');
    }
    try {
      return native.startWindowMonitoring(hwndHandle);
    } catch (err) {
      console.error('Failed to start window monitoring:', err);
      return false;
    }
  },

  /**
   * Stop the monitoring thread.
   * @returns {boolean}
   */
  stopMonitoring: function() {
    if (!native || !native.stopWindowMonitoring) {
      console.warn('C++ topmost module not available');
      return false;
    }
    try {
      return native.stopWindowMonitoring();
    } catch (err) {
      console.error('Failed to stop window monitoring:', err);
      return false;
    }
  },

  /**
   * Set / clear topmost for a window by direct HWND.
   * @param {Buffer|BigInt|Number} hwndHandle
   * @param {boolean} topmost
   * @returns {boolean}
   */
  setTopmost: function(hwndHandle, topmost = true) {
    if (!native || !native.setWindowTopmost) {
      console.warn('C++ topmost module not available');
      return false;
    }
    try {
      return native.setWindowTopmost(hwndHandle, topmost);
    } catch (err) {
      console.error('Failed to set window topmost:', err);
      return false;
    }
  },

  /**
   * Burst summon: force the window to the foreground and topmost,
   * breaking the fullscreen game's foreground lock.
   * @param {Buffer|BigInt|Number} hwndHandle
   * @returns {boolean}
   */
  forceForegroundAndTopmost: function(hwndHandle) {
    if (!native || !native.forceForegroundAndTopmost) {
      console.warn('C++ topmost module not available');
      return false;
    }
    try {
      return native.forceForegroundAndTopmost(hwndHandle);
    } catch (err) {
      console.error('Failed to force foreground and topmost:', err);
      return false;
    }
  },

  /**
   * Get list of all visible windows (debugging).
   * @returns {Array}
   */

  /**
   * Dual-mode switch: attach/detach WS_EX_NOACTIVATE.
   *   - pinned=true  -> HUD mode: topmost-pinned but never steals focus.
   *   - pinned=false -> interactive mode: window can be activated again.
   * @param {Buffer|BigInt|Number} hwndHandle
   * @param {boolean} pinned
   * @returns {boolean}
   */
  setPinnedMode: function(hwndHandle, pinned) {
    if (!native || !native.setWindowPinnedMode) {
      console.warn('C++ setWindowPinnedMode not available');
      return false;
    }
    try {
      return native.setWindowPinnedMode(hwndHandle, pinned);
    } catch (err) {
      console.error('Failed to set pinned mode:', err);
      return false;
    }
  },

  getVisibleWindows: function() {
    if (!native || !native.getVisibleWindows) {
      console.warn('C++ topmost module not available');
      return [];
    }
    try {
      return native.getVisibleWindows();
    } catch (err) {
      console.error('Failed to get visible windows:', err);
      return [];
    }
  },

  /**
   * Check if the native module is available.
   * @returns {boolean}
   */
  isAvailable: function() {
    return native &&
      native.startWindowMonitoring &&
      native.stopWindowMonitoring &&
      native.setWindowTopmost &&
      native.forceForegroundAndTopmost &&
      native.getVisibleWindows;
  }
};

module.exports = api;
