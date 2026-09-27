import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// This fixture contains only synthetic PCM and a one-pixel PNG. It launches the
// production preload and renderer, but no bench, provider, microphone, or speaker.
const testMain = String.raw`
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { resolve } = require('node:path');
const root = process.env.OHMPATH_REPLAY_ROOT;
const imageId = '10000000-0000-4000-8000-000000000001';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const audit = { asks: 0, transcriptions: 0, microphoneEnables: 0,
  microphoneDisables: 0, speaks: [], cancels: [], speechEvents: 0, unexpected: [], captures: [] };
let piConnected = false;
let window;
let currentSpeech = null;
function handle(event, action, payload = {}) {
  if (action === 'health') return { status: 'ready', hardware: 'disabled', reasoning: 'subscription_on_request' };
  if (action === 'sessions') return [];
  if (action === 'turretStatus') return { enabled: false, connected: false, motion_enabled: false, laser_enabled: false };
  if (action === 'motionStatus' || action === 'motionKeepalive') return { connected: piConnected, armed: false };
  if (action === 'motionConnect') { piConnected = true; return { connected: true, armed: false }; }
  if (action === 'motionDisconnect') { piConnected = false; return { connected: false, armed: false }; }
  if (action === 'motionFrame') return { frame: piConnected ? { jpeg_base64: require('electron').nativeImage.createFromBitmap(Buffer.alloc(640 * 360 * 4, 200), { width: 640, height: 360 }).toJPEG(80).toString('base64'), sequence: Date.now() } : null };
  if (action === 'voiceStatus') return { provider: 'offline fixture', model: 'synthetic', status: 'installed', local_only: true, recording: false };
  if (action === 'elevenLabsStatus') return { connected: true, generation_enabled: true,
    remaining_session_characters: 1000, remaining_session_credits: 1000, provider_remaining_credits: 1000, spending_blocked: false,
    selected_voice_id: 'synthetic_voice', generation_tested: false,
    subscription: { tier: 'offline fixture' }, voices: [] };
  if (action === 'enableMicrophone') { audit.microphoneEnables += 1; return { allowed: true }; }
  if (action === 'disableMicrophone') { audit.microphoneDisables += 1; return { allowed: false }; }
  if (action === 'enableCamera') return { allowed: false };
  if (action === 'disableCamera') return { allowed: false };
  if (action === 'photoTranscribe') {
    const wav = Buffer.from(payload.wav_base64 || '', 'base64');
    if (wav.length < 46 || wav.length > 1500000 || wav.toString('ascii', 0, 4) !== 'RIFF')
      throw new Error('Invalid synthetic WAV.');
    audit.transcriptions += 1;
    return { text: 'Where is the ground connection?', status: 'final', local_only: true };
  }
  if (action === 'photoChooseImage') return { image: { image_id: imageId, name: 'Synthetic circuit.png',
    data_url: 'data:image/png;base64,' + png, width: 1, height: 1 } };
  if (action === 'photoImportCapture') {
    audit.captures.push({ source: payload.source, captured_at: payload.captured_at });
    return { image: { image_id: '10000000-0000-4000-8000-000000000002', name: 'Current Pi snapshot',
      data_url: payload.data_url, width: 640, height: 360 } };
  }
  if (action === 'photoAsk') {
    audit.asks += 1;
    audit.lastQuestion = payload.question;
    audit.lastImages = payload.image_ids;
    audit.contextId = payload.context_id;
    return { status: 'running', turn_id: '20000000-0000-4000-8000-000000000001',
      context_id: payload.context_id, image_revision: 'offline-replay' };
  }
  if (action === 'photoStatus') return { status: 'completed',
    turn_id: '20000000-0000-4000-8000-000000000001',
    context_id: audit.contextId, image_revision: 'offline-replay',
    answer: { explanation: 'Synthetic replay explanation.', observations: [], questions: [],
      next_steps: [], annotations: [], limitations: ['Offline fixture only.'] } };
  if (action === 'photoCancel') return { status: 'cancelled' };
  if (action === 'photoReleaseImage') return { released: true };
  if (action === 'phonePhotoStatus') return { active: false, accepting: false, interfaces: [] };
  if (action === 'phoneLiveStatus') return { active: false, state: 'idle', session_id: '' };
  if (action === 'phonePhotoSetAccepting') return { accepting: false };
  if (action === 'elevenLabsSpeak') {
    currentSpeech = payload.request_id;
    audit.speaks.push({ id: payload.request_id, text: payload.text });
    return { accepted: true, request_id: payload.request_id };
  }
  if (action === 'elevenLabsCancelSpeech') {
    audit.cancels.push(payload.request_id || null);
    if (!payload.request_id || currentSpeech === payload.request_id) currentSpeech = null;
    return { cancelled: true };
  }
  if (action === 'testVoiceAudit') return { ...audit };
  if (action === 'testEmitSyntheticSpeech') {
    if (!currentSpeech) throw new Error('No explicit speech request.');
    const id = currentSpeech;
    const pcm_base64 = Buffer.alloc(24000).toString('base64');
    for (const value of [
      { type: 'start', request_id: id, sample_rate: 24000, format: 'pcm_s16le' },
      { type: 'chunk', request_id: id, sample_rate: 24000, pcm_base64 },
      { type: 'chunk', request_id: id, sample_rate: 24000, pcm_base64 },
      { type: 'chunk', request_id: id, sample_rate: 24000, pcm_base64 },
      { type: 'chunk', request_id: id, sample_rate: 24000, pcm_base64 },
      { type: 'end', request_id: id },
    ]) { event.sender.send('ohmpath:speech', value); audit.speechEvents += 1; }
    currentSpeech = null;
    return { emitted: true };
  }
  audit.unexpected.push(action);
  throw new Error('Unexpected offline replay action: ' + action);
}
app.disableHardwareAcceleration();
app.setPath('userData', process.env.OHMPATH_REPLAY_DATA_DIR);
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }));
  ipcMain.handle('ohmpath:request', handle);
  window = new BrowserWindow({ width: 1200, height: 800, show: false,
    webPreferences: { preload: resolve(root, 'apps/desktop/src/main/preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.on('closed', () => app.quit());
  await window.loadFile(resolve(root, 'dist/desktop/index.html'));
}).catch(error => { console.error('Offline voice replay failed:', error); app.quit(); });
app.on('window-all-closed', () => app.quit());
`;

