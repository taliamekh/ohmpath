import { test, expect, chromium, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

async function widthAudit(page: Page) {
  return page.evaluate(() => ({ viewport: window.innerWidth, page: document.documentElement.scrollWidth,
    shell: document.querySelector('.app-shell')?.getBoundingClientRect().width ?? 0 }));
}

test('compact offline workspaces keep camera and photo controls reachable', async () => {
  const requireElectron = createRequire(resolve('package.json'));
  const dataDir = await mkdtemp(resolve(tmpdir(), 'ohmpath-compact-workspace-'));
  const desktop = spawn(requireElectron('electron'), [
    resolve('tests/electron/photo-help-replay-main.cjs'), '--remote-debugging-port=0',
  ], { env: { ...process.env, OHMPATH_REPLAY_DATA_DIR: dataDir }, windowsHide: true });
  let browser;
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Compact replay did not open.')), 15000);
      desktop.stderr.on('data', chunk => {
        const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      desktop.once('error', error => { clearTimeout(timer); reject(error); });
      desktop.once('exit', code => { clearTimeout(timer); reject(new Error(`Compact replay exited early (${code}).`)); });
    });
    browser = await chromium.connectOverCDP(endpoint, { timeout: 12000 });
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 12000 });
    page.setDefaultTimeout(8000);

    await page.setViewportSize({ width: 980, height: 700 });
    const camera = page.getByRole('region', { name: 'Camera workspace' });
    await expect(camera.getByRole('button', { name: 'Full screen' })).toBeVisible();
    await expect(camera.getByRole('button', { name: 'Ask about this view' })).toBeVisible();
    await page.screenshot({ path: 'runtime/compact-camera-980.png' });
    expect((await widthAudit(page)).page).toBeLessThanOrEqual(981);
    await page.setViewportSize({ width: 784, height: 560 }); // 980 × 700 at 125% effective scale.
    await page.screenshot({ path: 'runtime/compact-camera-125-percent.png' });
    expect((await widthAudit(page)).page).toBeLessThanOrEqual(785);
    await page.setViewportSize({ width: 980, height: 700 });

    await page.getByRole('button', { name: 'Photo help', exact: false }).first().click();
    await page.getByRole('button', { name: 'Add a photo or diagram' }).click();
    const question = page.getByLabel('What would you like help with?');
    await question.fill('Where is the input pad?');
    await question.focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Ask about these images' })).toBeFocused();
    await page.getByRole('button', { name: 'Ask about these images' }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Ask about these images' })).toBeInViewport();
    expect((await widthAudit(page)).page).toBeLessThanOrEqual(981);

    await page.setViewportSize({ width: 784, height: 560 });
    expect((await widthAudit(page)).page).toBeLessThanOrEqual(785);
    await page.getByRole('button', { name: 'Ask about these images' }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Ask about these images' })).toBeInViewport();

    await page.setViewportSize({ width: 980, height: 700 });
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Live help' }).click();
    await page.getByText('Measurements and circuit tools', { exact: true }).click();
    await page.locator('.bench-advanced').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'runtime/theme-measurements-980.png', timeout: 12000 });
    await page.setViewportSize({ width: 784, height: 560 });
    await page.getByRole('button', { name: 'Settings', exact: false }).first().click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    expect((await widthAudit(page)).page).toBeLessThanOrEqual(785);
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.scroll-area')?.scrollTo(0, 0); });
    await page.screenshot({ path: 'runtime/theme-settings-compact.png', timeout: 12000 });
    const audit = await page.evaluate(() => (window as any).ohmpath.request('testAudit'));
    expect(audit.modelCalls).toBe(0);
    await page.close();
    await expect.poll(() => desktop.exitCode, { timeout: 8000 }).toBe(0);
  } finally {
    if (desktop.exitCode === null) desktop.kill();
    if (browser) await browser.close().catch(() => undefined);
  }
});
