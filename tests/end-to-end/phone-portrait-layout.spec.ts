import { test, expect, chromium, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

async function geometry(page: Page) {
  return page.locator('.camera-workspace').evaluate(workspace => {
    const stage = workspace.querySelector('.camera-workspace-stage')!;
    const feed = workspace.querySelector('.camera-workspace-overview')!;
    const video = feed.querySelector('video')!;
    const ask = workspace.querySelector('.camera-workspace-ask')!;
    const stageBox = stage.getBoundingClientRect();
    const feedBox = feed.getBoundingClientRect();
    const videoBox = video.getBoundingClientRect();
    const askBox = ask.getBoundingClientRect();
    const scale = Math.min(videoBox.width / video.videoWidth, videoBox.height / video.videoHeight);
    return {
      stage: { width: stageBox.width, height: stageBox.height, bottom: stageBox.bottom },
      feed: { width: feedBox.width, height: feedBox.height },
      video: { width: videoBox.width, height: videoBox.height,
        decodedWidth: video.videoWidth, decodedHeight: video.videoHeight,
        visibleWidth: video.videoWidth * scale, visibleHeight: video.videoHeight * scale,
        objectFit: getComputedStyle(video).objectFit },
      askTop: askBox.top,
    };
  });
}

test('portrait and landscape phone frames stay inside the camera stage and full-screen view', async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'ohmpath-phone-portrait-'));
  const requireHere = createRequire(resolve('package.json'));
  const desktop = spawn(requireHere('electron'), [resolve('tests/electron/phone-live-main.cjs'), '--remote-debugging-port=0'], {
    env: { ...process.env, OHMPATH_REPLAY_DATA_DIR: dataDir }, windowsHide: true,
  });
  let browser;
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Phone live layout replay did not open')), 15000);
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
      const context = canvas.getContext('2d')!;
      let frame = 0;
      const timer = window.setInterval(() => {
        context.fillStyle = frame++ % 2 ? '#163d30' : '#315c45';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#e3cf94';
        context.fillRect(120, 200, 840, 900);
      }, 33);
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true,
        value: async () => {
          const stream = canvas.captureStream(30);
          stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
          return stream;
        } });
    });
    await phone.getByRole('button', { name: 'Start rear camera' }).click();
    await expect(phone.getByRole('status')).toHaveText('Live on your laptop. Keep this page open.', { timeout: 30000 });
    const video = camera.locator('.camera-workspace-overview video');
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.videoHeight), { timeout: 30000 }).toBeGreaterThan(1000);
    const portrait = await geometry(laptop);
    expect(portrait.video.decodedHeight).toBeGreaterThan(portrait.video.decodedWidth);
    expect(portrait.stage.height).toBeLessThanOrEqual(481);
    expect(portrait.feed.height).toBeLessThanOrEqual(portrait.stage.height);
    expect(portrait.video.height).toBeLessThanOrEqual(portrait.feed.height);
    expect(portrait.video.objectFit).toBe('contain');
    expect(portrait.video.visibleWidth / portrait.video.visibleHeight).toBeCloseTo(
      portrait.video.decodedWidth / portrait.video.decodedHeight, 3);
    expect(portrait.video.width - portrait.video.visibleWidth).toBeGreaterThan(100);
    expect(portrait.askTop).toBeGreaterThanOrEqual(portrait.stage.bottom);
    await expect(camera.getByRole('button', { name: 'Ask about this view' })).toBeVisible();

    await laptop.setViewportSize({ width: 800, height: 900 });
    await camera.getByRole('button', { name: 'Both', exact: true }).click();
    const both = await geometry(laptop);
    expect(both.stage.height).toBeLessThanOrEqual(721);
    expect(both.feed.height).toBeLessThanOrEqual(both.stage.height);
    const rows = await camera.locator('.camera-workspace-stage').evaluate(stage => {
      const first = stage.querySelector('.camera-workspace-overview')!.getBoundingClientRect();
      const second = stage.querySelector('.camera-workspace-pi')!.getBoundingClientRect();
      return { firstBottom: first.bottom, secondTop: second.top, secondBottom: second.bottom,
        stageBottom: stage.getBoundingClientRect().bottom };
    });
    expect(rows.secondTop).toBeGreaterThanOrEqual(rows.firstBottom);
    expect(rows.secondBottom).toBeLessThanOrEqual(rows.stageBottom);
    await camera.getByRole('button', { name: 'Overview', exact: true }).click();
    await camera.getByRole('button', { name: 'Full screen', exact: true }).click();
    await expect(camera).toHaveClass(/is-focused/);
    const focused = await geometry(laptop);
    expect(focused.stage.height).toBeGreaterThan(100);
    expect(focused.stage.height).toBeLessThanOrEqual(laptop.viewportSize()?.height ?? 900);
    expect(focused.video.height).toBeLessThanOrEqual(focused.stage.height);
    expect(focused.video.objectFit).toBe('contain');
    await camera.getByRole('button', { name: 'Exit full screen', exact: true }).first().click();

    // A second synthetic canvas exercises the same preview element at landscape dimensions.
    await video.evaluate(async (element: HTMLVideoElement) => {
      const original = element.srcObject;
      const canvas = document.createElement('canvas');
      canvas.width = 1920; canvas.height = 1080;
      canvas.getContext('2d')!.fillRect(0, 0, canvas.width, canvas.height);
      const landscape = canvas.captureStream(30);
      (window as any).__layoutStreams = { original, landscape };
      element.srcObject = landscape;
      await element.play();
    });
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.videoWidth)).toBe(1920);
    const landscape = await geometry(laptop);
    expect(landscape.video.decodedWidth).toBeGreaterThan(landscape.video.decodedHeight);
    expect(landscape.stage.height).toBeLessThanOrEqual(481);
    expect(landscape.video.height).toBeLessThanOrEqual(landscape.feed.height);
    expect(landscape.video.objectFit).toBe('contain');
    expect(landscape.video.visibleWidth / landscape.video.visibleHeight).toBeCloseTo(16 / 9, 3);
    expect(landscape.askTop).toBeGreaterThanOrEqual(landscape.stage.bottom);
    await video.evaluate((element: HTMLVideoElement) => {
      const streams = (window as any).__layoutStreams;
      element.srcObject = streams.original;
      streams.landscape.getTracks().forEach((track: MediaStreamTrack) => track.stop());
    });
    await camera.getByRole('button', { name: 'Disconnect phone', exact: true }).click();
  } finally {
    await browser?.close().catch(() => undefined);
    desktop.kill();
  }
});
