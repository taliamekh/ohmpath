const { app, BrowserWindow, ipcMain, session, dialog, screen, nativeImage, safeStorage, clipboard } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { join, resolve } = require('node:path');
const { createInterface } = require('node:readline');
const fs = require('node:fs');
const { PiVideoClient } = require('./pi-video.cjs');
const { prepareReviewedImage } = require('./reviewed-image.cjs');
const { createElevenLabsConnection } = require('./elevenlabs.cjs');
const { createPhotoImages, UUID } = require('./photo-images.cjs');
const { createTurretPreference } = require('./turret-preference.cjs');
const { createPhonePhotoBridge } = require('./phone-photos.cjs');
const QRCode = require('qrcode');
const piVideo = new PiVideoClient();
const photoImages = createPhotoImages(nativeImage);
const { MAX_UPLOAD_BYTES } = require('./photo-upload.cjs');

const root = resolve(__dirname, '../../../..');
const windowIcon = join(root, 'apps', 'desktop', 'src', 'renderer', 'assets', 'journey', 'emblem.png');
if (process.env.OHMPATH_DATA_DIR) app.setPath('userData', join(process.env.OHMPATH_DATA_DIR, 'desktop'));
const ownsProfile = app.requestSingleInstanceLock();
if (!ownsProfile) app.quit();
let child;
let baseUrl;
let mainWindow;
let companionWindow;
let companionState = { activity: 'idle', expression: 'neutral', caption: 'Ready when you are.', reducedMotion: false };
let userToken;
let stopping = false;
let microphoneAllowed = false;
let cameraAllowed = false;
let elevenLabs;
let turretPreference;
let phonePhotos;
let phonePhotoAccepting = false;
let pendingPhonePhoto = null;
let phoneQr = { url: '', data: '' };

function releasePendingPhonePhoto() {
  if (pendingPhonePhoto) photoImages.release(pendingPhonePhoto.image.image_id);
  pendingPhonePhoto = null;
}

async function phonePhotoStatus() {
  const status = phonePhotos.status();
  if (status.active && status.url !== phoneQr.url) {
    const data = await QRCode.toDataURL(status.url, {
      errorCorrectionLevel: 'M', width: 240, margin: 3,
      color: { dark: '#263c2eff', light: '#fffdf4ff' },
    });
    if (phonePhotos.status().url !== status.url) return phonePhotoStatus();
    phoneQr = { url: status.url, data };
  }
  if (!status.active) phoneQr = { url: '', data: '' };
  return { ...status, qr_data_url: phoneQr.data, pending: Boolean(pendingPhonePhoto), interfaces: phonePhotos.interfaces() };
}
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed() && process.env.OHMPATH_HEADLESS !== '1') {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
  }
});

