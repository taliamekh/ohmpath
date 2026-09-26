// Standalone TroubleshootPage renderer with delayed, offline IPC replies.
// No bench service, model, device, audio, camera, or network call is made.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { writeFile } = require('node:fs/promises');

const root = resolve(__dirname, '../..');
const esbuild = createRequire(require.resolve('vite'))('esbuild');
const pending = new Map();
const audit = { requests: [], cancels: [], unexpected: [] };
let nextId = 0;
let window;
let delayCancel = false;

function defer(kind, payload) {
  const id = ++nextId;
  audit.requests.push({ id, kind, payload });
  return new Promise(resolve => pending.set(id, { kind, resolve }));
}

function handle(action, payload = {}) {
  if (action === 'assemblyPlan' || action === 'firmwareAnalyze' || action === 'investigateStart' || action === 'investigateWithImage' || action === 'investigateStatus') {
    return defer(action, payload);
  }
  if (action === 'investigateCancel') {
    audit.cancels.push({ sid: payload.sid, turn_id: payload.turn_id });
    if (delayCancel) { delayCancel = false; return defer(action, payload); }
    return { status: 'cancelled', turn_id: payload.turn_id, message: 'Replay cancellation accepted.' };
  }
  if (action === 'testAudit') return { ...audit, pending: Array.from(pending, ([id, item]) => ({ id, kind: item.kind })) };
  if (action === 'testDelayNextCancel') { delayCancel = true; return { armed: true }; }
  if (action === 'testResolve') {
    const entry = pending.get(payload.id);
    if (!entry || entry.kind !== payload.kind) throw new Error('Unknown delayed replay request.');
    pending.delete(payload.id);
    entry.resolve(payload.result);
    return { resolved: payload.id };
  }
  audit.unexpected.push(action);
  throw new Error(`Unexpected troubleshoot replay action: ${action}`);
}

app.disableHardwareAcceleration();
if (process.env.OHMPATH_REPLAY_DATA_DIR) app.setPath('userData', process.env.OHMPATH_REPLAY_DATA_DIR);
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }));
  ipcMain.handle('ohmpath:request', (_event, action, payload) => handle(action, payload));

  const source = resolve(root, 'apps/desktop/src/renderer/TroubleshootPage.tsx').replaceAll('\\', '/');
  const entry = `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import TroubleshootPage from ${JSON.stringify(source)};
    function Harness() {
      const [revision, setRevision] = useState('rev-a');
      const [epoch, setEpoch] = useState('epoch-a');
      const [shown, setShown] = useState(true);
      return <>
        <nav aria-label="Replay controls">
          <button onClick={() => setRevision(value => value === 'rev-a' ? 'rev-b' : 'rev-a')}>Change circuit revision</button>
          <button onClick={() => setEpoch(value => value === 'epoch-a' ? 'epoch-b' : 'epoch-a')}>Change context epoch</button>
          <button onClick={() => setShown(value => !value)}>{shown ? 'Leave troubleshooting' : 'Return to troubleshooting'}</button>
          <output aria-label="Current context">{revision} / {epoch}</output>
        </nav>
        {shown && <TroubleshootPage sessionId="replay-session" circuitRevision={revision} contextEpoch={epoch} onStopSpeaking={() => undefined} />}
      </>;
    }
    createRoot(document.getElementById('root')).render(<Harness />);
  `;
  const bundle = await esbuild.build({ stdin: { contents: entry, resolveDir: root, sourcefile: 'troubleshoot-replay.tsx', loader: 'tsx' },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', target: 'chrome120' });
  const htmlPath = resolve(app.getPath('userData'), 'troubleshoot-replay.html');
  await writeFile(htmlPath, `<!doctype html><html><head><meta charset="utf-8"><title>Offline troubleshoot replay</title></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`);
  window = new BrowserWindow({ width: 1280, height: 900, show: false, backgroundColor: '#111a20',
    webPreferences: { preload: resolve(root, 'apps/desktop/src/main/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('closed', () => app.quit());
  await window.loadFile(htmlPath);
}).catch(error => { console.error('Offline troubleshoot replay failed:', error); app.quit(); });

app.on('window-all-closed', () => app.quit());
