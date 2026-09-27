// Offline Electron replay: real renderer and production preload, test-only IPC.
// No bench service, model, microphone, camera, network, or physical driver starts.
const { app, BrowserWindow, ipcMain, nativeImage, session } = require('electron');
const { resolve } = require('node:path');
const { deflateSync } = require('node:zlib');
const { randomUUID } = require('node:crypto');

const root = resolve(__dirname, '../..');
const imageIds = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000005',
  '10000000-0000-4000-8000-000000000006',
];
const audit = { asks: [], cancels: [], releases: [], captures: [], choices: 0, pastes: 0, statusChecks: 0, unexpected: [] };
const piReplay = { connected: false, jpeg_base64: '', reason: '', connects: 0, disconnects: 0, frameCalls: 0, lastPort: null,
  failConnectOnce: false, failFrameOnce: false, failStatusOnce: false, frameMissingOnce: false };
const jobs = new Map();
let resolveLateAsk;
let delayNextChoice = false;
let resolveLateChoice;
let delayNextCapture = false;
let resolveLateCapture;
let window;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(kind, data) {
  const name = Buffer.from(kind, 'ascii');
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}

function fixturePng(red) {
  const width = 24, height = 16;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const pixel = red ? [214, 134, 92, 255] : [74, 183, 166, 255];
  const scanline = Buffer.concat([Buffer.from([0]), Buffer.from(Array(width).fill(pixel).flat())]);
  const rows = Buffer.concat(Array(height).fill(scanline));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function imageAt(index) {
  const id = imageIds[index];
  return { image_id: id, name: `Replay circuit ${String.fromCharCode(65 + index)}.png`,
    data_url: `data:image/png;base64,${fixturePng(index > 0).toString('base64')}`,
    width: 24, height: 16 };
}

function jobFor(payload) {
  const number = audit.asks.length;
  const turn_id = `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
  const job = { turn_id, context_id: payload.context_id, image_ids: [...payload.image_ids],
    question: payload.question, image_revision: 'replay-only', status: 'running' };
  jobs.set(turn_id, job);
  audit.asks.push({ context_id: job.context_id, turn_id, question: job.question, image_ids: job.image_ids });
  return job;
}

function handle(action, payload = {}) {
  if (action === 'health') return { service: 'Ohm Path replay', hardware: 'disabled', reasoning: 'subscription_on_request' };
  if (action === 'elevenLabsStatus') return { connected: false, storage_status: 'not_connected',
    generation_enabled: false, generation_tested: false, selected_voice_id: null,
    subscription: null, voices: [], metadata_checked_at: null, spending_blocked: true };
  if (action === 'turretStatus') return { enabled: false, connected: false,
    motion_enabled: false, laser_enabled: false };
  if (action === 'sessions') return [];
  if (action === 'voiceStatus') return { provider: 'offline replay', status: 'not_installed', local_only: true, recording: false };
  if (action === 'phonePhotoSetAccepting') return { accepting: payload.accepting === true };
  if (action === 'phonePhotoStatus' || action === 'phonePhotoStop') return { active: false, interfaces: [], pending: false };
  if (action === 'enableCamera') return { allowed: true };
  if (action === 'disableCamera') return { allowed: false };
  if (action === 'piVideoConnect') {
    if (!Number.isInteger(payload.port) || payload.port < 1024 || payload.port > 65535 || typeof payload.token !== 'string' || !payload.token) throw new Error('Invalid replay Pi connection.');
    if (piReplay.failConnectOnce) { piReplay.failConnectOnce = false; throw new Error('Replay Pi connection failed. Check the local tunnel and token.'); }
    piReplay.connected = true;
    piReplay.reason = '';
    piReplay.connects += 1;
    piReplay.lastPort = payload.port;
    return { connected: true, source: 'Raspberry Pi camera via an existing local tunnel' };
  }
  if (action === 'piVideoFrame') {
    piReplay.frameCalls += 1;
    if (piReplay.failFrameOnce) { piReplay.failFrameOnce = false; throw new Error('Replay Pi frame request failed. Check the local tunnel and reconnect.'); }
    if (piReplay.frameMissingOnce) { piReplay.frameMissingOnce = false; return null; }
    return piReplay.connected && piReplay.jpeg_base64 ? { jpeg_base64: piReplay.jpeg_base64, received_at: Date.now() } : null;
  }
  if (action === 'piVideoStatus') {
    if (piReplay.failStatusOnce) { piReplay.failStatusOnce = false; throw new Error('Replay Pi status request failed. Check the local tunnel and reconnect.'); }
    return { connected: piReplay.connected, state: piReplay.connected ? 'streaming' : 'disconnected', reason: piReplay.reason, fresh_frame: piReplay.connected && Boolean(piReplay.jpeg_base64), source: 'Raspberry Pi camera via an existing local tunnel' };
  }
  if (action === 'piVideoDisconnect') { piReplay.connected = false; piReplay.disconnects += 1; return { connected: false }; }
  if (action === 'testPiReplaySetFrame') {
    if (typeof payload.jpeg_base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.jpeg_base64) || payload.jpeg_base64.length > 1000000) throw new Error('Invalid replay Pi frame.');
    piReplay.jpeg_base64 = payload.jpeg_base64;
    return { configured: true };
  }
  if (action === 'testPiReplayDrop') {
    if (!piReplay.connected) throw new Error('Replay Pi camera is not connected.');
    piReplay.connected = false;
    piReplay.reason = 'Replay Pi stream stopped. Check the local tunnel and reconnect.';
    return { connected: false };
  }
  if (action === 'testPiReplayFailNextConnect') { piReplay.failConnectOnce = true; return { armed: true }; }
  if (action === 'testPiReplayFailNextFrame') { piReplay.failFrameOnce = true; return { armed: true }; }
  if (action === 'testPiReplayFailNextStatus') { piReplay.frameMissingOnce = true; piReplay.failStatusOnce = true; return { armed: true }; }
  if (action === 'testPiReplayAudit') return { connected: piReplay.connected, connects: piReplay.connects, disconnects: piReplay.disconnects, frameCalls: piReplay.frameCalls, lastPort: piReplay.lastPort };
  if (action === 'photoImportCapture') {
    if (payload.source !== 'overview' || !Number.isFinite(payload.captured_at)
        || Math.abs(Date.now() - payload.captured_at) > 10000
        || typeof payload.data_url !== 'string' || payload.data_url.length > 2700000
        || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(payload.data_url)) throw new Error('Invalid replay camera snapshot.');
    const { width, height } = nativeImage.createFromDataURL(payload.data_url).getSize();
    if (!width || !height) throw new Error('Invalid replay camera dimensions.');
    // Preserve the first replay ID used by lifecycle assertions; later captures
    // must be distinct so the visual workspace can select the newest snapshot.
    const image_id = audit.captures.length ? randomUUID() : imageIds[2];
    audit.captures.push({ source: payload.source, captured_at: payload.captured_at, length: payload.data_url.length });
    const result = { image: { image_id, name: 'Overview snapshot', data_url: payload.data_url, width, height } };
    if (delayNextCapture) {
      delayNextCapture = false;
      return new Promise(resolve => { resolveLateCapture = () => { resolveLateCapture = undefined; resolve(result); }; });
    }
    return result;
  }
  if (action === 'photoChooseImage') {
    const index = audit.choices++;
    if (index > 2) return { cancelled: true };
    const result = { image: imageAt(index) };
    if (delayNextChoice) {
      delayNextChoice = false;
      return new Promise(resolve => { resolveLateChoice = () => { resolveLateChoice = undefined; resolve(result); }; });
    }
    return result;
  }
  if (action === 'photoPasteImage') {
    // Explicit-click replay only. No OS clipboard access is available in this fixture.
    const index = audit.pastes++;
    return index < 3 ? { image: imageAt(index + 3) } : { cancelled: true };
  }
  if (action === 'photoReleaseImage') {
    audit.releases.push(payload.image_id);
    return { released: true };
  }
  if (action === 'photoAsk') {
    const job = jobFor(payload);
    if (job.question.includes('late request')) {
      return new Promise(resolve => { resolveLateAsk = () => { resolveLateAsk = undefined; resolve({ ...job }); }; });
    }
    return { ...job };
  }
  if (action === 'photoStatus') {
    audit.statusChecks += 1;
    const job = jobs.get(payload.turn_id);
    if (!job) throw new Error('Unknown replay turn.');
    if (job.question.includes('fail request')) {
      return { turn_id: job.turn_id, status: 'failed', context_id: job.context_id,
        image_revision: job.image_revision, error: 'replay_failure', message: 'Replay answer unavailable.' };
    }
    if (audit.cancels.some(item => item.context_id === job.context_id)) {
      return { turn_id: job.turn_id, status: 'cancelled', context_id: job.context_id,
        image_revision: job.image_revision };
    }
    return { turn_id: job.turn_id, status: 'completed', context_id: job.context_id,
      image_revision: job.image_revision, answer: {
        explanation: `Replay explanation for ${job.question}`,
        observations: ['A colored practice image is visible.'], questions: [],
        next_steps: ['Inspect the marked area.'],
        annotations: [{ image_id: job.image_ids[0], x: .5, y: .5, label: 'Replay marker' }],
        limitations: ['This answer is an offline test fixture.'],
      } };
  }
  if (action === 'photoCancel') {
    audit.cancels.push({ context_id: payload.context_id, turn_id: payload.turn_id ?? null });
    return { status: 'cancelled', context_id: payload.context_id };
  }
  if (action === 'testAudit') return { ...audit, latePending: Boolean(resolveLateAsk),
    lateChoicePending: Boolean(resolveLateChoice), lateCapturePending: Boolean(resolveLateCapture), modelCalls: 0 };
  if (action === 'testDelayNextChoice') {
    if (delayNextChoice || resolveLateChoice) throw new Error('A replay file choice is already delayed.');
    delayNextChoice = true;
    return { armed: true };
  }
  if (action === 'testResolveLateChoice') {
    if (!resolveLateChoice) throw new Error('No delayed replay file choice.');
    resolveLateChoice();
    return { released: true };
  }
  if (action === 'testDelayNextCapture') {
    if (delayNextCapture || resolveLateCapture) throw new Error('A replay capture is already delayed.');
    delayNextCapture = true;
    return { armed: true };
  }
  if (action === 'testResolveLateCapture') {
    if (!resolveLateCapture) throw new Error('No delayed replay capture.');
    resolveLateCapture();
    return { released: true };
  }
  if (action === 'testResolveLateAsk') {
    if (!resolveLateAsk) throw new Error('No delayed replay request.');
    resolveLateAsk();
    return { released: true };
  }
  audit.unexpected.push(action);
  throw new Error(`Unexpected offline replay action: ${action}`);
}

app.disableHardwareAcceleration();
if (process.env.OHMPATH_REPLAY_DATA_DIR) app.setPath('userData', process.env.OHMPATH_REPLAY_DATA_DIR);
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith('file:') });
  });
  ipcMain.handle('ohmpath:request', (_event, action, payload) => handle(action, payload));
  window = new BrowserWindow({ width: 1420, height: 940, show: false, backgroundColor: '#09141e',
    webPreferences: { preload: resolve(root, 'apps/desktop/src/main/preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('closed', () => app.quit());
  await window.loadFile(resolve(root, 'dist/desktop/index.html'));
}).catch(error => { console.error('Offline photo replay failed:', error); app.quit(); });

app.on('window-all-closed', () => app.quit());
