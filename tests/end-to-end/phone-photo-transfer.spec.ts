import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// Production renderer and preload, isolated test-only IPC. No phone, LAN
// listener, camera, clipboard, microphone, model, or provider is used.
const testMain = String.raw`
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { resolve } = require('node:path');
const root = process.env.OHMPATH_REPLAY_ROOT;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const qr = 'data:image/png;base64,' + png;
const audit = { starts: 0, stops: 0, accepts: [], takes: 0, asks: 0,
  releases: [], sent: [], rejected: [], unexpected: [] };
let active = false;
let accepting = false;
let pending = null;
let delayedTake = false;
let resolveTake = null;
let window;
function imageAt(number) {
  return { image_id: '10000000-0000-4000-8000-' + String(number).padStart(12, '0'),
    name: 'Phone photo ' + number + '.png', data_url: 'data:image/png;base64,' + png,
    width: 1, height: 1 };
}
function status() {
  return { active, accepting, pending: Boolean(pending),
    interfaces: [{ address: '192.168.10.24', name: 'Offline private network' }],
    ...(active ? { url: 'http://192.168.10.24:12345/#synthetic-only',
      qr_data_url: qr, received_count: audit.sent.length } : {}) };
}
function handle(event, action, payload = {}) {
  if (action === 'health') return { status: 'ready', hardware: 'disabled', reasoning: 'unavailable' };
  if (action === 'sessions') return [];
  if (action === 'voiceStatus') return { provider: 'offline fixture', status: 'not_installed', local_only: true, recording: false };
  if (action === 'elevenLabsStatus') return { connected: false, generation_enabled: false,
    generation_tested: false, storage_status: 'not_connected', selected_voice_id: null,
    subscription: null, voices: [], spending_blocked: true };
  if (action === 'turretStatus') return { enabled: false, connected: false,
    motion_enabled: false, laser_enabled: false };
  if (action === 'enableCamera' || action === 'disableCamera') return { allowed: false };
  if (action === 'phonePhotoStatus') return status();
  if (action === 'phonePhotoSetAccepting') {
    accepting = payload.accepting === true;
    audit.accepts.push(accepting);
    return { accepting };
  }
  if (action === 'phonePhotoStart') {
    if (payload.address !== '192.168.10.24' || !accepting) throw new Error('Offline link not ready.');
    active = true; audit.starts += 1; return status();
  }
  if (action === 'phonePhotoStop') {
    if (active) audit.stops += 1;
    active = false;
    if (pending) audit.releases.push(pending.image.image_id);
    pending = null;
    return status();
  }
  if (action === 'phonePhotoTake') {
    audit.takes += 1;
    if (!accepting || !pending) return { photo: null };
    const photo = pending; pending = null;
    if (delayedTake) {
      delayedTake = false;
      return new Promise(resolve => { resolveTake = () => { resolveTake = null; resolve({ photo }); }; });
    }
    return { photo };
  }
  if (action === 'photoReleaseImage') {
    audit.releases.push(payload.image_id); return { released: true };
  }
  if (action === 'photoCancel') return { status: 'cancelled' };
  if (action === 'photoAsk') { audit.asks += 1; throw new Error('No model is available in this fixture.'); }
  if (action === 'testPhoneSend') {
    const number = payload.number;
    if (!active || !accepting || pending || !Number.isInteger(number) || number < 1 || number > 5) {
      audit.rejected.push(number); return { accepted: false };
    }
    pending = { image: imageAt(number), question: String(payload.question || '') };
    audit.sent.push(number);
    event.sender.send('ohmpath:phone-photo');
    return { accepted: true };
  }
  if (action === 'testPhoneDelayTake') { delayedTake = true; return { armed: true }; }
  if (action === 'testPhoneResolveTake') {
    if (!resolveTake) throw new Error('No delayed photo receipt.');
    resolveTake(); return { resolved: true };
  }
  if (action === 'testPhoneAudit') return { ...audit, active, accepting,
    pending: Boolean(pending), latePending: Boolean(resolveTake) };
  audit.unexpected.push(action);
  throw new Error('Unexpected offline phone action: ' + action);
}
app.disableHardwareAcceleration();
app.setPath('userData', process.env.OHMPATH_REPLAY_DATA_DIR);
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !details.url.startsWith('file:') }));
  ipcMain.handle('ohmpath:request', handle);
  window = new BrowserWindow({ width: 1420, height: 940, show: false,
    webPreferences: { preload: resolve(root, 'apps/desktop/src/main/preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('closed', () => app.quit());
  await window.loadFile(resolve(root, 'dist/desktop/index.html'));
}).catch(error => { console.error('Offline phone replay failed:', error); app.quit(); });
app.on('window-all-closed', () => app.quit());
`;

type Audit = {
  starts: number; stops: number; accepts: boolean[]; takes: number;
  asks: number; releases: string[]; sent: number[]; rejected: number[];
  unexpected: string[]; active: boolean; accepting: boolean; pending: boolean;
  latePending: boolean;
};

