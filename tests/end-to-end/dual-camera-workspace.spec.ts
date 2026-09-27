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
    page.setDefaultTimeout(8000);
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
      (window as any).__tiltBoard = false;
      const draw = overview.getContext('2d')!;
      let frame = 0;
      window.setInterval(() => {
        if ((window as any).__tiltBoard) {
          draw.fillStyle = '#344849'; draw.fillRect(0, 0, 640, 360);
          draw.save(); draw.translate(320, 180); draw.rotate(17 * Math.PI / 180);
          draw.fillStyle = '#c2c8ac'; draw.fillRect(-170, -105, 340, 210);
          draw.fillStyle = '#354b42';
          for (let y = -96; y < 97; y += 11) for (let x = -160; x < 161; x += 11) draw.fillRect(x, y, 4, 4);
          draw.strokeStyle = '#29473f'; draw.lineWidth = 3;
          for (let x = -150; x <= 150; x += 25) { draw.beginPath(); draw.moveTo(x, -95); draw.lineTo(x, 95); draw.stroke(); }
          for (let y = -90; y <= 90; y += 22) { draw.beginPath(); draw.moveTo(-160, y); draw.lineTo(160, y); draw.stroke(); }
          draw.restore(); return;
        }
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
    await camera.getByRole('button', { name: 'Turn on overview camera' }).click();
    const overviewVideo = camera.locator('video');
    const videoHandle = await overviewVideo.elementHandle();
    expect(videoHandle).not.toBeNull();
    await expect.poll(() => overviewVideo.evaluate((video: HTMLVideoElement) => video.videoWidth)).toBe(640);
    await camera.getByRole('button', { name: 'Turn on Turret camera' }).click();
    const piFrame = camera.getByRole('img', { name: 'Latest Turret camera frame' });
    await expect(piFrame).toBeVisible();
    await expect.poll(() => piFrame.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(640);

    await expect(camera.locator('.camera-workspace-stage')).toHaveClass(/stage-both/);
    await expect(overviewVideo).toBeVisible();
    await expect(piFrame).toBeVisible();
    expect(await videoHandle!.evaluate((video: HTMLVideoElement) => video.srcObject instanceof MediaStream && video.srcObject.getVideoTracks()[0].readyState === 'live')).toBe(true);
    expect((await audit()).captures).toHaveLength(0);
    expect((await audit()).asks).toHaveLength(0);
    await page.screenshot({ path: 'runtime/dual-camera-workspace.png' });

    // Real Electron layout with synthetic cameras: no installed Playwright browser needed.
    const header = camera.locator('.camera-workspace-head-actions');
    const helper = header.getByRole('button', { name: 'Toggle helper' });
    const sessions = header.locator('summary').filter({ hasText: 'Saved sessions' });
    const fullscreen = header.getByRole('button', { name: 'Full screen', exact: true });
    const controls = camera.getByRole('navigation', { name: 'Live help camera controls' });
    for (const width of [1280, 1366, 768]) {
      await page.setViewportSize({ width, height: 900 });
      const boxes = await Promise.all([helper, sessions, fullscreen].map(locator => locator.boundingBox()));
      expect(boxes.every(Boolean)).toBe(true);
      expect(boxes[0]!.x + boxes[0]!.width).toBeLessThanOrEqual(boxes[1]!.x + 1);
      expect(boxes[1]!.x + boxes[1]!.width).toBeLessThanOrEqual(boxes[2]!.x + 1);
      expect(boxes[2]!.x - boxes[1]!.x - boxes[1]!.width).toBeLessThanOrEqual(12);
      expect(Math.abs(boxes[0]!.y - boxes[2]!.y)).toBeLessThan(15);
      expect(await controls.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      expect(await controls.locator('button').evaluateAll((buttons, viewportWidth) => buttons.every(button => {
        const box = button.getBoundingClientRect();
        return box.left >= 0 && box.right <= Number(viewportWidth) + 1;
      }), width)).toBe(true);
      expect(await controls.locator('button').evaluateAll(buttons => {
        const boxes = buttons.map(button => button.getBoundingClientRect());
        return boxes.every((a, i) => boxes.slice(i + 1).every(b => a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1));
      })).toBe(true);
      expect(await page.locator('.sidebar').evaluate(element => getComputedStyle(element).borderRightWidth)).toBe('0px');
    }
    await expect(controls.locator('input[type="range"]')).toHaveCount(0);
    await expect(controls.locator('.camera-view-option')).toHaveCount(2);
    await controls.getByRole('button', { name: 'Full camera view', exact: true }).click();
    await expect(controls.getByRole('button', { name: 'Full camera view', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await controls.getByRole('button', { name: 'Close-up view', exact: true }).click();
    await expect(controls.getByRole('button', { name: 'Close-up view', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(controls.getByRole('button', { name: 'Full camera view', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await controls.getByRole('button', { name: 'Full camera view', exact: true }).click();
    expect(await videoHandle!.evaluate((video: HTMLVideoElement) => video.srcObject instanceof MediaStream && video.srcObject.getVideoTracks()[0].readyState === 'live')).toBe(true);
    expect((await piAudit()).connected).toBe(true);
    await helper.click();
    await expect(camera.getByLabel('Guide companion')).toHaveCount(0);
    await helper.click();
    await expect(camera.getByLabel('Guide companion')).toBeVisible();
    await sessions.click();
    await expect(header.getByLabel('SESSION', { exact: true })).toBeVisible();
    await sessions.click();
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.screenshot({ path: 'runtime/live-help-toolbar.png' });

    await expect(camera.getByRole('group', { name: 'Camera layout' })).toHaveCount(0);
    expect(await videoHandle!.evaluate((video: HTMLVideoElement) => video.srcObject instanceof MediaStream && video.srcObject.getVideoTracks()[0].readyState === 'live')).toBe(true);

    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Photo help' }).click();
    await page.getByRole('button', { name: 'Take photo from live overview' }).click();
    await expect.poll(async () => (await audit()).captures.length).toBe(1);
    expect((await audit()).captures[0].source).toBe('overview');
    await expect(page.locator('.photo-help-page').getByText('Overview snapshot').first()).toBeVisible();
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Live help' }).click();
    await camera.getByRole('button', { name: 'Turn off overview camera' }).click();
    await expect(camera.getByRole('button', { name: 'Turn on overview camera' })).toBeEnabled();
    expect((await audit()).captures.map((item: any) => item.source)).toEqual(['overview']);
    const pixels = (await audit()).snapshotPixels;
    expect(pixels.map((item: any) => item.source)).toEqual(['overview']);
    for (const [actual, expected] of [[pixels[0], { r: 229, g: 189, b: 126 }]] as const) {
      for (const channel of ['r', 'g', 'b'] as const) expect(Math.abs(actual[channel] - expected[channel])).toBeLessThanOrEqual(24);
    }
    expect((await audit()).asks).toHaveLength(0);
    await camera.getByRole('button', { name: 'Turn on overview camera' }).click();
    await expect(camera.locator('.camera-workspace-stage')).toHaveClass(/stage-both/);

    await page.evaluate(() => { (window as any).__tiltBoard = true; });
    await expect.poll(() => camera.locator('.camera-workspace-aligned').evaluate((element: HTMLElement) => element.style.transform), { timeout: 7500 }).toMatch(/rotate\(-1[0-9].*scale\(1\.[1-9]/);
    await expect(camera.getByText(/Display rotated/)).toBeVisible();

    await camera.getByRole('button', { name: 'Full screen', exact: true }).click();
    await expect(camera).toHaveClass(/is-focused/);
    await expect(overviewVideo).toBeVisible();
    await expect(piFrame).toBeVisible();
    expect(await videoHandle!.evaluate((video: HTMLVideoElement) => video.isConnected && video.srcObject instanceof MediaStream && video.srcObject.getVideoTracks()[0].readyState === 'live')).toBe(true);
    await camera.getByRole('button', { name: 'Exit full screen' }).last().click();
    await expect(camera).not.toHaveClass(/is-focused/);

    await camera.getByRole('button', { name: 'Turn off Turret camera' }).click();
    await expect(piFrame).toHaveCount(0);
    await expect(camera.locator('.camera-workspace-stage')).toHaveClass(/stage-overview/);
    await expect(overviewVideo).toBeVisible();
    expect(await videoHandle!.evaluate((video: HTMLVideoElement) => video.srcObject instanceof MediaStream && video.srcObject.getVideoTracks()[0].readyState === 'live')).toBe(true);
    await expect(camera.getByRole('button', { name: 'Take photo from live overview' })).toHaveCount(0);
    expect((await piAudit()).connected).toBe(false);

    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Photo help' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__overviewStreams.some((stream: MediaStream) => stream.getVideoTracks()[0].readyState === 'live'))).toBe(true);
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Live help' }).click();
    await camera.getByRole('button', { name: 'Turn on Turret camera' }).click();
    await expect.poll(async () => (await piAudit()).connected).toBe(true);
    await expect(page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Turret' })).toHaveCount(0);
    await expect.poll(async () => (await piAudit()).connected).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).__overviewStreams.some((stream: MediaStream) => stream.getVideoTracks()[0].readyState === 'live'))).toBe(true);
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
