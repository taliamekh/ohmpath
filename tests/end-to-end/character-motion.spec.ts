import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

type Region = { x0: number; y0: number; x1: number; y1: number };
const EYES: Region = { x0: .42, y0: .17, x1: .61, y1: .21 };
const UPPER_FACE: Region = { x0: .43, y0: .12, x1: .61, y1: .16 };
const WAIST: Region = { x0: .45, y0: .51, x1: .55, y1: .72 };
const OUTER: Region = { x0: .04, y0: .35, x1: .34, y1: .88 };
const WHOLE: Region = { x0: 0, y0: 0, x1: 1, y1: 1 };

async function canvasHashes(page: import('@playwright/test').Page, region: Region) {
  return page.locator('.bench-guide-card .frieren-guide canvas').evaluate((canvas, box) => {
    const element = canvas as HTMLCanvasElement;
    const context = element.getContext('2d');
    if (!context) throw new Error('Character canvas is unavailable.');
    const ratio = .75;
    const width = Math.floor(Math.min(element.width, element.height * ratio));
    const height = Math.floor(width / ratio);
    const left = Math.floor((element.width - width) / 2);
    const top = element.height - height;
    const x = left + Math.floor(width * box.x0);
    const y = top + Math.floor(height * box.y0);
    const pixels = context.getImageData(x, y,
      Math.max(1, Math.floor(width * (box.x1 - box.x0))),
      Math.max(1, Math.floor(height * (box.y1 - box.y0)))).data;
    let hash = 2166136261;
    let opaque = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] > 0) opaque += 1;
      for (let channel = 0; channel < 4; channel += 1) {
        hash = Math.imul(hash ^ pixels[index + channel], 16777619);
      }
    }
    return { hash: hash >>> 0, opaque };
  }, region);
}

test('offline character motion blinks locally, anchors the waist, and obeys Reduce motion', async () => {
  const requireElectron = createRequire(resolve('package.json'));
  const dataDir = await mkdtemp(resolve(tmpdir(), 'ohmpath-character-replay-'));
  const desktop = spawn(requireElectron('electron'), [
    resolve('tests/electron/photo-help-replay-main.cjs'), '--remote-debugging-port=0',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  ], { env: { ...process.env, OHMPATH_REPLAY_DATA_DIR: dataDir }, windowsHide: true });
  let browser: import('@playwright/test').Browser | undefined;
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Offline character replay did not open.')), 15000);
      desktop.stderr.on('data', chunk => {
        const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      desktop.once('error', error => { clearTimeout(timer); reject(error); });
      desktop.once('exit', code => { clearTimeout(timer); reject(new Error(`Offline character replay exited early (${code}).`)); });
    });
    browser = await chromium.connectOverCDP(endpoint, { timeout: 12000 });
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 12000 });
    page.setDefaultTimeout(8000);

    // The replay window is deliberately hidden. Simulate its foreground visibility
    // without changing the production rig's behavior or starting any service.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.locator('.bench-guide-card .frieren-guide canvas')).toBeVisible();
    await expect.poll(async () => (await canvasHashes(page, UPPER_FACE)).opaque).toBeGreaterThan(50);
    await page.screenshot({ path: 'runtime/character-bench-idle.png', fullPage: true });

    const upperFaceHashes = new Set<number>();
    const waistHashes = new Set<number>();
    const outerHashes = new Set<number>();
    const wholeHashes = new Set<number>();
    const deadline = Date.now() + 7600; // Includes at least one 4.8-second blink cycle.
    while (Date.now() < deadline) {
      const [eyes, upperFace, waist, outer, whole] = await Promise.all([
        canvasHashes(page, EYES), canvasHashes(page, UPPER_FACE), canvasHashes(page, WAIST),
        canvasHashes(page, OUTER), canvasHashes(page, WHOLE),
      ]);
      expect(eyes.opaque).toBeGreaterThan(20);
      upperFaceHashes.add(upperFace.hash);
      waistHashes.add(waist.hash);
      outerHashes.add(outer.hash);
      wholeHashes.add(whole.hash);
      await page.waitForTimeout(90);
    }
    expect(upperFaceHashes.size, 'the hair and brows must stay anchored').toBe(1);
    expect(waistHashes.size, 'breathing must not expand or shift the waist').toBe(1);
    expect(outerHashes.size, 'outer cloth/arms should move').toBeGreaterThan(1);
    expect(wholeHashes.size, 'the displayed character should animate').toBeGreaterThan(1);

    // Keep one painted frame at the blink peak for close visual inspection.
    // This changes only the offline replay clock, then restores native rAF.
    const openEyes = await canvasHashes(page, EYES);
    await page.evaluate(() => {
      const nativeRaf = window.requestAnimationFrame.bind(window);
      (window as any).__restoreBlinkClock = () => { window.requestAnimationFrame = nativeRaf; };
      window.requestAnimationFrame = callback => nativeRaf(now =>
        callback(now + ((3150 - now % 4800 + 4800) % 4800)));
    });
    await expect.poll(async () => (await canvasHashes(page, EYES)).hash,
      { timeout: 3000 }).not.toBe(openEyes.hash);
    await page.locator('.bench-guide-card .frieren-guide').screenshot({ path: 'runtime/character-neutral-blink.png' });
    await page.evaluate(() => (window as any).__restoreBlinkClock());

    await page.getByRole('button', { name: 'Settings', exact: false }).first().click();
    const previews = page.locator('.guide-expression-preview figure');
    await expect(previews).toHaveCount(6);
    await expect.poll(async () => previews.locator('canvas').evaluateAll(canvases => canvases
      .filter(canvas => canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0
        && [...(canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data || [])]
          .some((value, index) => index % 4 === 3 && value > 0)).length)).toBe(6);
    await page.locator('.guide-expression-preview').screenshot({ path: 'runtime/character-six-expressions.png' });

    await page.getByRole('checkbox', { name: /Reduce motion/ }).check();
    await page.getByRole('button', { name: 'Live help', exact: false }).first().click();
    await expect(page.locator('.bench-guide-card .frieren-guide canvas')).toBeVisible();
    await expect.poll(async () => (await canvasHashes(page, WHOLE)).opaque).toBeGreaterThan(100);
    const still = await canvasHashes(page, WHOLE);
    await page.waitForTimeout(800);
    expect(await canvasHashes(page, WHOLE)).toEqual(still);

    const audit = await page.evaluate(() => (window as any).ohmpath.request('testAudit'));
    expect(audit.modelCalls).toBe(0);
    await page.close();
    await expect.poll(() => desktop.exitCode, { timeout: 8000 }).toBe(0);
  } finally {
    if (desktop.exitCode === null) desktop.kill();
    if (browser) await browser.close().catch(() => undefined);
  }
});
