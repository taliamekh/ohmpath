import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('speech status retry shows pending, completion, timeout, and failure feedback', async () => {
  const root = resolve('.');
  const directory = await mkdtemp(resolve(tmpdir(), 'ohmpath-voice-status-'));
  const mainPath = resolve(directory, 'voice-status-main.cjs');
  await writeFile(mainPath, String.raw`
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { resolve } = require('node:path');
const root = process.env.OHMPATH_VOICE_STATUS_ROOT;
app.setPath('userData', process.env.OHMPATH_VOICE_STATUS_DATA);
let mode = 'not_installed', pendingResolvers = [];
ipcMain.handle('ohmpath:request', async (_event, action, payload = {}) => {
  if (action === 'voiceStatus') {
    if (mode === 'pending') return await new Promise(resolve => { pendingResolvers.push(resolve); });
    if (mode === 'reject') { mode = 'installed'; throw new Error('Synthetic status failure'); }
    if (mode === 'not_installed') return { status: 'not_installed', provider: 'whisper.cpp', model: 'small.en', local_only: true,
      installation: { executable: 'C:/example/whisper-server.exe', executable_exists: true, model: 'C:/example/ggml-small.en.bin', model_exists: false } };
    return { status: 'installed', provider: 'whisper.cpp', model: 'small.en', local_only: true };
  }
  if (action === 'testSetMode') { mode = payload.mode ?? 'installed'; return { ok: true }; }
  if (action === 'testFinishPending') { mode = 'installed'; pendingResolvers.splice(0).forEach(resolve => resolve({ status: 'installed', provider: 'whisper.cpp', model: 'small.en', local_only: true })); return { ok: true }; }
  if (action === 'health') return { status: 'ready', reasoning: 'subscription_on_request' };
  if (action === 'sessions') return [];
  if (action === 'elevenLabsStatus') return { connected: false, generation_enabled: false, voices: [] };
  if (action === 'turretStatus') return { enabled: false, connected: false };
  return {};
});
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_w, _p, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }));
  const window = new BrowserWindow({ show: false, webPreferences: { preload: resolve(root, 'apps/desktop/src/main/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.on('closed', () => app.quit());
  await window.loadFile(resolve(root, 'dist/desktop/index.html'));
});
app.on('window-all-closed', () => app.quit());
`, 'utf8');

  const electron = createRequire(resolve('package.json'))('electron');
  const desktop = spawn(electron, [mainPath, '--remote-debugging-port=0'], {
    env: { ...process.env, OHMPATH_VOICE_STATUS_ROOT: root, OHMPATH_VOICE_STATUS_DATA: resolve(directory, 'profile') }, windowsHide: true,
  });
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Speech status replay did not open.')), 15000);
      desktop.stderr.on('data', chunk => {
        const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      desktop.once('error', error => { clearTimeout(timer); reject(error); });
      desktop.once('exit', code => { clearTimeout(timer); reject(new Error(`Replay exited early (${code}).`)); });
    });
    browser = await chromium.connectOverCDP(endpoint, { timeout: 12000 });
    const page = browser.contexts()[0].pages()[0];
    page.setDefaultTimeout(8000);
    await page.getByRole('button', { name: /Settings/ }).click();
    await expect(page.getByText('NOT_INSTALLED', { exact: true })).toBeVisible();
    const details = page.locator('.speech-installation-details');
    await expect(details).toBeVisible();
    await expect(details.locator('p').first()).not.toBeVisible();
    await details.getByText('Speech file details', { exact: true }).click();
    await expect(details).toContainText('Speech tool: Found');
    await expect(details).toContainText('English model: Missing');
    await expect(details).toContainText('C:/example/ggml-small.en.bin');

    await page.evaluate(() => (window as any).ohmpath.request('testSetMode', { mode: 'pending' }));
    const retry = page.getByRole('button', { name: 'Check local speech again' });
    await retry.click();
    await expect(page.getByRole('button', { name: 'Checking local speech…' })).toBeDisabled();
    await page.evaluate(() => (window as any).ohmpath.request('testFinishPending'));
    await expect(page.getByText('INSTALLED', { exact: true })).toBeVisible();
    await expect(details).toHaveCount(0);

    await page.evaluate(() => (window as any).ohmpath.request('testSetMode', { mode: 'pending' }));
    await page.getByRole('button', { name: 'Check local speech again' }).click();
    await expect(page.getByRole('button', { name: 'Checking local speech…' })).toBeDisabled();
    await expect(page.getByRole('alert')).toHaveText('Speech status check timed out. Try again.', { timeout: 10000 });
    await expect(page.getByRole('button', { name: 'Check local speech again' })).toBeEnabled();

    await page.evaluate(() => (window as any).ohmpath.request('testSetMode', { mode: 'reject' }));
    await page.getByRole('button', { name: 'Check local speech again' }).click();
    await expect(page.getByRole('alert')).toContainText('Synthetic status failure');
    await expect(page.getByRole('button', { name: 'Check local speech again' })).toBeEnabled();
    await page.close();
    await expect.poll(() => desktop.exitCode, { timeout: 8000 }).toBe(0);
  } finally {
    if (desktop.exitCode === null) desktop.kill();
    if (browser) await browser.close().catch(() => undefined);
  }
});