const fakeAudio = String.raw`
(() => {
  const audit = { activeTracks: 0, createdTracks: 0, stoppedTracks: 0,
    microphoneRequests: 0, audioContexts: 0, frames: 0, sourceStarts: 0, sourceStops: 0 };
  Object.defineProperty(window, '__syntheticAudio', { value: audit });
  const fakeMedia = { getUserMedia: async constraints => {
    if (!constraints.audio || constraints.video !== false) throw new Error('Only synthetic audio is available.');
    audit.microphoneRequests += 1;
    audit.activeTracks += 1;
    audit.createdTracks += 1;
    const track = { stopped: false, stop() {
      if (this.stopped) return;
      this.stopped = true;
      audit.activeTracks -= 1;
      audit.stoppedTracks += 1;
    } };
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  } };
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: fakeMedia });
  class FakeAudioContext {
    constructor(options = {}) {
      this.sampleRate = options.sampleRate || 24000;
      this.state = 'suspended'; this.origin = performance.now(); this.destination = {};
      this.processors = []; audit.audioContexts += 1;
    }
    get currentTime() { return (performance.now() - this.origin) / 1000; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; this.processors.forEach(item => item.disconnect()); return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() {
      const processor = { onaudioprocess: null, timer: null,
        connect() { this.timer = setInterval(() => {
          const samples = new Float32Array(4096).fill(.1);
          audit.frames += samples.length;
          this.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples },
            outputBuffer: { getChannelData: () => new Float32Array(4096) } });
        }, 10); },
        disconnect() { if (this.timer) clearInterval(this.timer); this.timer = null; } };
      this.processors.push(processor); return processor;
    }
    createBuffer(_channels, length, rate) {
      const samples = new Float32Array(length);
      return { duration: length / rate, getChannelData: () => samples };
    }
    createBufferSource() {
      const context = this;
      return { buffer: null, onended: null, timer: null, stopped: false,
        connect() {}, disconnect() {},
        start(at) {
          audit.sourceStarts += 1;
          this.timer = setTimeout(() => { if (!this.stopped) this.onended?.(); },
            Math.max(0, (at - context.currentTime) * 1000) + this.buffer.duration * 1000);
        },
        stop() { this.stopped = true; audit.sourceStops += 1; if (this.timer) clearTimeout(this.timer); } };
    }
  }
  window.AudioContext = FakeAudioContext;
})();
`;

