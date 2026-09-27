import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('Pi preview clears a dropped replay stream and can reconnect', async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'ohmpath-pi-recovery-'));
  const requireElectron = createRequire(resolve('package.json'));
  const desktop = spawn(requireElectron('electron'), [resolve('tests/electron/photo-help-replay-main.cjs'), '--remote-debugging-port=0'], {
    env: { ...process.env, OHMPATH_REPLAY_DATA_DIR: dataDir }, windowsHide: true,
  });
  let browser;
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Pi replay desktop did not open')), 15000);
      desktop.stderr.on('data', chunk => {
        const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      desktop.once('error', error => { clearTimeout(timer); reject(error); });
    });
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page');
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const draw = canvas.getContext('2d')!;
      draw.fillStyle = '#204b46';
      draw.fillRect(0, 0, 640, 360);
      draw.fillStyle = '#e7bd7a';
      draw.fillRect(185, 110, 270, 140);
      draw.fillStyle = '#bc534a';
      draw.fillRect(288, 156, 64, 46);
      await (window as any).ohmpath.request('testPiReplaySetFrame', { jpeg_base64: canvas.toDataURL('image/jpeg', .8).split(',')[1] });
    });
    const replay = (action: string) => page.evaluate(action => (window as any).ohmpath.request(action), action);
    const camera = page.getByRole('region', { name: 'Camera workspace' });
    await camera.getByText('Camera setup').click();
    await camera.getByText('Use an existing video tunnel').click();
    await camera.getByLabel('Video token').fill('replay-token-one');
    await camera.getByRole('button', { name: 'Connect video tunnel' }).click();
    const cameraFrame = camera.getByRole('img', { name: 'Latest Turret camera frame' });
    await expect(cameraFrame).toBeVisible();
    await expect.poll(() => cameraFrame.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(640);
    await expect(camera.getByText('Current frame', { exact: true })).toBeVisible();
    await expect(camera.getByRole('button', { name: 'Take photo for Photo help' })).toBeDisabled();

    await replay('testPiReplayDrop');
    await expect(cameraFrame).toHaveCount(0);
    await expect(camera.getByText('Turret camera is off')).toBeVisible();
    await expect(camera.locator('.camera-workspace-pi').getByText('Not connected')).toBeVisible();
    await expect(camera.locator('.camera-workspace-error')).toContainText('Check the local tunnel and reconnect');
    await expect(camera.getByRole('button', { name: 'Take photo for Photo help' })).toBeDisabled();
    expect((await page.evaluate(() => (window as any).ohmpath.request('testAudit'))).captures).toHaveLength(0);
    await replay('testPiReplayFailNextConnect');
    await camera.getByText('Use an existing video tunnel').click();
    await camera.getByLabel('Video token').fill('replay-token-two');
    await camera.getByRole('button', { name: 'Connect video tunnel' }).click();
    await expect(camera.locator('.camera-workspace-error')).toContainText('Replay Pi connection failed');
    await expect(cameraFrame).toHaveCount(0);
    await camera.getByLabel('Video token').fill('replay-token-two-retry');
    await camera.getByRole('button', { name: 'Connect video tunnel' }).click();
    await expect(cameraFrame).toBeVisible();
    await expect(camera.getByText('Current frame', { exact: true })).toBeVisible();
    await replay('testPiReplayFailNextFrame');
    await expect(cameraFrame).toHaveCount(0);
    await expect(camera.locator('.camera-workspace-error')).toContainText('Replay Pi frame request failed');
    await expect(camera.getByRole('button', { name: 'Take photo for Photo help' })).toBeDisabled();
    await camera.getByText('Use an existing video tunnel').click();
    await camera.getByLabel('Video token').fill('replay-token-two-again');
    await camera.getByRole('button', { name: 'Connect video tunnel' }).click();
    await expect(cameraFrame).toBeVisible();

    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Devices' }).click();
    await expect(page.getByRole('heading', { name: 'Raspberry Pi camera' })).toBeVisible();
    await expect.poll(async () => (await replay('testPiReplayAudit') as any).connected).toBe(false);
    await page.getByLabel('VIDEO TOKEN · THIS LAUNCH ONLY').fill('replay-token-three');
    await page.getByRole('button', { name: 'Connect Pi preview' }).click();
    const deviceFrame = page.getByRole('img', { name: 'Latest raw frame from the Raspberry Pi camera' });
    await expect(deviceFrame).toBeVisible();
    await expect.poll(() => deviceFrame.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(640);
    await replay('testPiReplayDrop');
    await expect(deviceFrame).toHaveCount(0);
    await expect(page.getByText('No Pi video frame')).toBeVisible();
    await expect(page.locator('.device-section-head').filter({ has: page.getByRole('heading', { name: 'Raspberry Pi camera' }) }).getByText('DISCONNECTED', { exact: true })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Check the local tunnel and reconnect');
    await page.getByLabel('VIDEO TOKEN · THIS LAUNCH ONLY').fill('replay-token-four');
    await page.getByRole('button', { name: 'Connect Pi preview' }).click();
    await expect(deviceFrame).toBeVisible();
    await replay('testPiReplayFailNextStatus');
    await expect(deviceFrame).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText('Replay Pi status request failed');
    await expect(page.getByText('No Pi video frame')).toBeVisible();
    await page.getByLabel('VIDEO TOKEN · THIS LAUNCH ONLY').fill('replay-token-five');
    await page.getByRole('button', { name: 'Connect Pi preview' }).click();
    await expect(deviceFrame).toBeVisible();
    const piAudit = await replay('testPiReplayAudit') as any;
    expect(piAudit.connects).toBe(6);
    expect(piAudit.frameCalls).toBeGreaterThan(0);
    expect(piAudit.lastPort).toBe(8766);
    expect((await page.evaluate(() => (window as any).ohmpath.request('testAudit'))).unexpected).toEqual([]);
    await page.close();
    await expect.poll(() => desktop.exitCode, { timeout: 8000 }).toBe(0);
  } finally {
    if (desktop.exitCode === null) desktop.kill();
    if (browser) await browser.close().catch(() => undefined);
  }
});
