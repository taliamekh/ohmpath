import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('two synthetic camera paths preview together and snapshots use the selected source', async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'ohmpath-dual-camera-'));
  const requireElectron = createRequire(resolve('package.json'));
  const desktop = spawn(requireElectron('electron'), [resolve('tests/electron/dual-camera-main.cjs'), '--remote-debugging-port=0'], {
    env: { ...process.env, OHMPATH_REPLAY_DATA_DIR: dataDir }, windowsHide: true,
  });
  let browser;
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Dual-camera replay did not open')), 15000);
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
    const piAudit = () => page.evaluate(() => (window as any).ohmpath.request('testPiReplayAudit'));
    await expect(camera.getByText('Overview camera is off')).toBeVisible();
    expect((await audit()).captures).toHaveLength(0);
    expect((await audit()).asks).toHaveLength(0);
    await page.evaluate(async () => {
      const pi = document.createElement('canvas');
      pi.width = 640;
      pi.height = 360;
      const piDraw = pi.getContext('2d')!;
      piDraw.fillStyle = '#193e67';
      piDraw.fillRect(0, 0, 640, 360);
      piDraw.fillStyle = '#d68c65';
      piDraw.fillRect(250, 70, 140, 220);
      await (window as any).ohmpath.request('testPiReplaySetFrame', { jpeg_base64: pi.toDataURL('image/jpeg', .8).split(',')[1] });

      const overview = document.createElement('canvas');
      overview.width = 640;
      overview.height = 360;
      const draw = overview.getContext('2d')!;
      let frame = 0;
      window.setInterval(() => {
        draw.fillStyle = frame++ % 2 ? '#225a4f' : '#275f54';
        draw.fillRect(0, 0, 640, 360);
        draw.fillStyle = '#e5bd7e';
        draw.fillRect(155, 115, 330, 130);
      }, 70);
      (window as any).__overviewStreams = [];
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
        const stream = overview.captureStream(15);
        (window as any).__overviewStreams.push(stream);
        return stream;
      } });
      Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true,
        value: async () => [{ kind: 'videoinput', deviceId: 'synthetic-overview', label: 'Synthetic overview', groupId: 'replay' }] });
    });

    await camera.getByText('Camera setup').click();
    await camera.getByRole('button', { name: 'Enable & list cameras' }).click();
    await camera.getByLabel('Camera device').selectOption('synthetic-overview');
    await camera.getByRole('button', { name: 'Connect selected' }).click();
    const overviewVideo = camera.locator('video');
    const videoHandle = await overviewVideo.elementHandle();
    expect(videoHandle).not.toBeNull();
    await expect.poll(() => overviewVideo.evaluate((video: HTMLVideoElement) => video.videoWidth)).toBe(640);
    await camera.getByLabel('Video token').fill('synthetic-pi-token');
    await camera.getByRole('button', { name: 'Connect Pi camera' }).click();
    await camera.getByRole('button', { name: 'Both' }).click();
    const piFrame = camera.getByRole('img', { name: 'Latest Raspberry Pi camera frame' });
    await expect(piFrame).toBeVisible();
    await expect.poll(() => piFrame.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(640);

    await expect(camera.locator('.camera-workspace-stage')).toHaveClass(/stage-both/);
    await expect(overviewVideo).toBeVisible();
    await expect(piFrame).toBeVisible();
    expect(await videoHandle!.evaluate((video: HTMLVideoElement) => video.srcObject instanceof MediaStream && video.srcObject.getVideoTracks()[0].readyState === 'live')).toBe(true);
    expect((await audit()).captures).toHaveLength(0);
    expect((await audit()).asks).toHaveLength(0);
    await page.screenshot({ path: 'runtime/dual-camera-workspace.png' });

    await camera.getByRole('button', { name: 'Overview', exact: true }).click();
    await expect(overviewVideo).toBeVisible();
    await expect(piFrame).toBeHidden();
    await camera.getByRole('button', { name: 'Pi close-up' }).click();
    await expect(piFrame).toBeVisible();
    await expect(overviewVideo).toBeHidden();
    await camera.getByRole('button', { name: 'Both' }).click();
    await expect(overviewVideo).toBeVisible();
    await expect(piFrame).toBeVisible();
    expect(await videoHandle!.evaluate((video: HTMLVideoElement) => video.srcObject instanceof MediaStream && video.srcObject.getVideoTracks()[0].readyState === 'live')).toBe(true);

    await camera.getByLabel('Ask about').selectOption('overview');
    await camera.getByRole('button', { name: 'Ask about this view' }).click();
    await expect.poll(async () => (await audit()).captures.length).toBe(1);
    expect((await audit()).captures[0].source).toBe('overview');
    const review = camera.getByRole('complementary', { name: 'Photo help review' });
    await expect(review.getByText('Overview snapshot').first()).toBeVisible();
    await review.getByRole('button', { name: 'Back to camera' }).click();
    await camera.getByLabel('Ask about').selectOption('pi');
    await camera.getByRole('button', { name: 'Ask about this view' }).click();
    await expect.poll(async () => (await audit()).captures.length).toBe(2);
    expect((await audit()).captures.map((item: any) => item.source)).toEqual(['overview', 'pi']);
    const pixels = (await audit()).snapshotPixels;
    expect(pixels.map((item: any) => item.source)).toEqual(['overview', 'pi']);
    for (const [actual, expected] of [[pixels[0], { r: 229, g: 189, b: 126 }], [pixels[1], { r: 214, g: 140, b: 101 }]] as const) {
      for (const channel of ['r', 'g', 'b'] as const) expect(Math.abs(actual[channel] - expected[channel])).toBeLessThanOrEqual(24);
    }
    await expect(review.getByText('Pi snapshot').first()).toBeVisible();
    expect((await audit()).asks).toHaveLength(0);
    await review.getByRole('button', { name: 'Back to camera' }).click();

    await camera.getByRole('button', { name: 'Full screen', exact: true }).click();
    await expect(camera).toHaveClass(/is-focused/);
    await expect(overviewVideo).toBeVisible();
    await expect(piFrame).toBeVisible();
    expect(await videoHandle!.evaluate((video: HTMLVideoElement) => video.isConnected && video.srcObject instanceof MediaStream && video.srcObject.getVideoTracks()[0].readyState === 'live')).toBe(true);
    await camera.getByRole('button', { name: 'Exit full screen' }).last().click();
    await expect(camera).not.toHaveClass(/is-focused/);

    await camera.getByRole('button', { name: 'Disconnect Pi' }).click();
    await expect(piFrame).toHaveCount(0);
    await expect(camera.getByText('Pi camera is off')).toBeVisible();
    await expect(overviewVideo).toBeVisible();
    expect(await videoHandle!.evaluate((video: HTMLVideoElement) => video.srcObject instanceof MediaStream && video.srcObject.getVideoTracks()[0].readyState === 'live')).toBe(true);
    await expect(camera.getByRole('button', { name: 'Ask about this view' })).toBeDisabled();
    await camera.getByLabel('Ask about').selectOption('overview');
    await expect(camera.getByRole('button', { name: 'Ask about this view' })).toBeEnabled();
    expect((await piAudit()).connected).toBe(false);

    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Photo help' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__overviewStreams.every((stream: MediaStream) => stream.getVideoTracks()[0].readyState === 'ended'))).toBe(true);
    expect((await audit()).asks).toHaveLength(0);
    expect((await audit()).modelCalls).toBe(0);
    expect((await audit()).unexpected).toEqual([]);
    await page.close();
    await expect.poll(() => desktop.exitCode, { timeout: 8000 }).toBe(0);
  } finally {
    if (desktop.exitCode === null) desktop.kill();
    if (browser) await browser.close().catch(() => undefined);
  }
});