test('photo drafts and live spoken questions produce bounded speech without a measurement session', async () => {
  const requireElectron = createRequire(resolve('package.json'));
  const directory = await mkdtemp(join(tmpdir(), 'ohmpath-photo-voice-'));
  const mainPath = join(directory, 'voice-replay-main.cjs');
  await writeFile(mainPath, testMain, 'utf8');
  const desktop = spawn(requireElectron('electron'), [mainPath, '--remote-debugging-port=0'], {
    env: { ...process.env, OHMPATH_REPLAY_DATA_DIR: directory, OHMPATH_REPLAY_ROOT: resolve('.') }, windowsHide: true,
  });
  let browser;
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Offline voice replay did not open.')), 15000);
      desktop.stderr.on('data', chunk => {
        const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      desktop.once('error', error => { clearTimeout(timer); reject(error); });
      desktop.once('exit', code => { clearTimeout(timer); reject(new Error(`Offline voice replay exited early (${code}).`)); });
    });
    browser = await chromium.connectOverCDP(endpoint, { timeout: 12000 });
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 12000 });
    page.setDefaultTimeout(8000);
    await page.waitForURL(url => url.protocol === 'file:' && url.pathname.endsWith('/dist/desktop/index.html'));
    await page.addInitScript({ content: fakeAudio });
    await page.reload();
    const audit = () => page.evaluate(() => (window as any).ohmpath.request('testVoiceAudit'));
    const synthetic = () => page.evaluate(() => (window as any).__syntheticAudio);

    await page.getByRole('button', { name: 'Photo help', exact: false }).first().click();
    await expect(page.getByRole('button', { name: 'Start recording' })).toBeEnabled();
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByText('Microphone on. Finish to transcribe; cancel to discard.')).toBeVisible();
    await expect.poll(async () => (await synthetic()).activeTracks).toBe(1);
    await expect.poll(async () => (await synthetic()).frames).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Finish recording' }).click();
    await expect(page.getByLabel('What would you like help with?')).toHaveValue('Where is the ground connection?');
    await expect.poll(async () => (await synthetic()).activeTracks).toBe(0);
    expect((await audit()).transcriptions).toBe(1);
    expect((await audit()).asks).toBe(0);

    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect.poll(async () => (await synthetic()).activeTracks).toBe(1);
    await page.getByRole('button', { name: 'Cancel recording' }).click();
    await expect.poll(async () => (await synthetic()).activeTracks).toBe(0);
    expect((await audit()).transcriptions).toBe(1);

    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect.poll(async () => (await synthetic()).activeTracks).toBe(1);
    await page.getByRole('button', { name: 'Devices', exact: false }).first().click();
    await expect.poll(async () => (await synthetic()).activeTracks).toBe(0);
    expect((await audit()).asks).toBe(0);
    await page.getByRole('button', { name: 'Photo help', exact: false }).first().click();

    await page.getByRole('button', { name: 'Add a photo or diagram' }).click();
    await page.getByRole('button', { name: 'Ask about these images' }).click();
    await expect(page.locator('.photo-help-explanation')).toHaveText('Synthetic replay explanation.');
    expect((await audit()).asks).toBe(1);
    // Enabled speech now reads a completed answer automatically, once.
    await expect.poll(async () => (await audit()).speaks.length).toBe(1);
    await page.evaluate(() => (window as any).ohmpath.request('testEmitSyntheticSpeech'));
    await expect(page.getByText('Frieren is speaking')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop speaking' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop speaking' }).click();
    await expect(page.getByRole('button', { name: 'Stop speaking' })).toHaveCount(0);
    expect((await audit()).cancels).toContain((await audit()).speaks[0].id);
    expect((await synthetic()).sourceStops).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Live help', exact: false }).first().click();
    await page.getByRole('button', { name: 'Turn on Turret', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Talk to helper' })).toBeEnabled();
    const recordedBefore = (await synthetic()).frames;
    await page.getByRole('button', { name: 'Talk to helper' }).click();
    await expect.poll(async () => (await synthetic()).frames).toBeGreaterThan(recordedBefore);
    await page.getByRole('button', { name: 'Finish and open Photo help' }).click();
    await expect(page.getByLabel('What would you like help with?')).toHaveValue('Where is the ground connection?');
    await page.getByRole('button', { name: 'Ask about these images' }).click();
    await expect(page.locator('.photo-help-explanation')).toHaveText('Synthetic replay explanation.');
    await expect.poll(async () => (await audit()).speaks.length).toBe(2);
    const live = await audit();
    expect(live.asks).toBe(2);
    expect(live.lastQuestion).toBe('Where is the ground connection?');
    expect(live.lastImages).toEqual(['10000000-0000-4000-8000-000000000002']);
    expect(live.captures).toHaveLength(1);
    expect(live.captures[0].source).toBe('pi');
    expect(Date.now() - live.captures[0].captured_at).toBeLessThan(10000);
    expect(live.speaks.every(item => item.text.length <= 1000)).toBe(true);
    expect((await synthetic()).activeTracks).toBe(0);
    expect((await audit()).unexpected).toEqual([]);
    await page.close();
    await expect.poll(() => desktop.exitCode, { timeout: 8000 }).toBe(0);
  } finally {
    if (desktop.exitCode === null) desktop.kill();
    if (browser) await browser.close().catch(() => undefined);
  }
});
