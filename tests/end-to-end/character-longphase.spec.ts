import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('fixed character pose keeps its face through accelerated long animation phases', async () => {
  const requireElectron = createRequire(resolve('package.json'));
  const dataDir = await mkdtemp(resolve(tmpdir(), 'ohmpath-character-longphase-'));
  const desktop = spawn(requireElectron('electron'), [
    resolve('tests/electron/photo-help-replay-main.cjs'), '--remote-debugging-port=0',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  ], { env: { ...process.env, OHMPATH_REPLAY_DATA_DIR: dataDir }, windowsHide: true });
  let browser: import('@playwright/test').Browser | undefined;
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Character long-phase replay did not open.')), 15000);
      desktop.stderr.on('data', chunk => {
        const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      desktop.once('error', error => { clearTimeout(timer); reject(error); });
      desktop.once('exit', code => { clearTimeout(timer); reject(new Error(`Character long-phase replay exited early (${code}).`)); });
    });
    browser = await chromium.connectOverCDP(endpoint, { timeout: 12000 });
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 12000 });
    page.setDefaultTimeout(12000);
    const canvas = page.locator('.bench-guide-card .frieren-guide canvas');
    await expect(canvas).toBeVisible();
    await expect(page.locator('.bench-guide-card .frieren-guide')).toHaveAttribute('data-expression', 'neutral');
    const initialBox = await canvas.boundingBox();
    expect(initialBox).not.toBeNull();

    await page.evaluate(() => {
      const actualRaf = window.requestAnimationFrame.bind(window);
      let lastReal = -Infinity;
      let virtualNow = performance.now();
      let frames = 0;
      window.requestAnimationFrame = (callback: FrameRequestCallback) => actualRaf(realNow => {
        // Hidden Electron throttles native rAF near 1 Hz; jump three minutes per real paint.
        if (realNow !== lastReal) { virtualNow += 180_000; lastReal = realNow; frames += 1; }
        callback(virtualNow);
      });
      (window as any).__longPhaseClock = () => ({ virtualNow, frames });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    let result;
    try {
      result = await page.evaluate(async () => {
        const element = document.querySelector('.bench-guide-card .frieren-guide canvas') as HTMLCanvasElement;
        const context = element?.getContext('2d');
        if (!context) throw new Error('Character canvas is unavailable.');
        const regions = {
          face: { x0: .43, y0: .13, x1: .57, y1: .24 },
          outer: { x0: .04, y0: .35, x1: .34, y1: .88 },
        };
        const hashRegion = (box: typeof regions.face) => {
          const ratio = .75;
          const width = Math.floor(Math.min(element.width, element.height * ratio));
          const height = Math.floor(width / ratio);
          const left = Math.floor((element.width - width) / 2);
          const top = element.height - height;
          const pixels = context.getImageData(left + Math.floor(width * box.x0), top + Math.floor(height * box.y0),
            Math.max(1, Math.floor(width * (box.x1 - box.x0))), Math.max(1, Math.floor(height * (box.y1 - box.y0)))).data;
          let hash = 2166136261;
          let opaque = 0;
          for (let index = 0; index < pixels.length; index += 4) {
            if (pixels[index + 3] > 0) opaque += 1;
            for (let channel = 0; channel < 4; channel += 1) hash = Math.imul(hash ^ pixels[index + channel], 16777619);
          }
          return { hash: hash >>> 0, opaque };
        };
        const faceHashes = new Set<number>();
        const outerHashes = new Set<number>();
        let firstPhase = 0;
        let lastPhase = 0;
        let minFaceOpaque = Infinity;
        const samples = 16;
        for (let index = 0; index < samples; index += 1) {
          await new Promise<void>(resolveFrame => window.requestAnimationFrame(() => resolveFrame()));
          if (index < 2) continue;
          const phase = (window as any).__longPhaseClock().virtualNow;
          if (!firstPhase) firstPhase = phase;
          lastPhase = phase;
          const face = hashRegion(regions.face);
          const outer = hashRegion(regions.outer);
          faceHashes.add(face.hash);
          outerHashes.add(outer.hash);
          minFaceOpaque = Math.min(minFaceOpaque, face.opaque);
        }
        return { samples: samples - 2, phaseSpanSeconds: (lastPhase - firstPhase) / 1000,
          maxPhaseSeconds: lastPhase / 1000, faceHashes: [...faceHashes], outerHashCount: outerHashes.size,
          minFaceOpaque, canvasWidth: element.width, canvasHeight: element.height };
      });
    } catch (error) {
      await page.screenshot({ path: 'runtime/character-longphase-failure.png' }).catch(() => undefined);
      throw error;
    }
    console.log('character long-phase diagnostic', result);
    if (result.faceHashes.length !== 1 || result.minFaceOpaque <= 50 || result.outerHashCount <= 1 || result.phaseSpanSeconds < 1800) {
      await page.screenshot({ path: 'runtime/character-longphase-failure.png' });
    }
    expect(result.phaseSpanSeconds).toBeGreaterThanOrEqual(1800);
    expect(result.minFaceOpaque).toBeGreaterThan(50);
    expect(result.faceHashes, 'central face must remain pixel-stable').toHaveLength(1);
    expect(result.outerHashCount, 'outer cloth/arms must animate').toBeGreaterThan(1);
    const finalBox = await canvas.boundingBox();
    expect(finalBox).toEqual(initialBox);
    expect((await page.evaluate(() => (window as any).ohmpath.request('testAudit'))).modelCalls).toBe(0);
    await page.close();
    await expect.poll(() => desktop.exitCode, { timeout: 8000 }).toBe(0);
  } finally {
    if (desktop.exitCode === null) desktop.kill();
    if (browser) await browser.close().catch(() => undefined);
  }
});
