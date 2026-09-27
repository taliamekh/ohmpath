import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('camera focus keeps a synthetic preview mounted through snapshot and review', async () => {
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
    // Retained standalone Photo help coexists with the camera review drawer.
    await page.getByRole('button', { name: 'Photo help', exact: false }).first().click();
    await expect(page.getByLabel('What would you like help with?')).toBeVisible();
    await page.getByRole('button', { name: 'Live help', exact: false }).first().click();
    const camera = page.getByRole('region', { name: 'Camera workspace' });
    await expect(camera.getByText('Overview camera is off')).toBeVisible();
    const video = await camera.locator('video').elementHandle();
    expect(video).not.toBeNull();
    expect(await video!.evaluate((node: HTMLVideoElement) => node.srcObject)).toBeNull();
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const draw = canvas.getContext('2d')!;
      let frame = 0;
      window.setInterval(() => {
        draw.fillStyle = frame++ % 2 ? '#163c3e' : '#204b46';
        draw.fillRect(0, 0, 640, 360);
        draw.fillStyle = '#edc887';
        draw.fillRect(170, 110, 300, 140);
        draw.fillStyle = '#c55a55';
        draw.fillRect(270, 160, 45, 42);
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
    await expect.poll(() => video!.evaluate((node: HTMLVideoElement) => node.videoWidth)).toBeGreaterThan(0);
    await expect(camera.getByText('Overview camera is off')).toHaveCount(0);
    const liveStream = await video!.evaluate((node: HTMLVideoElement) => node.srcObject instanceof MediaStream && node.srcObject.getVideoTracks()[0]?.readyState === 'live');
    expect(liveStream).toBe(true);

    await camera.getByRole('button', { name: 'Full screen', exact: true }).click();
    await expect(camera).toHaveClass(/is-focused/);
    expect(await camera.evaluate((workspace) => document.fullscreenElement === workspace || workspace.classList.contains('is-fallback-focus'))).toBe(true);
    expect(await video!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(camera.getByRole('img', { name: /Frieren/ })).toBeVisible();
    await expect(camera.getByRole('button', { name: 'Pause previews' })).toBeVisible();
    await expect(camera.getByRole('button', { name: 'Subtitles on' })).toHaveAttribute('aria-pressed', 'true');
    await expect(camera.getByRole('button', { name: 'Take photo for Photo help' })).toBeEnabled();
    const audit = () => page.evaluate(() => (window as any).ohmpath.request('testAudit'));
    expect((await audit()).asks).toHaveLength(0);
    await camera.getByRole('button', { name: 'Take photo for Photo help' }).click();
    const review = page.getByRole('region', { name: 'Selected image' });
    await expect(review.getByText('Overview snapshot').first()).toBeVisible();
    expect(await video!.evaluate((node) => node.isConnected && (node as HTMLVideoElement).srcObject instanceof MediaStream)).toBe(true);
    expect(await camera.evaluate((workspace) => document.fullscreenElement === workspace || workspace.classList.contains('is-fallback-focus'))).toBe(false);
    expect((await audit()).captures).toHaveLength(1);
    expect((await audit()).asks).toHaveLength(0);
    await review.locator('label', { hasText: 'What would you like help with?' }).click();
    await expect(review.getByLabel('What would you like help with?')).toBeFocused();
    await review.getByLabel('What would you like help with?').fill('Where is the red pad?');
    await review.getByRole('button', { name: 'Ask about these images' }).click();
    await expect(review.locator('.photo-help-explanation')).toHaveText('Replay explanation for Where is the red pad?');
    expect((await audit()).asks).toHaveLength(1);
    expect((await audit()).modelCalls).toBe(0);
    const scrollState = await page.locator('.scroll-area').evaluate((area: HTMLElement) => {
      const before = area.scrollTop;
      area.scrollTop = Math.min(area.scrollHeight, before + 240);
      return { scrollable: area.scrollHeight > area.clientHeight, moved: area.scrollTop > before };
    });
    expect(scrollState.scrollable).toBe(true);
    expect(scrollState.moved).toBe(true);
    await page.screenshot({ path: 'runtime/camera-focus.png' });

    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Live help' }).click();
    expect(await video!.evaluate((node) => node.isConnected)).toBe(true);
    expect(await video!.evaluate((node: HTMLVideoElement) => node.srcObject instanceof MediaStream)).toBe(true);
    await expect(camera.getByRole('button', { name: 'Full screen', exact: true })).toBeVisible();
    await camera.getByRole('button', { name: 'Full screen', exact: true }).click();
    await camera.getByRole('button', { name: 'Pause previews' }).click();
    await expect(camera.getByText('Overview camera is off')).toBeVisible();
    expect(await video!.evaluate((node: HTMLVideoElement) => node.srcObject)).toBeNull();
    await camera.getByRole('button', { name: 'Exit full screen' }).last().click();
    await expect(page.getByText('Camera previews stopped.')).toBeVisible();
    const previousOverflow = await page.evaluate(() => document.body.style.overflow);
    await camera.evaluate(workspace => {
      Object.defineProperty(workspace, 'requestFullscreen', { configurable: true, value: () => new Promise<void>(() => undefined) });
    });
    await camera.getByRole('button', { name: 'Full screen', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1100);
    await expect(camera).not.toHaveClass(/is-focused/);
    await expect(camera).not.toHaveClass(/is-fallback-focus/);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe(previousOverflow);
    expect(await page.locator('.sidebar').evaluate(sidebar => sidebar.inert)).toBe(false);

    await page.getByRole('button', { name: 'Photo help', exact: false }).first().click();
    await expect(review.getByText('Overview snapshot').first()).toBeVisible();
    await review.getByLabel('What would you like help with?').fill('late request');
    await review.getByRole('button', { name: 'Ask about these images' }).click();
    await expect.poll(async () => (await audit()).latePending).toBe(true);
    const lateContext = (await audit()).asks.at(-1).context_id;
    await page.getByRole('button', { name: 'Settings', exact: false }).first().click();
    await expect.poll(async () => (await audit()).cancels.some((item: { context_id: string }) =>
      item.context_id === lateContext)).toBe(true);
    await page.evaluate(() => (window as any).ohmpath.request('testResolveLateAsk'));
    await page.getByRole('button', { name: 'Live help', exact: false }).first().click();
    await expect(page.locator('.camera-workspace-focus-guide').getByRole('img', { name: 'Frieren · thinking' })).toHaveCount(0);
    await expect(page.locator('.camera-workspace-focus-guide').getByRole('img', { name: 'Frieren · neutral' })).toBeVisible();
    expect((await audit()).unexpected).toEqual([]);
    await page.close();
    await expect.poll(() => desktop.exitCode, { timeout: 8000 }).toBe(0);
  } finally {
    if (desktop.exitCode === null) desktop.kill();
    if (browser) await browser.close().catch(() => undefined);
  }
});
