import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

for (const projectFallback of [false, true]) test(`production voice status reaches the renderer (${projectFallback ? 'project fallback' : 'ordinary installation'})`, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ohmpath-voice-status-'));
  const requireElectron = createRequire(resolve('package.json'));
  const disabledTunnelPath = join(dataDir, 'cloudflared-disabled-for-test.exe');
  const desktop = spawn(requireElectron('electron'), [resolve('.'), '--remote-debugging-port=0'], {
    env: { ...process.env, OHMPATH_HEADLESS: '1', OHMPATH_DATA_DIR: dataDir,
      ...(projectFallback ? { LOCALAPPDATA: join(dataDir, 'unavailable-local'), USERPROFILE: join(dataDir, 'unavailable-user'), OHMPATH_WHISPER: '', OHMPATH_SPEECH_MODEL: '' } : {}),
      OHMPATH_CLOUDFLARED: disabledTunnelPath }, windowsHide: true,
  });
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  let stderrTail = '';
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error(`Electron debugging endpoint did not open. ${stderrTail}`)), 15000);
      desktop.stderr.on('data', chunk => {
        const value = chunk.toString();
        stderrTail = (stderrTail + value).slice(-2500);
        const match = value.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      desktop.once('error', error => { clearTimeout(timer); reject(error); });
      desktop.once('exit', code => { clearTimeout(timer); reject(new Error(`Electron exited early (${code}). ${stderrTail}`)); });
    });
    browser = await chromium.connectOverCDP(endpoint, { timeout: 12000 });
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 12000 });
    page.setDefaultTimeout(10000);
    await page.waitForURL(url => url.protocol === 'file:' && url.pathname.endsWith('/dist/desktop/index.html'));
    await expect(page.getByText('Measurements and circuit tools', { exact: true })).toBeVisible();

    const outcome = await page.evaluate(async () => {
      try {
        return { ok: true, status: await (window as any).ohmpath.request('voiceStatus') };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    expect(outcome).toEqual({ ok: true, status: expect.objectContaining({
      provider: 'whisper.cpp', model: 'small.en', local_only: true, status: 'installed',
    }) });
    if (projectFallback) expect(outcome.status.installation).toEqual({
      executable: resolve('runtime/speech-install/tools/whisper-b5130/Release/whisper-server.exe'), executable_exists: true,
      model: resolve('runtime/speech-install/models/ggml-small.en.bin'), model_exists: true,
    });

    await page.getByRole('button', { name: 'Settings', exact: false }).first().click();
    await expect(page.getByText('INSTALLED', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Check local speech again' }).click();
    await expect(page.getByText('INSTALLED', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Photo help', exact: false }).first().click();
    await expect(page.getByRole('button', { name: 'Start recording' })).toBeEnabled();

    await page.close();
    await expect.poll(() => desktop.exitCode, { timeout: 10000 }).toBe(0);
  } catch (problem) {
    if (desktop.exitCode !== null) throw new Error(`${problem instanceof Error ? problem.message : problem}\nElectron stderr: ${stderrTail}`);
    throw problem;
  } finally {
    if (desktop.exitCode === null) desktop.kill();
    if (browser) await browser.close().catch(() => undefined);
    const expectedParent = resolve(tmpdir());
    const cleanupPath = resolve(dataDir);
    if (dirname(cleanupPath) === expectedParent && basename(cleanupPath).startsWith('ohmpath-voice-status-'))
      await rm(cleanupPath, { recursive: true, force: true }).catch(() => undefined);
  }
});
