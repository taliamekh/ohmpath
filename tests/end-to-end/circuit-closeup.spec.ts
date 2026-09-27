import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('portrait phone circuit gets a reversible close-up while its complete snapshot stays intact', async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'ohmpath-closeup-'));
  const requireHere = createRequire(resolve('package.json'));
  const desktop = spawn(requireHere('electron'), [resolve('tests/electron/phone-live-main.cjs'), '--remote-debugging-port=0'], {
    env: { ...process.env, OHMPATH_REPLAY_DATA_DIR: dataDir }, windowsHide: true,
  });
  let browser;
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Phone close-up replay did not open')), 15000);
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
    await expect(camera.getByRole('img', { name: 'Scan to connect your phone camera to Ohm Path' })).toBeVisible({ timeout: 20000 });
    await laptop.evaluate(() => (window as any).ohmpath.request('testPhoneOpen'));
    const phone = context.pages().find(page => page.url().startsWith('http://127.0.0.1:'))!;
    expect(phone).toBeTruthy();
    await phone.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 1080; canvas.height = 1920;
      const draw = canvas.getContext('2d')!;
      const paint = () => {
        draw.fillStyle = '#b8aa92'; draw.fillRect(0, 0, 1080, 1920);
        // Long loose cables should not become the framing target.
        draw.strokeStyle = '#43372f'; draw.lineWidth = 9;
        draw.beginPath(); draw.moveTo(80, 80); draw.bezierCurveTo(140, 460, 250, 800, 160, 1160); draw.stroke();
        draw.beginPath(); draw.moveTo(930, 150); draw.bezierCurveTo(880, 600, 980, 850, 890, 1130); draw.stroke();
        draw.fillStyle = '#edeae1'; draw.fillRect(155, 1290, 535, 270);
        draw.fillStyle = '#266494'; draw.fillRect(720, 1330, 260, 205);
        for (let y = 1305; y < 1550; y += 24) for (let x = 173; x < 675; x += 24) {
          draw.fillStyle = '#77756e'; draw.fillRect(x, y, 8, 8);
        }
        for (let y = 1345; y < 1525; y += 23) for (let x = 735; x < 969; x += 23) {
          draw.fillStyle = '#d5d4a8'; draw.fillRect(x, y, 9, 9);
        }
      };
      paint();
      const timer = window.setInterval(paint, 100);
      (window as any).__closeupStreams = [];
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
        const stream = canvas.captureStream(15);
        (window as any).__closeupStreams.push(stream);
        stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
        return stream;
      } });
    });
    await phone.getByRole('button', { name: 'Start rear camera' }).click();
    await expect(phone.getByRole('status')).toHaveText('Live on your laptop. Keep this page open.', { timeout: 30000 });
    const video = camera.locator('.camera-workspace-overview video');
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.videoHeight), { timeout: 30000 }).toBe(1920);
    let audit = await laptop.evaluate(() => (window as any).ohmpath.request('testAudit'));
    expect(audit.captures).toHaveLength(0);
    expect(audit.asks).toHaveLength(0);

    await camera.getByRole('button', { name: 'Ask about this view' }).click();
    await expect.poll(async () => (await laptop.evaluate(() => (window as any).ohmpath.request('testAudit'))).captures.length).toBe(1);
    await expect(camera.locator('.camera-workspace-overview .camera-framing')).toHaveAttribute('data-focused', 'true');
    const review = camera.getByRole('region', { name: 'Selected image' });
    const wrap = review.locator('.photo-help-image-wrap');
    await expect(wrap).toHaveAttribute('data-closeup', 'true');
    await expect(review.getByText('1080 × 1920', { exact: false })).toBeVisible();
    const photo = review.locator('.photo-help-image-coordinates img');
    await expect.poll(() => photo.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([1080, 1920]);
    const closeup = await review.locator('.photo-help-image-coordinates').evaluate(element => ({
      left: parseFloat((element as HTMLElement).style.left),
      top: parseFloat((element as HTMLElement).style.top),
      width: parseFloat((element as HTMLElement).style.width),
      height: parseFloat((element as HTMLElement).style.height),
    }));
    expect(closeup.width).toBeGreaterThan(100);
    expect(closeup.height).toBeGreaterThan(100);
    expect(closeup.top).toBeLessThan(-100); // Target lies in the lower part of the portrait.
    audit = await laptop.evaluate(() => (window as any).ohmpath.request('testAudit'));
    expect(audit.captures[0]).toMatchObject({ source: 'overview', width: 1080, height: 1920 });
    expect(audit.asks).toHaveLength(0);
    expect(audit.modelCalls).toBe(0);
    await camera.getByRole('button', { name: 'Back to camera', exact: true }).click();
    await laptop.screenshot({ path: resolve('runtime/circuit-closeup-preview.png'), animations: 'disabled', timeout: 10000 });
    await camera.getByRole('button', { name: 'Continue this question', exact: true }).click();

    await review.getByRole('button', { name: 'Whole image' }).click();
    await expect(wrap).toHaveAttribute('data-closeup', 'false');
    await expect(photo).toBeVisible();
    await review.getByRole('button', { name: 'Circuit close-up' }).click();
    await expect(wrap).toHaveAttribute('data-closeup', 'true');
    await camera.getByRole('button', { name: 'Back to camera', exact: true }).click();
    await camera.getByRole('button', { name: 'Whole camera view' }).click();
    await expect(camera.locator('.camera-workspace-overview .camera-framing')).toHaveAttribute('data-focused', 'false');
    await camera.getByRole('button', { name: 'Ask about this view' }).click();
    await expect.poll(async () => (await laptop.evaluate(() => (window as any).ohmpath.request('testAudit'))).captures.length).toBe(2);
    await expect(camera.locator('.camera-workspace-overview .camera-framing')).toHaveAttribute('data-focused', 'false');
    await expect(wrap).toHaveAttribute('data-closeup', 'false');
    await expect(review.getByRole('button', { name: 'Whole image' })).toHaveCount(0);
    await camera.getByRole('button', { name: 'Back to camera', exact: true }).click();

    // The manual picker must ignore blank letterbox space in the whole portrait view.
    await camera.getByRole('button', { name: 'Choose close-up', exact: true }).click();
    const picker = camera.getByRole('button', { name: 'Choose the center of the circuit close-up' });
    const pickerBox = await picker.boundingBox();
    expect(pickerBox).toBeTruthy();
    await picker.click({ position: { x: 3, y: pickerBox!.height / 2 } });
    await expect(camera.getByRole('button', { name: 'Cancel close-up selection' })).toBeVisible();
    await picker.click({ position: { x: pickerBox!.width / 2, y: pickerBox!.height / 2 } });
    await expect(camera.getByRole('button', { name: 'Choose close-up', exact: true })).toBeVisible();
    await expect(camera.locator('.camera-workspace-overview .camera-framing')).toHaveAttribute('data-focused', 'true');
    const framing = camera.locator('.camera-workspace-overview .camera-framing-media');
    const manualBox = await framing.getAttribute('style');
    expect(manualBox).toBeTruthy();
    await camera.getByRole('button', { name: 'Ask about this view' }).click();
    await expect.poll(async () => (await laptop.evaluate(() => (window as any).ohmpath.request('testAudit'))).captures.length).toBe(3);
    await expect(framing).toHaveAttribute('style', manualBox!);
    await expect(wrap).toHaveAttribute('data-closeup', 'true');
    await camera.getByRole('button', { name: 'Back to camera', exact: true }).click();
    await camera.getByRole('button', { name: 'Ask about this view' }).click();
    await expect.poll(async () => (await laptop.evaluate(() => (window as any).ohmpath.request('testAudit'))).captures.length).toBe(4);
    await expect(framing).toHaveAttribute('style', manualBox!);
    await expect(wrap).toHaveAttribute('data-closeup', 'true');
    // The fourth snapshot exceeds the three-image review limit, but the local
    // framing and full-resolution capture still survive another Ask.
    await expect(camera.getByRole('alert')).toContainText('Three images are already open.');
    audit = await laptop.evaluate(() => (window as any).ohmpath.request('testAudit'));
    expect(audit.captures).toHaveLength(4);
    expect(audit.captures.every((capture: {width: number; height: number}) => capture.width === 1080 && capture.height === 1920)).toBe(true);
    expect(audit.asks).toHaveLength(0);
    expect(audit.modelCalls).toBe(0);
    await camera.getByRole('button', { name: 'Back to camera', exact: true }).click();
    await camera.getByRole('button', { name: 'Disconnect phone', exact: true }).click();
    await expect.poll(() => phone.evaluate(() => (window as any).__closeupStreams.every((stream: MediaStream) =>
      stream.getTracks().every(track => track.readyState === 'ended'))), { timeout: 25000 }).toBe(true);
  } finally {
    await browser?.close().catch(() => undefined);
    desktop.kill();
  }
});
