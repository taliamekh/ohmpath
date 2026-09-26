import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('desktop connects to a real local service and confirms only after readback', async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'ohmpath-e2e-'));
  const requireElectron = createRequire(resolve('package.json'));
  const processHandle = spawn(requireElectron('electron'), [resolve('.'), '--remote-debugging-port=0', '--use-fake-device-for-media-stream'], {
    env: { ...process.env, OHMPATH_HEADLESS: '1', OHMPATH_DATA_DIR: dataDir }, windowsHide: true,
  });
  const endpoint = await new Promise<string>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Electron debugging endpoint did not open.')), 15000);
    processHandle.stderr.on('data', chunk => {
      const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); accept(match[1]); }
    });
    processHandle.once('error', reject);
  });
  console.log('Electron diagnostic endpoint ready');
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 12000 });
  console.log('Electron browser connected');
  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 12000 });
    page.setDefaultTimeout(8000);
    console.log('Electron page ready', page.url());
    await expect(page.getByRole('heading', { name: /Let’s look at your circuit/ })).toBeVisible();
    await page.getByText('Measurements and circuit tools', { exact: true }).click();
    await page.getByRole('button', { name: 'Create practice bench' }).click();
    await expect(page.getByRole('button', { name: 'Run local solve' })).toBeVisible();
    await page.getByRole('button', { name: 'Run local solve' }).click();
    await expect(page.getByText('ngspice operating point completed.', { exact: false }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Low-voltage supply' }).click();
    await page.getByLabel('I declare this is a low-voltage').check();
    await page.getByRole('button', { name: 'Save setup' }).click();
    await page.getByRole('button', { name: 'Start practice step' }).click();
    await page.getByPlaceholder('e.g. 1.65 V or OL').fill('-12.5 mV');
    await page.getByRole('button', { name: /^Read back/ }).click();
    await expect(page.getByRole('button', { name: 'Confirm practice input' })).toBeDisabled();
    const pendingReadback = await page.locator('.readback-label p').innerText();
    // Subtitles show the exact unconfirmed candidate without acknowledging it.
    await expect(page.getByLabel('Camera subtitles')).toHaveText(pendingReadback);
    await page.getByRole('button', { name: 'I checked this readback' }).click();
    await page.getByRole('button', { name: 'Confirm practice input' }).click();
    await expect(page.getByText('Practice input confirmed and recorded as simulated user input.')).toBeVisible();
    await expect(page.getByLabel('Camera subtitles')).not.toHaveText(pendingReadback);
    await page.screenshot({ path: 'runtime/desktop-verified.png', fullPage: true });
    const result = await page.evaluate(async () => {
      const api = (window as any).ohmpath;
      const sessions = await api.request('sessions');
      return api.request('events', { sid: sessions[0].session_id });
    });
    expect(result.filter((e: any) => e.event_type === 'measurement.confirmed')).toHaveLength(1);
    expect(result.find((e: any) => e.event_type === 'measurement.confirmed').payload.evidence_kind).toBe('simulated_user_input');
    // Start a fresh practice circuit to avoid mixing the signed-input check with the fault case.
    await page.getByRole('button', { name: 'Divider', exact: true }).click();
    await page.getByRole('button', { name: 'Low-voltage supply' }).click();
    await page.getByLabel('I declare this is a low-voltage').check();
    await page.getByRole('button', { name: 'Save setup' }).click();
    await page.getByLabel('RED PROBE · NODE').selectOption('B');
    await page.getByLabel('BLACK PROBE · NODE').selectOption('GND');
    await page.getByRole('button', { name: 'Start practice step' }).click();
    await page.getByPlaceholder('e.g. 1.65 V or OL').fill('0.275 V');
    await page.getByRole('button', { name: /^Read back/ }).click();
    await page.getByRole('button', { name: 'I checked this readback' }).click();
    await page.getByRole('button', { name: 'Confirm practice input' }).click();
    await page.getByRole('button', { name: 'Diagnose', exact: false }).click();
    await expect(page.getByText('Voltage · red A · black GND')).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: 'Review in step setup' }).click();
    await expect(page.getByLabel('RED PROBE · NODE')).toHaveValue('A');
    await expect(page.getByRole('button', { name: 'Start practice step' })).toBeVisible();
    await page.getByRole('button', { name: 'Open circuit and firmware tools' }).click();
    await page.getByRole('button', { name: 'Prepare assembly plan', exact: false }).click();
    await expect(page.getByText('I checked this step myself').first()).toBeVisible();
    await page.getByPlaceholder('Paste the text you copied from your serial monitor or build output…').fill('boot\nboot\nboot\nbrownout');
    await page.getByRole('button', { name: 'Analyze supplied log', exact: false }).click();
    await expect(page.getByText('boot loop', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: false }).first().click();
    const newGuide = context.waitForEvent('page');
    await page.getByLabel('Floating desktop companion').click();
    const companion = await newGuide;
    await expect(page.getByLabel('Floating desktop companion')).toBeChecked();
    await expect(companion.getByText(/Frieren/)).toBeVisible();
    expect(await companion.evaluate(() => typeof (window as any).ohmpath)).toBe('undefined');
    await companion.screenshot({ path: 'runtime/companion-verified.png' });
    await page.getByRole('button', { name: 'Devices', exact: false }).click();
    // Chromium generates this camera feed; no physical camera is opened.
    await page.getByRole('button', { name: 'Enable camera & list devices' }).click();
    await page.getByLabel('CAMERA DEVICE').selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Connect selected camera' }).click();
    await expect.poll(() => page.getByLabel('Local camera preview').evaluate((node: HTMLVideoElement) => node.videoWidth)).toBeGreaterThan(0);
    const forbiddenCapture = await companion.evaluate(async () => {
      try { const stream = await navigator.mediaDevices.getUserMedia({ video: true }); stream.getTracks().forEach(track => track.stop()); return 'granted'; }
      catch (error) { return (error as DOMException).name; }
    });
    expect(forbiddenCapture).toBe('NotAllowedError');
    const secondCapture = await page.evaluate(async () => {
      try { const stream = await navigator.mediaDevices.getUserMedia({ video: true }); stream.getTracks().forEach(track => track.stop()); return 'granted'; }
      catch (error) { return (error as DOMException).name; }
    });
    expect(secondCapture).toBe('NotAllowedError');
    await expect.poll(() => page.getByLabel('Local camera preview').evaluate((node: HTMLVideoElement) => node.videoWidth)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Load synthetic example · 4 fit / 2 held out' }).click();
    await page.getByRole('button', { name: 'Check calibration samples' }).click();
    await expect(page.getByText('Candidate result', { exact: true })).toBeVisible();
    await expect(page.getByText('accepted', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Run aiming simulation' }).click();
    await expect(page.getByText('Converged in simulation', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'runtime/devices-verified.png', fullPage: true });
    await page.getByRole('button', { name: 'Stop & pause local session' }).click();
    await expect(page.getByRole('button', { name: 'Run aiming simulation' })).toBeDisabled();
    expect(await page.getByLabel('Local camera preview').evaluate((node: HTMLVideoElement) => node.srcObject)).toBeNull();
    await page.close();
    await expect.poll(() => processHandle.exitCode, { timeout: 8000 }).toBe(0);
  } finally {
    processHandle.kill();
    await Promise.race([browser.close().catch(() => {}), new Promise(r => setTimeout(r, 2000))]);
  }
});
