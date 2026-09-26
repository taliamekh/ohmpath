import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('a renderer crash closes its private bench instead of leaving an investigator running', async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'ohmpath-crash-test-'));
  const requireElectron = createRequire(resolve('package.json'));
  const desktop = spawn(requireElectron('electron'), [resolve('.'), '--remote-debugging-port=0'], {
    env: { ...process.env, OHMPATH_HEADLESS: '1', OHMPATH_DATA_DIR: dataDir }, windowsHide: true,
  });
  let browser;
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Test desktop did not become ready')), 15000);
      desktop.stderr.on('data', chunk => {
        const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      desktop.once('error', error => { clearTimeout(timer); reject(error); });
    });
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page');
    await page.getByRole('button', { name: 'Create practice bench' }).click();
    await expect(page.getByRole('button', { name: 'Run local solve' })).toBeVisible();
    const devtools = await context.newCDPSession(page);
    // Chromium crashes only this isolated test renderer. No physical devices or model turn are opened.
    const crash = devtools.send('Page.crash').catch(() => undefined);
    await expect.poll(() => desktop.exitCode, { timeout: 12000 }).toBe(0);
    await crash;
  } finally {
    if (desktop.exitCode === null) desktop.kill();
    if (browser) await browser.close().catch(() => undefined);
  }
});
