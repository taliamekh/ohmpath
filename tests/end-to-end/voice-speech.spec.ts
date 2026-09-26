import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, dirname, basename } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('local speech is opt-in and late speech cannot acknowledge a replacement candidate', async () => {
  const testRoot = resolve(tmpdir());
  const dataDir = await mkdtemp(resolve(testRoot, 'ohmpath-voice-e2e-'));
  const requireElectron = createRequire(resolve('package.json'));
  const processHandle = spawn(requireElectron('electron'), [resolve('.'), '--remote-debugging-port=0'], {
    env: { ...process.env, OHMPATH_HEADLESS: '1', OHMPATH_DATA_DIR: dataDir }, windowsHide: true,
  });
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  let stderrTail = '';
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error(`Electron debugging endpoint did not open. ${stderrTail}`)), 15000);
      processHandle.stderr.on('data', chunk => {
        const value = chunk.toString();
        stderrTail = (stderrTail + value).slice(-2500);
        const match = value.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      processHandle.once('error', reject);
    });
    browser = await chromium.connectOverCDP(endpoint, { timeout: 12000 });
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 12000 });
    page.setDefaultTimeout(8000);
    await expect(page.getByRole('button', { name: 'Create practice bench' })).toBeVisible();

    await page.evaluate(() => {
      const utterances: any[] = [];
      const originalSynthesis = window.speechSynthesis;
      class SilentUtterance {
        text: string;
        voice: any = null;
        onstart: (() => void) | null = null;
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(text: string) { this.text = text; }
      }
      const localVoice = { name: 'Offline Test Voice', lang: 'en-US', voiceURI: 'offline-test', default: true, localService: true };
      Object.defineProperty(originalSynthesis, 'getVoices', { configurable: true, value: () => [localVoice] });
      Object.defineProperty(originalSynthesis, 'speak', { configurable: true, value: (utterance: any) => { utterances.push(utterance); utterance.onstart?.(); } });
      Object.defineProperty(originalSynthesis, 'cancel', { configurable: true, value: () => undefined });
      Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: SilentUtterance });
      Object.defineProperty(window, '__silentSpeechQueue', { configurable: false, value: utterances });
      originalSynthesis.dispatchEvent(new Event('voiceschanged'));
    });

    await page.getByRole('button', { name: 'Settings', exact: false }).first().click();
    await expect(page.getByLabel(/Optional local system voice/)).toBeEnabled();
    await page.getByLabel(/Optional local system voice/).check();
    await page.getByRole('button', { name: 'Bench', exact: false }).first().click();
    await page.getByRole('button', { name: 'Create practice bench' }).click();
    await page.getByRole('button', { name: 'Low-voltage supply' }).click();
    await page.getByLabel('I declare this is a low-voltage').check();
    await page.getByRole('button', { name: 'Save setup' }).click();
    await page.getByRole('button', { name: 'Start practice step' }).click();

    await page.getByPlaceholder('e.g. 1.65 V or OL').fill('-12.5 mV');
    await page.getByRole('button', { name: /^Read back/ }).click();
    await expect(page.getByRole('button', { name: 'Confirm practice input' })).toBeDisabled();
    await page.getByRole('button', { name: 'Read aloud · Offline Test Voice' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__silentSpeechQueue.length)).toBe(1);

    await page.getByPlaceholder('e.g. 1.65 V or OL').fill('2.2 V');
    await page.getByRole('button', { name: /^Replace candidate/ }).click();
    await expect(page.getByRole('button', { name: 'Read aloud · Offline Test Voice' })).toBeVisible();
    // Simulate a late completion callback from the superseded candidate's cancelled utterance.
    await page.evaluate(() => (window as any).__silentSpeechQueue[0].onend?.());
    await expect(page.getByRole('button', { name: 'Confirm practice input' })).toBeDisabled();

    await page.getByText('Test routing with typed text', { exact: false }).click();
    await page.getByPlaceholder('Try: ‘I read 1.65 volts’ or ask a circuit question').fill('Why does this divider have a center node?');
    await page.getByRole('button', { name: 'Route text', exact: true }).click();
    await expect(page.getByText('Local evidence summary', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Read local summary · Offline Test Voice' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__silentSpeechQueue.length)).toBe(2);
    await page.evaluate(() => (window as any).__silentSpeechQueue[1].onend?.());
    await expect(page.getByRole('button', { name: 'Confirm practice input' })).toBeDisabled();

    await page.getByRole('button', { name: 'Read aloud · Offline Test Voice' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__silentSpeechQueue.length)).toBe(3);
    await page.evaluate(() => (window as any).__silentSpeechQueue[2].onend?.());
    await expect(page.getByRole('button', { name: 'Confirm practice input' })).toBeEnabled();
    await page.getByRole('button', { name: 'Confirm practice input' }).click();
    await expect(page.getByText('Practice input confirmed and recorded as simulated user input.')).toBeVisible();
    await page.close();
    await expect.poll(() => processHandle.exitCode, { timeout: 8000 }).toBe(0);
  } catch (problem) {
    if (processHandle.exitCode !== null) throw new Error(`${problem instanceof Error ? problem.message : problem}\nElectron stderr: ${stderrTail}`);
    throw problem;
  } finally {
    if (processHandle.exitCode === null) processHandle.kill();
    if (browser) await Promise.race([browser.close().catch(() => {}), new Promise(resolveDone => setTimeout(resolveDone, 2000))]);
    const cleanupPath = resolve(dataDir);
    if (dirname(cleanupPath) === testRoot && basename(cleanupPath).startsWith('ohmpath-voice-e2e-')) {
      await rm(cleanupPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
});
