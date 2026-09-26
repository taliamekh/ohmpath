import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

test('an unexpected render failure shows a private-safe manual recovery screen', async () => {
  const requireElectron = createRequire(resolve('package.json'));
  const dataDir = await mkdtemp(resolve(tmpdir(), 'ohmpath-renderer-recovery-'));
  const desktop = spawn(requireElectron('electron'), [
    resolve('tests/electron/renderer-recovery-main.cjs'), '--remote-debugging-port=0',
  ], { env: { ...process.env, OHMPATH_RECOVERY_DATA_DIR: dataDir }, windowsHide: true });
  let browser;
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Recovery replay did not open.')), 15000);
      desktop.stderr.on('data', chunk => {
        const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      desktop.once('error', error => { clearTimeout(timer); reject(error); });
      desktop.once('exit', code => { clearTimeout(timer); reject(new Error(`Recovery replay exited early (${code}).`)); });
    });
    browser = await chromium.connectOverCDP(endpoint, { timeout: 12000 });
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 12000 });
    page.setDefaultTimeout(8000);
    await page.addInitScript(() => {
      (window as any).__ohmpathRecoveryFault = true;
      const originalFind = Array.prototype.find;
      Array.prototype.find = function (predicate, thisArg) {
        if ((window as any).__ohmpathRecoveryFault && this.length === 4
          && (this as any)[0]?.id === 'bench' && (this as any)[1]?.id === 'photo') {
          throw new Error('PRIVATE_DIAGNOSTIC_RENDER_SENTINEL');
        }
        return originalFind.call(this, predicate, thisArg);
      };
    });
    await page.goto(pathToFileURL(resolve('dist/desktop/index.html')).href);

    const recovery = page.getByRole('alert');
    await expect(recovery.getByRole('heading', { name: 'This view needs a fresh start' })).toBeVisible();
    await expect(recovery.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Let’s look at your circuit/ })).toHaveCount(0);
    expect(await page.locator('body').innerText()).not.toContain('PRIVATE_DIAGNOSTIC_RENDER_SENTINEL');
    expect((await page.evaluate(() => (window as any).ohmpath.request('testAudit'))).actions).toEqual([]);

    await page.evaluate(() => { (window as any).__ohmpathRecoveryFault = false; });
    await recovery.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: /Let’s look at your circuit/ })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Camera workspace' }).getByText('Overview camera is off')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    const audit = await page.evaluate(() => (window as any).ohmpath.request('testAudit'));
    expect([...new Set(audit.actions)].sort()).toEqual(['disableCamera', 'health', 'sessions', 'voiceStatus']);
    await page.close();
    await expect.poll(() => desktop.exitCode, { timeout: 8000 }).toBe(0);
  } finally {
    if (desktop.exitCode === null) desktop.kill();
    if (browser) await browser.close().catch(() => undefined);
  }
});
