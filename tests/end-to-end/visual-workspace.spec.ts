import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('visual workspace stays opt-in and photo and turret controls fail closed', async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'ohmpath-visual-ui-'));
  const requireElectron = createRequire(resolve('package.json'));
  const desktop = spawn(requireElectron('electron'), [resolve('.'), '--remote-debugging-port=0'], {
    env: { ...process.env, OHMPATH_HEADLESS: '1', OHMPATH_DATA_DIR: dataDir }, windowsHide: true,
  });
  let browser;
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Visual workspace desktop did not open')), 15000);
      desktop.stderr.on('data', chunk => {
        const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      desktop.once('error', error => { clearTimeout(timer); reject(error); });
    });
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page');

    await expect(page.getByRole('heading', { name: /Let’s look at your circuit/ })).toBeVisible();
    const camera = page.getByRole('region', { name: 'Camera workspace' });
    await expect(camera.getByText('Overview camera is off')).toBeVisible();
    await expect(camera.getByRole('button', { name: 'Ask about this view' })).toBeDisabled();
    expect(await camera.locator('video').evaluate((video: HTMLVideoElement) => video.srcObject)).toBeNull();
    await camera.getByRole('button', { name: 'Both' }).click();
    await expect(camera.getByText('Pi camera is off')).toBeVisible();
    await camera.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.screenshot({ path: 'runtime/visual-workspace.png', fullPage: true });

    const pausedSessionId = await page.evaluate(async () => {
      const api = (window as any).ohmpath;
      const session = await api.request('createSession', { name: 'Paused camera workspace regression', mode: 'mock' });
      await api.request('pause', { sid: session.session_id });
      return session.session_id as string;
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: /Let’s look at your circuit/ })).toBeVisible();
    const pausedSession = await page.evaluate(async (sid) => (window as any).ohmpath.request('session', { sid }), pausedSessionId);
    expect(pausedSession.status).toBe('paused');
    const reloadedCamera = page.getByRole('region', { name: 'Camera workspace' });
    await expect(reloadedCamera.locator('.camera-workspace-paused')).toHaveCount(0);
    await expect(page.getByText('Camera previews stopped.')).toHaveCount(0);
    await reloadedCamera.getByText('Camera setup').click();
    await expect(reloadedCamera.getByRole('button', { name: 'Enable & list cameras' })).toBeEnabled();
    expect(await reloadedCamera.locator('video').evaluate((video: HTMLVideoElement) => video.srcObject)).toBeNull();

    await page.getByRole('button', { name: 'Photo help', exact: false }).first().click();
    await expect(page.getByRole('heading', { name: /Photo help/ })).toBeVisible();
    await expect(page.getByText('Start with an image')).toBeVisible();
    await expect(page.getByText('No camera needed')).toBeVisible();
    await page.getByLabel('What would you like help with?').fill('Which lead is this?');
    await expect(page.getByRole('button', { name: 'Ask about these images' })).toBeDisabled();
    await expect(page.locator('.photo-help-answer')).toHaveCount(0);

    const imageCheck = await page.evaluate(async () => {
      const api = (window as any).ohmpath;
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 24;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#214a45';
      context.fillRect(0, 0, 32, 24);
      context.fillStyle = '#edc888';
      context.fillRect(6, 5, 20, 14);
      const data_url = canvas.toDataURL('image/png');
      const image = (await api.request('photoImportCapture', { data_url, source: 'overview', captured_at: Date.now() })).image;
      let staleRejected = '';
      try {
        await api.request('photoImportCapture', { data_url, source: 'overview', captured_at: Date.now() - 20_000 });
      } catch (error) { staleRejected = String((error as Error).message); }
      const released = await api.request('photoReleaseImage', { image_id: image.image_id });
      let rejected = '';
      try {
        await api.request('photoAsk', { context_id: crypto.randomUUID(), question: 'Which lead is this?', image_ids: [image.image_id] });
      } catch (error) { rejected = String((error as Error).message); }
      return { image, released, rejected, staleRejected };
    });
    expect(imageCheck.image.width).toBe(32);
    expect(imageCheck.image.height).toBe(24);
    expect(imageCheck.image.data_url).toMatch(/^data:image\/png;base64,/);
    expect(imageCheck.staleRejected).toMatch(/fresh snapshot/i);
    expect(imageCheck.released.released).toBe(true);
    expect(imageCheck.rejected).toMatch(/no longer available/i);

    await page.getByRole('button', { name: 'Settings', exact: false }).first().click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    const initialTurret = await page.evaluate(async () => (window as any).ohmpath.request('turretStatus'));
    expect(initialTurret).toMatchObject({ enabled: false, connected: false, motion_enabled: false, laser_enabled: false });
    const turret = page.getByRole('checkbox', { name: /turret/i });
    await expect(turret).not.toBeChecked();
    await turret.click();
    await expect.poll(async () => page.evaluate(async () => (window as any).ohmpath.request('turretStatus'))).toMatchObject({ enabled: true, connected: false, motion_enabled: false, laser_enabled: false });
    await expect(turret).toBeChecked();
    await page.getByRole('button', { name: 'Photo help', exact: false }).first().click();
    await page.getByRole('button', { name: 'Settings', exact: false }).first().click();
    await expect(page.getByRole('checkbox', { name: /turret/i })).toBeChecked();
    await turret.click();
    await expect.poll(async () => page.evaluate(async () => (window as any).ohmpath.request('turretStatus'))).toMatchObject({ enabled: false, connected: false, motion_enabled: false, laser_enabled: false });

    const previews = page.locator('.guide-expression-preview figure');
    await expect(previews).toHaveCount(4);
    for (const [index, expression] of ['neutral', 'thinking', 'stumped', 'happy'].entries()) {
      const guide = previews.nth(index).getByRole('img', { name: `Frieren · ${expression}` });
      await expect(guide).toBeVisible();
      const decoded = await guide.locator('.frieren-sprite').evaluate(async (sprite) => {
        const background = getComputedStyle(sprite).backgroundImage;
        const source = /^url\(["']?(.*?)["']?\)$/.exec(background)?.[1];
        if (!source) return false;
        const image = new Image();
        image.src = source;
        try { await image.decode(); return image.naturalWidth > 0 && image.naturalHeight > 0; }
        catch { return false; }
      });
      expect(decoded, `${expression} sprite should decode`).toBe(true);
    }
    await page.screenshot({ path: 'runtime/visual-settings.png', fullPage: true });

    const companionPage = context.waitForEvent('page');
    await page.getByLabel('Floating desktop companion').click();
    const companion = await companionPage;
    await expect(companion.getByRole('img', { name: /Frieren/ })).toBeVisible();
    expect(await companion.evaluate(() => typeof (window as any).ohmpath)).toBe('undefined');
    await page.getByLabel('Floating desktop companion').click();
    await page.close();
    await expect.poll(() => desktop.exitCode, { timeout: 8000 }).toBe(0);
  } finally {
    if (desktop.exitCode === null) desktop.kill();
    if (browser) await browser.close().catch(() => undefined);
  }
});
