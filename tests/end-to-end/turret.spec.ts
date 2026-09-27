import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('turret workspace starts released, gates controls and cleans up on navigation', async () => {
  test.setTimeout(60000);
  const dataDir = await mkdtemp(resolve(tmpdir(), 'ohmpath-turret-e2e-'));
  const electron = createRequire(resolve('package.json'))('electron');
  const child = spawn(electron, [resolve('.'), '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], {
    env: {...process.env, OHMPATH_HEADLESS: '1', OHMPATH_DATA_DIR: dataDir}, windowsHide: true,
  });
  const endpoint = await new Promise<string>((accept, reject) => {
    const timeout = setTimeout(() => reject(new Error('Electron did not start')), 15000);
    child.stderr.on('data', chunk => {
      const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); accept(match[1]); }
    });
    child.once('error', reject);
  });
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page');
    page.setDefaultTimeout(8000);
    await page.getByTitle('Turret', {exact:true}).click();
    await expect(page.getByRole('heading', {name:'Turret', exact:true})).toBeVisible();
    await expect(page.getByText('MOTORS RELEASED', {exact:true})).toBeVisible();
    await expect(page.getByText('Position unknown · motors released', {exact:true})).toBeVisible();
    console.log('Turret page ready; outputs released.');
    await expect(page.getByRole('button', {name:'Enable movement', exact:true})).toBeDisabled();
    // Optional explicitly opted-in camera-only integration. Never arms or moves motors.
    if (process.env.OHMPATH_TEST_PAIRED_CAMERA === '1') {
      await page.getByRole('button', {name:'Connect Pi', exact:true}).click();
      await expect(page.getByAltText('Live Raspberry Pi turret camera')).toBeVisible({timeout:20000});
      const state = await page.evaluate(() => (window as any).ohmpath.request('motionStatus', {}));
      expect(state.connected).toBe(true); expect(state.armed).toBe(false); expect(state.camera_ready).toBe(true);
      expect(state.commanded_us).toBeNull();
      await page.getByRole('button', {name:'Rotate view', exact:true}).click();
      await expect(page.getByRole('button', {name:'Rotate view', exact:true})).toBeEnabled();
      const hdFrame = await page.evaluate(() => (window as any).ohmpath.request('motionFrame', {}));
      expect([hdFrame.frame.width, hdFrame.frame.height]).toEqual([720,1280]);
      await page.getByRole('button', {name:'Refocus', exact:true}).click();
      await expect(page.getByRole('button', {name:'Refocus', exact:true})).toBeEnabled({timeout:20000});
      const refocusedFrame = await page.evaluate(() => (window as any).ohmpath.request('motionFrame', {}));
      expect(refocusedFrame.frame.generation).not.toBe(hdFrame.frame.generation);
      expect((await page.evaluate(() => (window as any).ohmpath.request('motionStatus', {}))).armed).toBe(false);
      console.log('Paired live camera visible; outputs remain released.');
      const displayedFps = await page.evaluate(async () => {
        const image = document.querySelector('img[alt="Live Raspberry Pi turret camera"]') as HTMLImageElement;
        let frames = 0;
        const loaded = () => {frames++;};
        image.addEventListener('load', loaded);
        const start = performance.now();
        await new Promise(r => setTimeout(r, 4000));
        image.removeEventListener('load', loaded);
        return frames * 1000 / (performance.now() - start);
      });
      console.log(`Actual renderer preview: ${displayedFps.toFixed(1)} fps; camera only, motors released.`);
      expect(displayedFps).toBeGreaterThan(20);
      const cameraCapture = await context.newCDPSession(page);
      const preview = await Promise.race([cameraCapture.send('Page.captureScreenshot', {format:'png', captureBeyondViewport:false}),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Camera screenshot timed out')), 6000))]);
      await writeFile('runtime/turret-camera-verified.png', Buffer.from(preview.data, 'base64'));
      await cameraCapture.detach();
      await page.getByRole('button', {name:'Disconnect', exact:true}).click();
      await expect(page.getByRole('button', {name:'Connect Pi', exact:true})).toBeVisible();
    }
    await expect(page.getByLabel('The mechanism and cables have room to move.')).toHaveCount(0);
    await page.getByLabel('Laser power is disconnected.').check();
    await expect(page.getByRole('button', {name:'Enable movement', exact:true})).toBeDisabled();
    await expect(page.getByRole('button', {name:'Home', exact:true})).toBeDisabled();
    await page.getByText('Travel limits and direction', {exact:true}).click();
    await expect(page.getByLabel('Full manual range on enable · bypass saved limits')).toBeChecked();
    await expect(page.getByRole('button', {name:'Enable movement', exact:true})).toBeDisabled();
    await page.getByText('Aiming reference · laser-off rehearsal', {exact:true}).click();
    await expect(page.getByRole('button', {name:'Stop movement', exact:true})).toBeInViewport();
    console.log('Stop remains visible after scrolling.');
    await expect(page.getByRole('button', {name:'Align to reference · laser off'})).toBeDisabled();
    await page.getByTitle('Devices', {exact:true}).click();
    const state = await page.evaluate(() => (window as any).ohmpath.request('motionStatus', {}));
    expect(state.connected).toBe(false);
    expect(state.armed).toBe(false);
    expect(state.laser_enabled).toBe(false);
  } finally {
    if (child.exitCode === null) child.kill();
    await Promise.race([browser.close().catch(() => {}), new Promise(r => setTimeout(r, 2000))]);
  }
});
