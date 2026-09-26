import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('late camera snapshot is released after leaving Live help', async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'ohmpath-late-camera-capture-'));
  const requireElectron = createRequire(resolve('package.json'));
  const desktop = spawn(requireElectron('electron'), [resolve('tests/electron/photo-help-replay-main.cjs'), '--remote-debugging-port=0'], {
    env: { ...process.env, OHMPATH_REPLAY_DATA_DIR: dataDir }, windowsHide: true,
  });
  let browser;
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Camera snapshot replay did not open')), 15000);
      desktop.stderr.on('data', chunk => {
        const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      desktop.once('error', error => { clearTimeout(timer); reject(error); });
    });
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page');
    const request = (action: string) => page.evaluate(action => (window as any).ohmpath.request(action), action);
    const camera = page.getByRole('region', { name: 'Camera workspace' });
    await expect(camera.getByText('Overview camera is off')).toBeVisible();
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#184d48';
      context.fillRect(0, 0, 640, 360);
      context.fillStyle = '#d8b66e';
      context.fillRect(160, 95, 320, 170);
      let frame = 0;
      window.setInterval(() => {
        context.fillStyle = frame++ % 2 ? '#184d48' : '#225f58';
        context.fillRect(0, 0, 640, 360);
        context.fillStyle = '#d8b66e';
        context.fillRect(160, 95, 320, 170);
      }, 70);
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
        const stream = canvas.captureStream(15);
        (window as any).__replayCameraStream = stream;
        return stream;
      } });
      Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true,
        value: async () => [{ kind: 'videoinput', deviceId: 'late-replay-canvas', label: 'Synthetic canvas camera', groupId: 'replay' }] });
    });
    await camera.getByText('Camera setup').click();
    await camera.getByRole('button', { name: 'Enable & list cameras' }).click();
    await camera.getByLabel('Camera device').selectOption('late-replay-canvas');
    await camera.getByRole('button', { name: 'Connect selected' }).click();
    await expect.poll(() => camera.locator('video').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
    await camera.getByRole('button', { name: 'Full screen', exact: true }).click();
    await expect(camera).toHaveClass(/is-focused/);

    await request('testDelayNextCapture');
    await camera.getByRole('button', { name: 'Ask about this view' }).click();
    await expect.poll(async () => (await request('testAudit') as any).lateCapturePending).toBe(true);
    expect((await request('testAudit') as any).captures).toHaveLength(1);

    await camera.getByRole('button', { name: 'Exit full screen' }).last().click();
    await expect(camera).not.toHaveClass(/is-focused/);
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Photo help' }).click();
    await expect(page.getByText('Start with an image')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__replayCameraStream.getVideoTracks()[0].readyState)).toBe('ended');
    await request('testResolveLateCapture');
    await expect.poll(async () => (await request('testAudit') as any).releases).toContain('10000000-0000-4000-8000-000000000003');
    await expect(page.getByText('Start with an image')).toBeVisible();
    await expect(page.getByText('Overview snapshot')).toHaveCount(0);

    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Live help' }).click();
    await expect(camera).toBeVisible();
    await expect(camera.getByRole('complementary', { name: 'Photo help review' })).toHaveCount(0);
    await expect(camera.getByText('Overview snapshot')).toHaveCount(0);
    const audit = await request('testAudit') as any;
    expect(audit.asks).toHaveLength(0);
    expect(audit.modelCalls).toBe(0);
    expect(audit.unexpected).toEqual([]);
    await page.close();
    await expect.poll(() => desktop.exitCode, { timeout: 8000 }).toBe(0);
  } finally {
    if (desktop.exitCode === null) desktop.kill();
    if (browser) await browser.close().catch(() => undefined);
  }
});
