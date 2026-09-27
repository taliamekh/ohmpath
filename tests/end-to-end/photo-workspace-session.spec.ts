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
  pastes: number;
  unexpected: string[];
  latePending: boolean;
  lateChoicePending: boolean;
  modelCalls: number;
};

test('offline Photo help retains completed workspace across tabs and clears it explicitly', async () => {
  const requireElectron = createRequire(resolve('package.json'));
  const dataDir = await mkdtemp(resolve(tmpdir(), 'ohmpath-photo-workspace-'));
  const desktop = spawn(requireElectron('electron'), [
    resolve('tests/electron/photo-help-replay-main.cjs'), '--remote-debugging-port=0',
  ], { env: { ...process.env, OHMPATH_REPLAY_DATA_DIR: dataDir }, windowsHide: true });
  let browser: import('@playwright/test').Browser | undefined;
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
    const photoTab = page.getByRole('button', { name: 'Photo help', exact: false }).first();
    const cameraTab = page.getByRole('button', { name: 'Live help', exact: false }).first();

    await photoTab.click();
    expect((await audit()).pastes).toBe(0); // Rendering Photo help never reads the clipboard.
    await page.getByRole('button', { name: 'Add a photo or diagram' }).click();
    await expect(page.getByText('Replay circuit A.png').first()).toBeVisible();
    expect((await audit()).pastes).toBe(0);
    expect((await audit()).asks).toHaveLength(0);
    await page.getByLabel('What would you like help with?').fill('first question');
    await page.getByRole('button', { name: 'Ask about these images' }).click();
    await expect(page.locator('.photo-help-explanation')).toHaveText('Replay explanation for first question');
    const first = (await audit()).asks[0];

    await cameraTab.click();
    await expect(page.locator('.photo-help-page')).toBeHidden();
    expect((await audit()).cancels.some(item => item.context_id === first.context_id)).toBe(false);
    expect((await audit()).releases).not.toContain(first.image_ids[0]);
    await photoTab.click();
    await expect(page.getByText('Replay circuit A.png').first()).toBeVisible();
    await expect(page.locator('.photo-help-explanation')).toHaveText('Replay explanation for first question');
    await page.getByLabel('What would you like help with?').fill('follow-up question');
    await page.getByRole('button', { name: 'Ask about these images' }).click();
    await expect(page.locator('.photo-help-explanation')).toHaveText('Replay explanation for follow-up question');
    const followUp = (await audit()).asks[1];
    expect(followUp.context_id).toBe(first.context_id);
    await expect(page.getByRole('region', { name: 'Recent questions' }).getByText('first question', { exact: true })).toBeVisible();

    await page.getByLabel('What would you like help with?').fill('late request');
    await page.getByRole('button', { name: 'Ask about these images' }).click();
    await expect.poll(async () => (await audit()).latePending).toBe(true);
    const late = (await audit()).asks.at(-1)!;
    await cameraTab.click();
    expect((await audit()).cancels.some(item =>
      item.context_id === late.context_id && item.turn_id === null)).toBe(false);
    await page.evaluate(() => (window as any).ohmpath.request('testResolveLateAsk'));
    await expect.poll(async () => (await audit()).cancels.some(item =>
      item.context_id === late.context_id && item.turn_id === late.turn_id)).toBe(true);
    await photoTab.click();
    await expect(page.locator('.photo-help-explanation')).toHaveText('Replay explanation for follow-up question');
    await expect(page.getByText('Replay explanation for late request')).toHaveCount(0);
    expect((await audit()).asks).toHaveLength(3); // Returning never asks automatically.

    await page.getByRole('button', { name: 'Clear workspace' }).click();
    await expect(page.getByText('Start with an image')).toBeVisible();
    await expect(page.locator('.photo-help-answer')).toHaveCount(0);
    await expect(page.getByLabel('What would you like help with?')).toHaveValue('');
    await expect.poll(async () => (await audit()).releases).toContain(first.image_ids[0]);

    await page.evaluate(() => (window as any).ohmpath.request('testDelayNextChoice'));
    await page.getByRole('button', { name: 'Add a photo or diagram' }).click();
    await expect.poll(async () => (await audit()).lateChoicePending).toBe(true);
    await cameraTab.click();
    await page.evaluate(() => (window as any).ohmpath.request('testResolveLateChoice'));
    await expect.poll(async () => (await audit()).releases).toContain('10000000-0000-4000-8000-000000000002');
    await photoTab.click();
    await expect(page.getByText('Start with an image')).toBeVisible();
    await expect(page.getByText('Replay circuit B.png')).toHaveCount(0);

    await page.evaluate(() => (window as any).ohmpath.request('testDelayNextChoice'));
    await page.getByRole('button', { name: 'Add a photo or diagram' }).click();
    await expect.poll(async () => (await audit()).lateChoicePending).toBe(true);
    await page.getByRole('button', { name: 'Clear workspace' }).click();
    await page.evaluate(() => (window as any).ohmpath.request('testResolveLateChoice'));
    await expect.poll(async () => (await audit()).releases).toContain('10000000-0000-4000-8000-000000000003');
    await expect(page.getByText('Start with an image')).toBeVisible();
    await expect(page.getByText('Replay circuit C.png')).toHaveCount(0);
    expect((await audit()).asks).toHaveLength(3); // Returning, choosing and clearing never ask automatically.

    await page.locator('.photo-help-empty').getByRole('button', { name: 'Paste image' }).click();
    await expect(page.getByRole('img', { name: 'Replay circuit D.png' })).toBeVisible();
    expect((await audit()).pastes).toBe(1);
    expect((await audit()).asks).toHaveLength(3); // Pasting selects an image; Ask remains explicit.
    await page.locator('.photo-help-attachments').getByRole('button', { name: 'Paste image' }).click();
    await expect(page.getByText('Replay circuit E.png').first()).toBeVisible();
    await page.locator('.photo-help-attachments').getByRole('button', { name: 'Paste image' }).click();
    await expect(page.getByText('Replay circuit F.png').first()).toBeVisible();
    await expect(page.locator('.photo-help-attachments').getByRole('button', { name: 'Paste image' })).toBeDisabled();
    expect((await audit()).pastes).toBe(3);
    expect((await audit()).asks).toHaveLength(3);
    await page.getByRole('button', { name: 'Clear workspace' }).click();
    await expect(page.getByText('Start with an image')).toBeVisible();
    await expect(page.locator('.photo-help-answer')).toHaveCount(0);
    for (const id of ['10000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000006']) {
      await expect.poll(async () => (await audit()).releases).toContain(id);
    }
    expect((await audit()).asks).toHaveLength(3);
    const final = await audit();
    expect(final.modelCalls).toBe(0);
    expect(final.unexpected).toEqual([]);

    await page.close();
    await expect.poll(() => desktop.exitCode, { timeout: 8000 }).toBe(0);
  } finally {
    if (desktop.exitCode === null) desktop.kill();
    if (browser) await browser.close().catch(() => undefined);
  }
});
