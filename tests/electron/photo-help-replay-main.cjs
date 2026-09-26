// Offline Electron replay: real renderer and production preload, test-only IPC.
// No bench service, model, microphone, camera, network, or physical driver starts.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { resolve } = require('node:path');
const { deflateSync } = require('node:zlib');

const root = resolve(__dirname, '../..');
const imageIds = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
];
const audit = { asks: [], cancels: [], releases: [], choices: 0, statusChecks: 0, unexpected: [] };
const jobs = new Map();
let resolveLateAsk;
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
  return { image_id: id, name: `Replay circuit ${index ? 'B' : 'A'}.png`,
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
  if (action === 'sessions') return [];
  if (action === 'voiceStatus') return { provider: 'offline replay', status: 'not_installed', local_only: true, recording: false };
  if (action === 'disableCamera') return { allowed: false };
  if (action === 'piVideoDisconnect') return { connected: false };
  if (action === 'photoChooseImage') {
    const index = audit.choices++;
    if (index > 1) return { cancelled: true };
    return { image: imageAt(index) };
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
  if (action === 'testAudit') return { ...audit, latePending: Boolean(resolveLateAsk), modelCalls: 0 };
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
