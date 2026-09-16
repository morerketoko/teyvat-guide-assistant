const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  send: (channel, data) => {
    const validChannels = ['toggle-browser', 'toggle-pinned-mode', 'adjust-opacity', 'update-shortcuts', 'navigate-browser', 'get-initial-settings', 'set-gpu-acceleration', 'open-external-link', 'toggle-advanced-topmost', 'get-topmost-status', 'add-bookmark', 'remove-bookmark', 'get-bookmarks', 'navigate-to-bookmark', 'adjust-zoom', 'get-zoom-level'];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  receive: (channel, func) => {
    const validChannels = ['browser-window-created', 'pinned-mode-changed', 'browser-window-closed', 'browser-opacity-changed', 'shortcut-triggered', 'navigate', 'initial-settings', 'advanced-topmost-result', 'topmost-status', 'bookmarks-updated', 'zoom-level-changed'];
    if (validChannels.includes(channel)) {
      ipcRenderer.removeAllListeners(channel);
      ipcRenderer.on(channel, (event, ...args) => func(...args));
    }
  },
  getAppVersion: () => {
    return process.env.npm_package_version || '0.2.0';
  }
}); 