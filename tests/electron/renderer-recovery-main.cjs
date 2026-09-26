// Isolated render-failure replay. Real UI and preload, fake read-only IPC only.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { resolve } = require('node:path');

const root = resolve(__dirname, '../..');
const actions = [];
let window;

app.disableHardwareAcceleration();
if (process.env.OHMPATH_RECOVERY_DATA_DIR) app.setPath('userData', process.env.OHMPATH_RECOVERY_DATA_DIR);
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }));
  ipcMain.handle('ohmpath:request', (_event, action) => {
    if (action === 'testAudit') return { actions: [...actions] };
    actions.push(action);
    if (action === 'health') return { status: 'ready', hardware: 'disabled', reasoning: 'unavailable' };
    if (action === 'sessions') return [];
    if (action === 'voiceStatus') return { provider: 'offline replay', status: 'not_installed', local_only: true, recording: false };
    if (action === 'disableCamera') return { allowed: false };
    throw new Error(`Unexpected recovery replay action: ${action}`);
  });
  window = new BrowserWindow({ width: 1250, height: 830, show: false, backgroundColor: '#f4f0dd',
    webPreferences: { preload: resolve(root, 'apps/desktop/src/main/preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.on('closed', () => app.quit());
  await window.loadURL('about:blank');
}).catch(error => { console.error('Offline recovery fixture could not start:', error.message); app.quit(); });

app.on('window-all-closed', () => app.quit());
