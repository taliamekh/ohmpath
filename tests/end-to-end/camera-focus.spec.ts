import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('camera snapshots hand off to Photo help without a nested question workspace', async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'ohmpath-camera-focus-'));
  const requireElectron = createRequire(resolve('package.json'));
  const desktop = spawn(requireElectron('electron'), [resolve('tests/electron/photo-help-replay-main.cjs'), '--remote-debugging-port=0'], {
    env: { ...process.env, OHMPATH_REPLAY_DATA_DIR: dataDir }, windowsHide: true,
  });
  let browser;
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Camera focus desktop did not open')), 15000);
      desktop.stderr.on('data', chunk => {
        const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      desktop.once('error', error => { clearTimeout(timer); reject(error); });
    });
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page');
    const camera = page.getByRole('region', { name: 'Camera workspace' });
    const audit = () => page.evaluate(() => (window as any).ohmpath.request('testAudit'));

    await expect(camera.getByText('Overview camera is off')).toBeVisible();
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 360;
      const draw = canvas.getContext('2d')!;
      draw.fillStyle = '#204b46'; draw.fillRect(0, 0, 640, 360);
      draw.fillStyle = '#edc887'; draw.fillRect(170, 110, 300, 140);
      window.setInterval(() => {
        draw.fillStyle = '#204b46'; draw.fillRect(0, 0, 640, 360);
        draw.fillStyle = '#edc887'; draw.fillRect(170, 110, 300, 140);
      }, 70);
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true,
        value: async () => canvas.captureStream(15) });
      Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true,
        value: async () => [{ kind: 'videoinput', deviceId: 'replay-canvas', label: 'Synthetic canvas camera', groupId: 'replay' }] });
    });
    await camera.getByText('Camera setup').click();
    await camera.getByRole('button', { name: 'Enable & list cameras' }).click();
    await camera.getByLabel('Camera device').selectOption('replay-canvas');
    await camera.getByRole('button', { name: 'Turn on overview' }).click();
    await expect.poll(() => camera.locator('video').evaluate((node: HTMLVideoElement) => node.videoWidth)).toBeGreaterThan(0);
    await expect(camera.getByRole('button', { name: 'Take photo for Photo help' })).toBeEnabled();

    await camera.getByRole('button', { name: 'Take photo for Photo help' }).click();
    await expect(page.locator('.photo-help-page').getByText('Overview snapshot').first()).toBeVisible();
    await expect(page.locator('.camera-question-widget')).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
    expect((await audit()).captures).toHaveLength(1);
    expect((await audit()).asks).toHaveLength(0);

    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Live help' }).click();
    await expect(camera.getByRole('button', { name: 'Take photo for Photo help' })).toBeVisible();
    await expect(camera.locator('.camera-question-widget')).toHaveCount(0);
    await page.close();
    await expect.poll(() => desktop.exitCode, { timeout: 8000 }).toBe(0);
  } finally {
    if (desktop.exitCode === null) desktop.kill();
    if (browser) await browser.close().catch(() => undefined);
  }
});
