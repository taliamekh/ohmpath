const { contextBridge, ipcRenderer } = require('electron');

// The display-only guide never receives the bench API or a session capability.
contextBridge.exposeInMainWorld('ohmpathCompanion', Object.freeze({
  onState: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('A callback is required.');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('ohmpath:companion-state', listener);
    ipcRenderer.send('ohmpath:companion-ready');
    return () => ipcRenderer.removeListener('ohmpath:companion-state', listener);
  },
  hide: () => ipcRenderer.invoke('ohmpath:companion-hide'),
}));