test('phone photos require explicit pairing and Ask, remain bounded, and release a late receipt', async () => {
  const requireElectron = createRequire(resolve('package.json'));
  const directory = await mkdtemp(join(tmpdir(), 'ohmpath-phone-replay-'));
  const mainPath = join(directory, 'phone-replay-main.cjs');
  await writeFile(mainPath, testMain, 'utf8');
  const desktop = spawn(requireElectron('electron'), [mainPath, '--remote-debugging-port=0'], {
    env: { ...process.env, OHMPATH_REPLAY_DATA_DIR: directory, OHMPATH_REPLAY_ROOT: resolve('.') },
    windowsHide: true,
  });
  let browser: import('@playwright/test').Browser | undefined;
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Offline phone replay did not open.')), 15000);
      desktop.stderr.on('data', chunk => {
        const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      desktop.once('error', error => { clearTimeout(timer); reject(error); });
      desktop.once('exit', code => { clearTimeout(timer); reject(new Error(`Offline phone replay exited early (${code}).`)); });
    });
    browser = await chromium.connectOverCDP(endpoint, { timeout: 12000 });
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 12000 });
    page.setDefaultTimeout(8000);
    await page.waitForURL(url => url.protocol === 'file:' && url.pathname.endsWith('/dist/desktop/index.html'));
    const request = <T>(action: string, payload: Record<string, unknown> = {}) =>
      page.evaluate(([name, data]) => (window as any).ohmpath.request(name, data) as Promise<T>,
        [action, payload] as const);
    const audit = () => request<Audit>('testPhoneAudit');
    const send = (number: number, question = '') =>
      request<{ accepted: boolean }>('testPhoneSend', { number, question });

    await page.getByRole('button', { name: 'Photo help', exact: false }).first().click();
    expect((await audit()).starts).toBe(0);
    expect((await send(1)).accepted).toBe(false); // No implicit LAN pairing.
    await page.getByText('Send a photo from your phone').click();
    await expect(page.getByRole('button', { name: 'Create phone link' })).toBeEnabled();
    expect((await audit()).starts).toBe(0); // Expanding the panel is still read-only.
    await page.getByRole('button', { name: 'Create phone link' }).click();
    await expect(page.getByRole('img', { name: 'Scan with your phone camera to send photos to this Ohm Path window' })).toBeVisible();
    await expect(page.getByText('Ready to receive', { exact: false })).toBeVisible();
    expect((await audit()).starts).toBe(1);

    expect((await send(1, 'Where is the ground connection?')).accepted).toBe(true);
    await expect(page.getByRole('img', { name: 'Phone photo 1.png' })).toBeVisible();
    await expect(page.getByLabel('What would you like help with?')).toHaveValue('Where is the ground connection?');
    expect((await audit()).asks).toBe(0);
    expect((await send(2)).accepted).toBe(true);
    await expect(page.getByText('Phone photo 2.png').first()).toBeVisible();
    expect((await send(3)).accepted).toBe(true);
    await expect(page.getByText('Phone photo 3.png').first()).toBeVisible();
    await expect(page.locator('.photo-help-attachments h2')).toContainText('3/3');
    await expect.poll(async () => (await audit()).accepting).toBe(false);
    expect((await send(4)).accepted).toBe(false);
    expect((await audit()).asks).toBe(0);

    await page.getByRole('button', { name: 'Remove Phone photo 3.png' }).click();
    await expect.poll(async () => (await audit()).accepting).toBe(true);
    await request('testPhoneDelayTake');
    expect((await send(4, 'Late question')).accepted).toBe(true);
    await expect.poll(async () => (await audit()).latePending).toBe(true);
    await page.getByRole('button', { name: 'Live help', exact: false }).first().click();
    await expect.poll(async () => (await audit()).accepting).toBe(false);
    await request('testPhoneResolveTake');
    await expect.poll(async () => (await audit()).releases).toContain('10000000-0000-4000-8000-000000000004');
    await page.getByRole('button', { name: 'Photo help', exact: false }).first().click();
    await expect(page.getByText('Phone photo 4.png')).toHaveCount(0);
    await expect(page.getByLabel('What would you like help with?')).toHaveValue('Where is the ground connection?');
    expect((await audit()).asks).toBe(0);

    await page.getByRole('button', { name: 'Close phone link' }).click();
    await expect(page.getByRole('img', { name: 'Scan with your phone camera to send photos to this Ohm Path window' })).toHaveCount(0);
    await expect.poll(async () => (await audit()).active).toBe(false);
    expect((await audit()).stops).toBe(1);
    expect((await send(5)).accepted).toBe(false);
    expect((await audit()).unexpected).toEqual([]);
    await page.close();
    await expect.poll(() => desktop.exitCode, { timeout: 8000 }).toBe(0);
  } finally {
    if (desktop.exitCode === null) desktop.kill();
    if (browser) await browser.close().catch(() => undefined);
  }
});
