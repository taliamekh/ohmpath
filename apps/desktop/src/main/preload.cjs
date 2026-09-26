const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ohmpath', Object.freeze({
  request: (action, payload = {}) => ipcRenderer.invoke('ohmpath:request', action, payload),
  onServiceStopped: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('A callback is required.');
    const listener = () => callback();
    ipcRenderer.on('ohmpath:service-stopped', listener);
    return () => ipcRenderer.removeListener('ohmpath:service-stopped', listener);
  },
  onCompanionClosed: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('A callback is required.');
    const listener = () => callback();
    ipcRenderer.on('ohmpath:companion-closed', listener);
    return () => ipcRenderer.removeListener('ohmpath:companion-closed', listener);
  },
}));