async function startBench() {
  const python = process.env.OHMPATH_PYTHON || join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!fs.existsSync(python)) throw new Error('Run the development setup first; the local Python environment is missing.');
  userToken = randomBytes(32).toString('hex');
  const safeEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'USERPROFILE', 'HOME']) {
    if (process.env[key]) safeEnv[key] = process.env[key];
  }
  safeEnv.OHMPATH_USER_TOKEN = userToken;
  safeEnv.OHMPATH_MODEL_TOKEN = randomBytes(32).toString('hex');
  safeEnv.PYTHONUNBUFFERED = '1';
  child = spawn(python, ['-m', 'ohmpath', '--port', '0', '--parent-stdin', '--data-dir', process.env.OHMPATH_DATA_DIR || join(app.getPath('userData'), 'bench')], {
    cwd: root, env: safeEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let errorTail = '';
  child.stderr.on('data', (chunk) => { errorTail = (errorTail + chunk.toString()).slice(-4000); });
  child.on('exit', () => {
    if (!stopping && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ohmpath:service-stopped');
    if (!stopping) sendCompanionState({ activity: 'error', caption: 'Local bench disconnected. Restart Ohm Path.', reducedMotion: true });
  });
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('Local bench startup timed out. ' + errorTail)), 15000);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try {
        const data = JSON.parse(line);
        if (data.service === 'Ohm Path' && Number.isInteger(data.port) && data.port > 0 && data.port < 65536) {
          baseUrl = `http://127.0.0.1:${data.port}`;
          clearTimeout(timer); resolveReady();
        }
      } catch { /* Non-protocol stdout is not rendered as trusted HTML. */ }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Local bench exited (${code}). ${errorTail}`)); });
  });
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await callBench('/v1/health', 'GET'); return; }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('The local bench did not become healthy.');
}

async function callBench(path, method, body) {
  if (!baseUrl || !child || child.exitCode !== null) throw new Error('The local bench is disconnected. Restart Ohm Path.');
  const response = await fetch(baseUrl + path, { method, headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(path.endsWith('/transcribe') || path.endsWith('/transcribe-question') ? 75000 : path.endsWith('/imports') ? 35000 : 20000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || JSON.stringify(result.detail || result.error));
  return result;
}

function trustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return false;
  const url = event.senderFrame?.url || '';
  const expected = require('node:url').pathToFileURL(join(root, 'dist/desktop/index.html')).href;
  return url.split('#')[0] === expected || (process.env.OHMPATH_DEV === '1' && url.startsWith('http://127.0.0.1:5173/'));
}

function sendCompanionState(state) {
  companionState = state;
  if (companionWindow && !companionWindow.isDestroyed()) companionWindow.webContents.send('ohmpath:companion-state', state);
}

async function openCompanion() {
  if (companionWindow && !companionWindow.isDestroyed()) { if (process.env.OHMPATH_HEADLESS !== '1') companionWindow.showInactive(); return { enabled: true }; }
  const area = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
  companionWindow = new BrowserWindow({ width: 320, height: 570, x: area.x + area.width - 340, y: area.y + area.height - 590,
    frame: false, resizable: false, alwaysOnTop: true, focusable: false, skipTaskbar: true, show: false,
    backgroundColor: '#10242b', title: 'Ohm Path companion',
    webPreferences: { preload: join(__dirname, 'companion-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  companionWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  companionWindow.webContents.on('will-navigate', event => event.preventDefault());
  companionWindow.on('closed', () => {
    companionWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ohmpath:companion-closed');
  });
  await companionWindow.loadFile(join(root, 'dist/desktop/index.html'), { hash: 'companion' });
  if (companionWindow && !companionWindow.isDestroyed() && process.env.OHMPATH_HEADLESS !== '1') companionWindow.showInactive();
  return { enabled: true };
}

ipcMain.on('ohmpath:companion-ready', event => {
  if (companionWindow && event.sender === companionWindow.webContents && event.senderFrame === companionWindow.webContents.mainFrame)
    companionWindow.webContents.send('ohmpath:companion-state', companionState);
});
ipcMain.handle('ohmpath:companion-hide', event => {
  if (!companionWindow || event.sender !== companionWindow.webContents || event.senderFrame !== companionWindow.webContents.mainFrame) throw new Error('Invalid companion message.');
  companionWindow.close();
  return { enabled: false };
});

ipcMain.handle('ohmpath:request', async (event, action, payload) => {
  if (!trustedSender(event) || typeof action !== 'string' || payload === null || typeof payload !== 'object'
      || JSON.stringify(payload).length > (['transcribe', 'photoTranscribe'].includes(action) ? 2100000 : action === 'photoImportCapture' ? 2701000 : 60000)) throw new Error('Invalid application message.');
  if (action === 'turretStatus') return turretPreference.status();
  if (action === 'setTurretEnabled') return turretPreference.set(payload.enabled);
  if (action === 'phonePhotoStatus') return phonePhotoStatus();
  if (action === 'phonePhotoSetAccepting') {
    phonePhotoAccepting = payload.accepting === true;
    return { accepting: phonePhotoAccepting };
  }
  if (action === 'phonePhotoStart') {
    if (!phonePhotoAccepting) throw new Error('Open Photo help with room for another image first.');
    await phonePhotos.start({ address: payload.address });
    return phonePhotoStatus();
  }
  if (action === 'phonePhotoStop') {
    await phonePhotos.stop();
    releasePendingPhonePhoto();
    return phonePhotoStatus();
  }
  if (action === 'phonePhotoTake') {
    if (!phonePhotoAccepting) return { photo: null };
    const photo = pendingPhonePhoto;
    pendingPhonePhoto = null;
    return { photo };
  }
  if (action === 'photoChooseImage') {
    const selected = await dialog.showOpenDialog(mainWindow, { title: 'Choose a circuit photo or diagram', properties: ['openFile'],
      filters: [{ name: 'Circuit photos and diagrams', extensions: ['png', 'jpg', 'jpeg'] }] });
    if (selected.canceled || selected.filePaths.length !== 1) return { cancelled: true };
    const source = selected.filePaths[0];
    const stat = await fs.promises.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_UPLOAD_BYTES) throw new Error('Choose a local PNG or JPEG under 16 MB.');
    const handle = await fs.promises.open(source, 'r');
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_UPLOAD_BYTES) throw new Error('Choose a local PNG or JPEG under 16 MB.');
      const bytes = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > MAX_UPLOAD_BYTES) throw new Error('Choose a local PNG or JPEG under 16 MB.');
      return { image: photoImages.addUpload(bytes.subarray(0, length), require('node:path').basename(source)) };
    } finally { await handle.close(); }
  }
  if (action === 'photoPasteImage') return { image: photoImages.paste(clipboard) };
  if (action === 'photoTranscribe') return callBench('/v1/voice/transcribe-question', 'POST', { wav_base64: payload.wav_base64 });
  if (action === 'photoImportCapture') return { image: photoImages.capture(payload) };
  if (action === 'photoReleaseImage') return photoImages.release(payload.image_id);
  if (action === 'photoAsk') {
    if (!UUID.test(payload.context_id) || typeof payload.question !== 'string' || !payload.question.trim() || payload.question.length > 4000)
      throw new Error('Enter a question for these images.');
    return callBench('/v1/photo-help/investigate', 'POST', { context_id: payload.context_id,
      question: payload.question, images: photoImages.selected(payload.image_ids) });
  }
  if (action === 'photoStatus') {
    if (!UUID.test(payload.turn_id)) throw new Error('Invalid photo question ID.');
    return callBench(`/v1/photo-help/${payload.turn_id}`, 'GET');
  }
  if (action === 'photoCancel') {
    if (!UUID.test(payload.context_id) || (payload.turn_id !== undefined && !UUID.test(payload.turn_id))) throw new Error('Invalid photo question ID.');
    return callBench('/v1/photo-help/cancel', 'POST', { context_id: payload.context_id, ...(payload.turn_id ? { turn_id: payload.turn_id } : {}) });
  }
  const voiceConnectionActions = {
    elevenLabsStatus: 'status', elevenLabsConnect: 'connect', elevenLabsRefresh: 'refresh',
    elevenLabsSelectVoice: 'selectVoice', elevenLabsDisconnect: 'disconnect',
    elevenLabsSetGenerationEnabled: 'setGenerationEnabled', elevenLabsSpeak: 'speak', elevenLabsCancelSpeech: 'cancelSpeech',
  };
  if (Object.hasOwn(voiceConnectionActions, action)) {
    if (!elevenLabs) throw new Error('The private voice connection is not ready.');
    return elevenLabs.handle(voiceConnectionActions[action], payload);
  }
  if (action === 'openCompanion') return openCompanion();
  if (action === 'closeCompanion') { if (companionWindow && !companionWindow.isDestroyed()) companionWindow.close(); return { enabled: false }; }
  if (action === 'updateCompanion') {
    if (!['idle', 'listening', 'thinking', 'speaking', 'paused', 'error'].includes(payload.activity)
        || typeof payload.caption !== 'string' || payload.caption.length > 500 || typeof payload.reducedMotion !== 'boolean') throw new Error('Invalid companion state.');
    if (payload.expression !== undefined && !['neutral', 'thinking', 'stumped', 'happy', 'smug', 'weary'].includes(payload.expression)) throw new Error('Invalid guide expression.');
    sendCompanionState({ activity: payload.activity, expression: payload.expression || 'neutral', caption: payload.caption, reducedMotion: payload.reducedMotion });
    return { enabled: Boolean(companionWindow && !companionWindow.isDestroyed()) };
  }
  if (action === 'enableMicrophone') { microphoneAllowed = true; return { allowed: true }; }
  if (action === 'enableCamera') { cameraAllowed = true; return { allowed: true }; }
  if (action === 'disableMicrophone') { microphoneAllowed = false; return { allowed: false }; }
  if (action === 'disableCamera') { cameraAllowed = false; return { allowed: false }; }
  if (action === 'piVideoConnect') return piVideo.connect(payload.port, payload.token);
  if (action === 'piVideoFrame') return piVideo.latest();
  if (action === 'piVideoStatus') return piVideo.status();
  if (action === 'piVideoDisconnect') return piVideo.disconnect();
  if (action === 'pause' || action === 'stop' || action === 'selectFixture') {
    void elevenLabs?.handle('cancelSpeech', {});
    piVideo.disconnect(); microphoneAllowed = false; cameraAllowed = false;
  }
  const { sid, ...body } = payload;
  if (body.turn_id !== undefined && (typeof body.turn_id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.turn_id))) throw new Error('Invalid investigation ID.');
  if (sid !== undefined && (typeof sid !== 'string' || !/^[a-f0-9-]{36}$/.test(sid))) throw new Error('Invalid session ID.');
  if (action === 'investigateWithImage') {
    if (!sid || typeof body.question !== 'string' || !body.question.trim() || body.question.length > 4000) throw new Error('Enter a question for the selected session.');
    const selected = await dialog.showOpenDialog(mainWindow, { title: 'Choose an image to send with your question',
      properties: ['openFile'], filters: [{ name: 'Reviewed circuit image', extensions: ['png', 'jpg', 'jpeg'] }] });
    if (selected.canceled || selected.filePaths.length !== 1) return { cancelled: true };
    const source = selected.filePaths[0];
    const stat = await fs.promises.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2000000) throw new Error('Choose a local PNG or JPEG under 2 MB.');
    const image_base64 = prepareReviewedImage(await fs.promises.readFile(source), nativeImage);
    const approved = await dialog.showMessageBox(mainWindow, { type: 'question', title: 'Send this reviewed image?',
      message: 'Send the selected image with this question to your signed-in Codex service?',
      detail: `${require('node:path').basename(source)}\n\n${body.question}\n\nOnly this selected image is sent. Original file metadata is removed. The temporary local copy is deleted when the turn finishes.`,
      buttons: ['Cancel', 'Send image and question'], defaultId: 0, cancelId: 0, noLink: true });
    if (approved.response !== 1) return { cancelled: true };
    return callBench(`/v1/sessions/${sid}/investigate/image`, 'POST', { question: body.question, image_base64 });
  }
  if (action === 'exportReport') {
    if (!sid) throw new Error('Choose a bench session first.');
    const report = await callBench(`/v1/sessions/${sid}/report`, 'GET');
    const save = await dialog.showSaveDialog(mainWindow, { title: 'Save a local evidence summary', defaultPath: 'ohm-path-session.md',
      filters: [{ name: 'Markdown summary', extensions: ['md'] }] });
    if (save.canceled || !save.filePath) return { cancelled: true };
    await fs.promises.writeFile(save.filePath, report.markdown, { encoding: 'utf8' });
    return { saved: true };
  }
  if (action === 'selectMeterCrop') {
    if (!sid || typeof body.request_id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.request_id)) throw new Error('Start a fresh measurement request first.');
    const selected = await dialog.showOpenDialog(mainWindow, { title: 'Choose an image cropped to the meter value and unit',
      properties: ['openFile'], filters: [{ name: 'Meter display crop', extensions: ['png', 'jpg', 'jpeg'] }] });
    if (selected.canceled || selected.filePaths.length !== 1) return { cancelled: true };
    const source = selected.filePaths[0];
    const stat = await fs.promises.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2000000) throw new Error('Choose a local PNG or JPEG crop under 2 MB.');
    const data = await fs.promises.readFile(source);
    return callBench(`/v1/sessions/${sid}/candidates/ocr`, 'POST', { request_id: body.request_id, image_base64: data.toString('base64') });
  }
  if (action === 'importCircuit') {
    if (!sid) throw new Error('Choose a bench session first.');
    const selected = await dialog.showOpenDialog(mainWindow, { title: 'Select a reviewed KiCad schematic',
      properties: ['openFile'], filters: [{ name: 'KiCad schematic', extensions: ['kicad_sch'] }] });
    if (selected.canceled || selected.filePaths.length !== 1) return { cancelled: true };
    const source = selected.filePaths[0];
    const stat = await fs.promises.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5000000 || !source.toLowerCase().endsWith('.kicad_sch')) throw new Error('Select a local schematic file under 5 MB.');
    const data = await fs.promises.readFile(source);
    const preview = await callBench(`/v1/sessions/${sid}/imports`, 'POST', { schematic_base64: data.toString('base64') });
    const components = preview.graph.components.map(c => `${c.ref}: ${c.kind}, ${c.value_si} ${c.kind === 'resistor' ? 'ohm' : 'V'} (${c.nodes.join(' to ')})`).join('\n');
    const approval = await dialog.showMessageBox(mainWindow, { type: 'question', title: 'Review imported circuit',
      message: 'Use this validated electrical graph?', detail: `${components}\n\n${preview.warnings.join('\n')}`,
      buttons: ['Cancel', 'Accept circuit'], defaultId: 0, cancelId: 0, noLink: true });
    if (approval.response !== 1) return { cancelled: true };
    return callBench(`/v1/sessions/${sid}/imports/accept`, 'POST', { import_id: preview.import_id });
  }
  const routes = {
    health: ['/v1/health', 'GET'], sessions: ['/v1/sessions', 'GET'], createSession: ['/v1/sessions', 'POST'],
    session: [`/v1/sessions/${sid}`, 'GET'], events: [`/v1/sessions/${sid}/events?tail=true`, 'GET'],
    graph: [`/v1/sessions/${sid}/graph`, 'GET'], selectFixture: [`/v1/sessions/${sid}/fixture`, 'POST'],
    setup: [`/v1/sessions/${sid}/setup`, 'POST'], requestMeasurement: [`/v1/sessions/${sid}/requests`, 'POST'],
    candidate: [`/v1/sessions/${sid}/candidates`, 'POST'], readback: [`/v1/sessions/${sid}/readback`, 'POST'],
    confirm: [`/v1/sessions/${sid}/confirm`, 'POST'], pause: [`/v1/sessions/${sid}/pause`, 'POST'], stop: [`/v1/sessions/${sid}/pause`, 'POST'],
    simulate: [`/v1/sessions/${sid}/simulate`, 'POST'],
    diagnose: [`/v1/sessions/${sid}/diagnose`, 'POST'],
    laboratory: [`/v1/sessions/${sid}/laboratory`, 'POST'],
    voiceStatus: ['/v1/voice/status', 'GET'], transcribe: [`/v1/sessions/${sid}/voice/transcribe`, 'POST'],
    voiceText: [`/v1/sessions/${sid}/voice/text`, 'POST'], question: [`/v1/sessions/${sid}/question`, 'POST'],
    aimStatus: [`/v1/sessions/${sid}/aim/status`, 'GET'], aimDemo: [`/v1/sessions/${sid}/aim/demo`, 'POST'],
    fitCalibration: [`/v1/sessions/${sid}/calibration/fit`, 'POST'],
    investigateStart: [`/v1/sessions/${sid}/investigate`, 'POST'],
    investigateStatus: [`/v1/sessions/${sid}/investigate/${body.turn_id}`, 'GET'],
    investigateCancel: [`/v1/sessions/${sid}/investigate/cancel`, 'POST'],
    assemblyPlan: [`/v1/sessions/${sid}/assembly`, 'GET'],
    firmwareAnalyze: [`/v1/sessions/${sid}/firmware/analyze`, 'POST'],
  };
  const route = routes[action];
  if (!route) throw new Error('Unsupported application action.');
  return callBench(route[0], route[1], route[1] === 'POST' ? body : undefined);
});

app.whenReady().then(async () => {
  if (!ownsProfile) return;
  elevenLabs = createElevenLabsConnection({ safeStorage, filePath: join(app.getPath('userData'), 'private', 'elevenlabs.enc'),
    onSpeechEvent(value) {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed())
        mainWindow.webContents.send('ohmpath:speech', value);
    } });
  turretPreference = createTurretPreference(join(app.getPath('userData'), 'settings', 'turret.json'));
  phonePhotos = createPhonePhotoBridge({ onPhoto({ bytes, question }) {
    if (!phonePhotoAccepting || pendingPhonePhoto || !mainWindow || mainWindow.isDestroyed())
      throw new Error('Photo help is not ready for another photo.');
    const image = photoImages.addUpload(bytes, 'Phone photo');
    pendingPhonePhoto = { image, question: question || '' };
    mainWindow.webContents.send('ohmpath:phone-photo');
    return image.image_id;
  } });
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => {
    const expected = require('node:url').pathToFileURL(join(root, 'dist/desktop/index.html')).href;
    const url = contents?.getURL() || '';
    const trustedOrigin = url.split('#')[0] === expected || (process.env.OHMPATH_DEV === '1' && url.startsWith('http://127.0.0.1:5173/'));
    return Boolean(permission === 'media' && mainWindow && contents === mainWindow.webContents && details.isMainFrame === true && trustedOrigin
      && ((details.mediaType === 'audio' && microphoneAllowed) || (details.mediaType === 'video' && cameraAllowed)));
  });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const expected = require('node:url').pathToFileURL(join(root, 'dist/desktop/index.html')).href;
    const url = contents?.getURL() || '';
    const trustedOrigin = url.split('#')[0] === expected || (process.env.OHMPATH_DEV === '1' && url.startsWith('http://127.0.0.1:5173/'));
    callback(permission === 'media' && mainWindow && contents === mainWindow.webContents && details.isMainFrame === true && trustedOrigin
      && details.mediaTypes?.length > 0 && details.mediaTypes.every(type =>
        (type === 'audio' && microphoneAllowed) || (type === 'video' && cameraAllowed)));
  });
  await startBench();
  mainWindow = new BrowserWindow({ width: 1440, height: 940, minWidth: 980, minHeight: 700, title: 'Ohm Path', show: process.env.OHMPATH_HEADLESS !== '1',
    icon: windowIcon, backgroundColor: '#eee9d7', autoHideMenuBar: true,
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#173e2d', symbolColor: '#fff4db', height: 32 } } : {}),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.on('render-process-gone', () => {
    void elevenLabs?.handle('cancelSpeech', {});
    // A dead interface must not leave its investigator or bench process running.
    microphoneAllowed = false; cameraAllowed = false;
    phonePhotoAccepting = false;
    void phonePhotos?.stop();
    piVideo.disconnect();
    console.error('Ohm Path interface stopped. Restart to recover saved evidence; fresh setup checks are required.');
    app.quit();
  });
  mainWindow.on('closed', () => { mainWindow = null; app.quit(); });
  if (process.env.OHMPATH_DEV === '1') await mainWindow.loadURL('http://127.0.0.1:5173');
  else await mainWindow.loadFile(join(root, 'dist/desktop/index.html'));
}).catch(error => {
  console.error('Ohm Path could not start:', error.message);
  if (process.env.OHMPATH_HEADLESS !== '1') dialog.showErrorBox('Ohm Path could not start', error.message);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (stopping) return;
  stopping = true;
  void elevenLabs?.handle('cancelSpeech', {});
  phonePhotoAccepting = false;
  void phonePhotos?.stop();
  pendingPhonePhoto = null;
  photoImages.clear();
  piVideo.disconnect();
  if (companionWindow && !companionWindow.isDestroyed()) companionWindow.close();
  if (!child || child.exitCode !== null) return;
  event.preventDefault();
  child.stdin.end();
  const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); app.quit(); }, 10000);
  child.once('exit', () => { clearTimeout(timer); app.quit(); });
});
