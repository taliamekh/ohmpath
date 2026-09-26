import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('voice account setup stays silent and rejects an invalid key before contacting the provider', async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'ohmpath-voice-link-ui-'));
  const requireElectron = createRequire(resolve('package.json'));
  const desktop = spawn(requireElectron('electron'), [resolve('.'), '--remote-debugging-port=0'], {
    env: { ...process.env, OHMPATH_HEADLESS: '1', OHMPATH_DATA_DIR: dataDir }, windowsHide: true,
  });
  let browser;
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Connection setup desktop did not open')), 15000);
      desktop.stderr.on('data', chunk => {
        const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      desktop.once('error', error => { clearTimeout(timer); reject(error); });
    });
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page');
    await page.getByRole('button', { name: /Settings/ }).click();
    const panel = page.getByRole('region', { name: 'ElevenLabs connection' });
    await expect(panel.getByText('NOT LINKED', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: /preview|test|generate/i })).toHaveCount(0);
    await expect(panel.getByLabel('ELEVENLABS API KEY')).toHaveAttribute('type', 'password');
    await panel.getByLabel('ELEVENLABS API KEY').fill('bad');
    await panel.getByRole('button', { name: 'Link account · no speech' }).click();
    await expect(panel.getByRole('alert')).toHaveText('Check the API key and try linking again. No speech was requested.');
    await expect(panel.getByLabel('ELEVENLABS API KEY')).toHaveValue('');
    const status = await page.evaluate(async () => (window as any).ohmpath.request('elevenLabsStatus'));
    expect(status.connected).toBe(false);
    expect(status.generation_enabled).toBe(false);
    expect(status.generation_tested).toBe(false);
    await page.screenshot({ path: 'runtime/elevenlabs-link-settings.png', fullPage: true });
    await page.close();
    await expect.poll(() => desktop.exitCode, { timeout: 8000 }).toBe(0);
  } finally {
    if (desktop.exitCode === null) desktop.kill();
    if (browser) await browser.close().catch(() => undefined);
  }
});
