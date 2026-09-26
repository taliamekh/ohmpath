import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

type ReplayAudit = {
  asks: { context_id: string; turn_id: string; question: string; image_ids: string[] }[];
  cancels: { context_id: string; turn_id: string | null }[];
  releases: string[];
  choices: number;
  statusChecks: number;
  unexpected: string[];
  latePending: boolean;
  modelCalls: number;
};

test('offline photo help replay keeps image context and discards canceled answers', async () => {
  const requireElectron = createRequire(resolve('package.json'));
  const dataDir = await mkdtemp(resolve(tmpdir(), 'ohmpath-photo-replay-'));
  const desktop = spawn(requireElectron('electron'), [
    resolve('tests/electron/photo-help-replay-main.cjs'), '--remote-debugging-port=0',
  ], { env: { ...process.env, OHMPATH_REPLAY_DATA_DIR: dataDir }, windowsHide: true });
  let browser;
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Offline photo replay did not open.')), 15000);
      desktop.stderr.on('data', chunk => {
        const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      desktop.once('error', error => { clearTimeout(timer); reject(error); });
      desktop.once('exit', code => { clearTimeout(timer); reject(new Error(`Offline photo replay exited early (${code}).`)); });
    });
    browser = await chromium.connectOverCDP(endpoint, { timeout: 12000 });
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 12000 });
    page.setDefaultTimeout(8000);
    const audit = () => page.evaluate(() => (window as any).ohmpath.request('testAudit') as Promise<ReplayAudit>);

    await page.getByRole('button', { name: 'Photo help', exact: false }).first().click();
    await expect(page.getByText('Start with an image')).toBeVisible();
    await page.getByRole('button', { name: 'Add a photo or diagram' }).click();
    await expect(page.getByText('Replay circuit A.png').first()).toBeVisible();
    await expect(page.locator('.photo-help-answer')).toHaveCount(0);
    expect((await audit()).asks).toHaveLength(0);

    await page.getByLabel('What would you like help with?').fill('first question');
    expect((await audit()).asks).toHaveLength(0);
    await page.getByRole('button', { name: 'Ask about these images' }).click();
    await expect(page.locator('.photo-help-explanation')).toHaveText('Replay explanation for first question');
    await expect(page.getByRole('button', { name: 'Annotation 1: Replay marker' })).toBeVisible();
    await page.screenshot({ path: 'runtime/photo-help-replay.png', fullPage: true });
    const first = (await audit()).asks[0];
    expect(first.image_ids).toEqual(['10000000-0000-4000-8000-000000000001']);

    await page.getByLabel('What would you like help with?').fill('second question');
    await page.getByRole('button', { name: 'Ask about these images' }).click();
    await expect(page.locator('.photo-help-explanation')).toHaveText('Replay explanation for second question');
    const second = (await audit()).asks[1];
    expect(second.context_id).toBe(first.context_id);

    await page.getByLabel('What would you like help with?').fill('fail request');
    await page.getByRole('button', { name: 'Ask about these images' }).click();
    await expect(page.getByRole('alert')).toHaveText('Replay answer unavailable.');
    await expect(page.getByRole('img', { name: 'Frieren · stumped' })).toBeVisible();

    await page.getByRole('button', { name: 'Add another image' }).click();
    await expect(page.getByText('Replay circuit B.png').first()).toBeVisible();
    await expect(page.locator('.photo-help-answer')).toHaveCount(0);
    expect((await audit()).cancels.some(item => item.context_id === first.context_id && item.turn_id === null)).toBe(true);
    await page.getByRole('button', { name: 'Remove Replay circuit A.png' }).click();
    expect((await audit()).releases).toContain('10000000-0000-4000-8000-000000000001');

    await page.getByLabel('What would you like help with?').fill('late request');
    await page.getByRole('button', { name: 'Ask about these images' }).click();
    await expect.poll(async () => (await audit()).latePending).toBe(true);
    const late = (await audit()).asks.at(-1)!;
    await page.getByRole('button', { name: 'Remove Replay circuit B.png' }).click();
    await expect(page.getByText('Start with an image')).toBeVisible();
    await page.evaluate(() => (window as any).ohmpath.request('testResolveLateAsk'));
    await expect.poll(async () => (await audit()).cancels.filter(item => item.context_id === late.context_id).length).toBeGreaterThanOrEqual(2);
    await expect(page.locator('.photo-help-answer')).toHaveCount(0);
    const final = await audit();
    expect(final.releases).toContain('10000000-0000-4000-8000-000000000002');
    expect(final.modelCalls).toBe(0);
    expect(final.unexpected).toEqual([]);

    await page.close();
    await expect.poll(() => desktop.exitCode, { timeout: 8000 }).toBe(0);
  } finally {
    if (desktop.exitCode === null) desktop.kill();
    if (browser) await browser.close().catch(() => undefined);
  }
});
