import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('one pairing page supports two explicit WebRTC camera sessions without automatic analysis', async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'ohmpath-phone-live-'));
  const requireHere = createRequire(resolve('package.json'));
  const desktop = spawn(requireHere('electron'), [resolve('tests/electron/phone-live-main.cjs'), '--remote-debugging-port=0'], {
    env: { ...process.env, OHMPATH_REPLAY_DATA_DIR: dataDir }, windowsHide: true,
  });
  let browser;
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Phone live replay did not open')), 15000);
      desktop.stderr.on('data', chunk => {
        const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      desktop.once('error', error => { clearTimeout(timer); reject(error); });
    });
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    const laptop = context.pages()[0] || await context.waitForEvent('page');
    const camera = laptop.getByRole('region', { name: 'Camera workspace' });
    await camera.getByRole('button', { name: 'Connect phone camera', exact: true }).click();
    const qr = camera.getByRole('img', { name: 'Scan to connect your phone camera to Ohm Path' });
    await expect(qr).toBeVisible({ timeout: 20000 });
    const firstCode = await qr.getAttribute('src');
    expect(firstCode).toMatch(/^data:image\/png;base64,/);
    await laptop.evaluate(() => (window as any).ohmpath.request('testPhoneOpen'));
    const phone = context.pages().find(page => page.url().startsWith('http://127.0.0.1:'))!;
    expect(phone).toBeTruthy();
    const errors: string[] = [];
    phone.on('pageerror', error => errors.push(error.message));
    await phone.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 1920; canvas.height = 1080;
      const draw = canvas.getContext('2d')!;
      let frame = 0;
      const timer = window.setInterval(() => {
        draw.fillStyle = frame++ % 2 ? '#203b2f' : '#244333';
        draw.fillRect(0, 0, canvas.width, canvas.height);
        draw.fillStyle = '#efd99a';
        draw.fillRect(400, 200, 800, 400);
        draw.font = '60px sans-serif'; draw.fillText('Synthetic circuit ' + frame, 500, 800);
      }, 33);
      (window as any).__syntheticStreams = [];
      (window as any).__mediaRequests = [];
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async (constraints: unknown) => {
        (window as any).__mediaRequests.push(constraints);
        const stream = canvas.captureStream(30);
        (window as any).__syntheticStreams.push(stream);
        stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
        return stream;
      } });
    });
    await phone.getByRole('button', { name: 'Start rear camera' }).click();
    await expect(phone.getByRole('status')).toHaveText('Live on your laptop. Keep this page open.', { timeout: 25000 });
    await expect(camera.getByRole('button', { name: 'Disconnect phone', exact: true })).toBeVisible({ timeout: 15000 });
    const video = camera.locator('video');
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.videoWidth), { timeout: 30000 }).toBe(1920);
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.videoHeight)).toBe(1080);
    const before = await video.evaluate((element: HTMLVideoElement) => element.currentTime);
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(before + .5);
    const audit = await laptop.evaluate(() => (window as any).ohmpath.request('testAudit'));
    expect(audit.captures).toHaveLength(0);
    expect(audit.asks).toHaveLength(0);
    expect(await phone.evaluate(() => (window as any).__mediaRequests[0].audio)).toBe(false);
    await camera.getByRole('button', { name: 'Full screen', exact: true }).click();
    await expect(camera).toHaveClass(/is-focused/);
    await camera.getByRole('button', { name: 'Exit full screen', exact: true }).first().click();
    await camera.getByRole('button', { name: 'Ask about this view' }).click();
    await expect.poll(async () => (await laptop.evaluate(() => (window as any).ohmpath.request('testAudit'))).captures.length).toBe(1);
    const captureAudit = await laptop.evaluate(() => (window as any).ohmpath.request('testAudit'));
    expect(captureAudit.captures[0]).toMatchObject({ width: 1920, height: 1080, source: 'overview' });
    // Opening the review must not submit a model question automatically.
    expect(captureAudit.asks).toHaveLength(0);
    await camera.getByRole('button', { name: 'Back to camera', exact: true }).click();
    await phone.getByRole('button', { name: 'Stop camera', exact: true }).click();
    await expect(phone.getByRole('button', { name: 'Start rear camera' })).toBeEnabled();
    await expect(camera.getByRole('button', { name: 'Connect phone camera', exact: true })).toBeVisible({ timeout: 15000 });
    await expect(qr).toBeVisible();
    expect(await qr.getAttribute('src')).toBe(firstCode);
    await camera.getByRole('button', { name: 'Connect phone camera', exact: true }).click();
    await expect(camera.getByRole('button', { name: 'Cancel phone connection', exact: true })).toBeVisible();
    expect(await qr.getAttribute('src')).toBe(firstCode);
    await phone.getByRole('button', { name: 'Start rear camera' }).click();
    await expect(phone.getByRole('status')).toHaveText('Live on your laptop. Keep this page open.', { timeout: 25000 });
    await expect(camera.getByRole('button', { name: 'Disconnect phone', exact: true })).toBeVisible({ timeout: 15000 });
    await expect.poll(() => phone.evaluate(() => (window as any).__syntheticStreams.length)).toBe(2);
    expect((await laptop.evaluate(() => (window as any).ohmpath.request('testAudit'))).asks).toHaveLength(0);
    await camera.getByRole('button', { name: 'Disconnect phone', exact: true }).click();
    await expect.poll(() => phone.evaluate(() => (window as any).__syntheticStreams.every((stream: MediaStream) => stream.getTracks().every(track => track.readyState === 'ended'))), { timeout: 25000 }).toBe(true);
    await expect(camera.getByText('Overview camera is off')).toBeVisible();
    const final = await laptop.evaluate(() => (window as any).ohmpath.request('testPhoneAudit'));
    expect(final.active).toBe(false);
    expect(final.tunnelStops).toBe(0);
    expect(final.requests.every((value: string) => /^(GET \/(?:session|favicon.ico)?|POST \/(?:answer|stop))$/.test(value))).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close().catch(() => undefined);
    desktop.kill();
  }
});
