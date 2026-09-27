import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('local point overlay follows synthetic video, loses obscured detail, and stops cleanly', async () => {
  const requireElectron = createRequire(resolve('package.json'));
  const dataDir = await mkdtemp(resolve(tmpdir(), 'ohmpath-vision-overlay-'));
  const desktop = spawn(requireElectron('electron'), [resolve('.'), '--remote-debugging-port=0',
    '--use-fake-device-for-media-stream', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding'], {
    env: { ...process.env, OHMPATH_HEADLESS: '1', OHMPATH_DATA_DIR: dataDir }, windowsHide: true,
  });
  let browser: import('@playwright/test').Browser | undefined;
  let page: import('@playwright/test').Page | undefined;
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Vision desktop did not open its debug endpoint.')), 20000);
      desktop.stderr.on('data', chunk => {
        const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      desktop.once('error', error => { clearTimeout(timer); reject(error); });
      desktop.once('exit', code => { clearTimeout(timer); reject(new Error(`Vision desktop exited early (${code}).`)); });
    });
    browser = await chromium.connectOverCDP(endpoint, { timeout: 12000 });
    const context = browser.contexts()[0];
    page = context.pages()[0] || await context.waitForEvent('page', { timeout: 12000 });
    page.setDefaultTimeout(12000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => {
      const base = document.createElement('canvas');
      base.width = 640; base.height = 480;
      const baseContext = base.getContext('2d')!;
      baseContext.fillStyle = '#787f83'; baseContext.fillRect(0, 0, 640, 480);
      let seed = 12345;
      for (let y = 8; y < 480; y += 8) for (let x = 8; x < 640; x += 8) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const shade = 35 + seed % 185;
        baseContext.fillStyle = `rgb(${shade},${shade},${shade})`;
        baseContext.fillRect(x, y, 7, 7);
      }
      baseContext.fillStyle = '#10131b'; baseContext.fillRect(307, 107, 26, 26);
      baseContext.fillStyle = '#fbf2d2'; baseContext.fillRect(314, 112, 12, 17);
      const source = document.createElement('canvas');
      source.width = 640; source.height = 480;
      const paintContext = source.getContext('2d')!;
      let shiftX = 0, shiftY = 0, blank = false;
      const paint = () => {
        paintContext.fillStyle = '#787f83'; paintContext.fillRect(0, 0, 640, 480);
        if (!blank) paintContext.drawImage(base, shiftX, shiftY);
      };
      paint();
      const timer = window.setInterval(paint, 67);
      const streams: MediaStream[] = [];
      Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true,
        value: async () => [{ kind: 'videoinput', deviceId: 'vision-canvas', label: 'Synthetic detailed board', groupId: 'vision' }] });
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true,
        value: async (constraints: MediaStreamConstraints) => {
          if (!constraints.video || constraints.audio) throw new Error('Only synthetic silent video is allowed.');
          const stream = source.captureStream(15); streams.push(stream); return stream;
        } });
      const originalDataUrl = HTMLCanvasElement.prototype.toDataURL;
      let visionEncodes = 0, rejectNextVisionFrame = false;
      HTMLCanvasElement.prototype.toDataURL = function (...args) {
        if (this !== source && this.width === 640 && this.height === 480 && args[0] === 'image/jpeg') {
          visionEncodes += 1;
          if (rejectNextVisionFrame) {
            rejectNextVisionFrame = false;
            // Valid data URL framing sends this through IPC; the local backend rejects the incomplete JPEG.
            return 'data:image/jpeg;base64,AAAA';
          }
        }
        return originalDataUrl.apply(this, args);
      };
      const originalUuid = crypto.randomUUID.bind(crypto);
      const visionIds: string[] = [];
      Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => {
        const id = originalUuid(); visionIds.push(id); return id;
      } });
      (window as any).__visionReplay = {
        source, streams, visionIds,
        shift: (x: number, y: number) => { shiftX = x; shiftY = y; paint(); },
        blank: (value: boolean) => { blank = value; paint(); },
        encodes: () => visionEncodes,
        failNextFrame: () => { rejectNextVisionFrame = true; },
        stop: () => { window.clearInterval(timer); streams.forEach(stream => stream.getTracks().forEach(track => track.stop())); },
      };
    });
    const camera = page.getByRole('region', { name: 'Camera workspace' });
    await camera.getByText('Camera setup').click();
    await camera.getByRole('button', { name: 'Enable & list cameras' }).click();
    await camera.getByLabel('Camera device').selectOption('vision-canvas');
    await camera.getByRole('button', { name: 'Turn on overview' }).click();
    await expect.poll(() => camera.locator('video').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBe(640);
    const overlay = camera.locator('.camera-workspace-overview .vision-overlay-target');
    await expect(overlay).toHaveCount(0); // No continuous vision before opt-in.
    const beforeOptIn = await page.evaluate(() => (window as any).__visionReplay.encodes());
    await page.waitForTimeout(350);
    expect(await page.evaluate(() => (window as any).__visionReplay.encodes())).toBe(beforeOptIn);

    await camera.getByRole('button', { name: 'Track a point locally' }).click();
    await expect(overlay).toBeVisible();
    await overlay.press('Enter'); // Explicit center selection.
    await expect(camera.getByText('Following selected point')).toBeVisible({ timeout: 10000 });
    const ring = () => overlay.evaluate((canvas: HTMLCanvasElement) => {
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0, sumX = 0, sumY = 0;
      for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
        const index = (y * canvas.width + x) * 4;
        if (data[index] > 220 && data[index + 1] > 175 && data[index + 2] < 180 && data[index + 3] > 0) {
          count += 1; sumX += x; sumY += y;
        }
      }
      return { count, x: count ? sumX / count / (canvas.width / canvas.clientWidth) : null,
        y: count ? sumY / count / (canvas.height / canvas.clientHeight) : null,
        width: canvas.clientWidth, height: canvas.clientHeight };
    });
    await expect.poll(async () => (await ring()).count).toBeGreaterThan(20);
    const initial = await ring();
    await page.evaluate(() => (window as any).__visionReplay.shift(18, 12));
    await expect.poll(async () => (await ring()).x ?? 0, { timeout: 10000 }).toBeGreaterThan((initial.x ?? 0) + 4);
    await expect.poll(async () => (await ring()).y ?? 0, { timeout: 10000 }).toBeGreaterThan((initial.y ?? 0) + 3);

    await camera.getByRole('button', { name: 'Full screen', exact: true }).click();
    await expect(camera).toHaveClass(/is-focused/);
    await expect.poll(async () => (await ring()).count).toBeGreaterThan(20);
    const focused = await ring();
    expect((focused.x ?? 0) / focused.width).toBeGreaterThan(0.42);
    expect((focused.x ?? 0) / focused.width).toBeLessThan(0.60);
    expect((focused.y ?? 0) / focused.height).toBeGreaterThan(0.40);
    expect((focused.y ?? 0) / focused.height).toBeLessThan(0.60);
    await camera.getByRole('button', { name: 'Exit full screen' }).last().click();
    await expect(camera).not.toHaveClass(/is-focused/);

    await page.evaluate(() => (window as any).__visionReplay.failNextFrame());
    await expect(camera.getByText('Local tracking stopped after an error. Select a clear point again.')).toBeVisible({ timeout: 10000 });
    await expect.poll(async () => (await ring()).count).toBe(0);
    const encodesAtFault = await page.evaluate(() => (window as any).__visionReplay.encodes());
    await page.waitForTimeout(550);
    expect(await page.evaluate(() => (window as any).__visionReplay.encodes())).toBe(encodesAtFault);
    await overlay.press('Enter');
    await expect(camera.getByText('Following selected point')).toBeVisible({ timeout: 10000 });
    await expect.poll(async () => (await ring()).count).toBeGreaterThan(20);

    await page.evaluate(() => (window as any).__visionReplay.blank(true));
    await expect(camera.getByText('Following selected point')).toHaveCount(0, { timeout: 10000 });
    await expect.poll(async () => (await ring()).count).toBe(0);
    const contextId = await page.evaluate(() => (window as any).__visionReplay.visionIds.at(-1));
    expect(contextId).toMatch(/^[0-9a-f-]{36}$/);
    await camera.getByRole('button', { name: 'Stop visual tracking' }).click();
    await expect(overlay).toHaveCount(0);
    const countAtStop = await page.evaluate(() => (window as any).__visionReplay.encodes());
    await page.waitForTimeout(550);
    expect(await page.evaluate(() => (window as any).__visionReplay.encodes())).toBe(countAtStop);
    const resetResult = await page.evaluate(async id => {
      const image_base64 = (window as any).__visionReplay.source.toDataURL('image/jpeg', .7).split(',')[1];
      return await (window as any).ohmpath.request('visionFrame', {
        context_id: id, source: 'overview', sequence: 1, image_base64,
      });
    }, contextId);
    expect(resetResult.status).toBe('idle');
    expect(resetResult.target).toBeNull();

    await page.evaluate(() => (window as any).__visionReplay.blank(false));
    await camera.getByRole('button', { name: 'Track a point locally' }).click();
    await expect(overlay).toBeVisible();
    await overlay.press('Enter');
    await expect(camera.getByText('Following selected point')).toBeVisible({ timeout: 10000 });
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Photo help' }).click();
    await expect(overlay).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).__visionReplay.streams.every(
      (stream: MediaStream) => stream.getVideoTracks()[0].readyState === 'ended'))).toBe(true);
    expect(errors).toEqual([]);
    await page.evaluate(() => (window as any).__visionReplay.stop());
    await page.close();
    await expect.poll(() => desktop.exitCode, { timeout: 12000 }).toBe(0);
  } finally {
    if (page && !page.isClosed()) await page.evaluate(() => (window as any).__visionReplay?.stop()).catch(() => undefined);
    if (desktop.exitCode === null) desktop.kill();
    if (browser) await browser.close().catch(() => undefined);
  }
});
