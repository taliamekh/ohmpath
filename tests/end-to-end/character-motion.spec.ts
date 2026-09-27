import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

type Region = { x0: number; y0: number; x1: number; y1: number };
const EYES: Region = { x0: .42, y0: .17, x1: .61, y1: .21 };
const LEFT_EYE: Region = { x0: .41, y0: .165, x1: .50, y1: .215 };
const RIGHT_EYE: Region = { x0: .53, y0: .165, x1: .63, y1: .215 };
const UPPER_FACE: Region = { x0: .43, y0: .12, x1: .61, y1: .16 };
const LOWER_FACE: Region = { x0: .44, y0: .215, x1: .60, y1: .255 };
const WAIST: Region = { x0: .45, y0: .51, x1: .55, y1: .72 };
const OUTER: Region = { x0: .04, y0: .35, x1: .34, y1: .88 };
const WHOLE: Region = { x0: 0, y0: 0, x1: 1, y1: 1 };

async function canvasHashes(page: import('@playwright/test').Page, region: Region) {
  return page.locator('.camera-workspace-focus-guide .frieren-guide canvas').evaluate((canvas, box) => {
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
    let iris = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] > 0) opaque += 1;
      if (pixels[index + 3] > 120 && pixels[index + 1] > 70
          && pixels[index + 1] > pixels[index] * 1.25
          && pixels[index + 2] > pixels[index] * 1.15) iris += 1;
      for (let channel = 0; channel < 4; channel += 1) {
        hash = Math.imul(hash ^ pixels[index + channel], 16777619);
      }
    }
    return { hash: hash >>> 0, opaque, iris };
  }, region);
}

async function forceBlinkClock(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const nativeRaf = window.requestAnimationFrame.bind(window);
    (window as any).__restoreBlinkClock = () => { window.requestAnimationFrame = nativeRaf; };
    window.requestAnimationFrame = callback => nativeRaf(now =>
      callback(now + ((3150 - now % 4800 + 4800) % 4800)));
  });
}

async function setOfflineGuideExpression(page: import('@playwright/test').Page,
                                         expression: 'thinking' | 'stumped') {
  // The replay deliberately has no fake investigator/model. Use the local React
  // state setter to inspect the real rig for the two other open-eye poses.
  await page.locator('.camera-workspace-focus-guide .frieren-guide').evaluate((element, next) => {
    const key = Object.keys(element).find(name => name.startsWith('__reactFiber$'));
    if (!key) throw new Error('Character React fiber was unavailable.');
    let fiber = (element as any)[key];
    const current = element.getAttribute('data-expression');
    while (fiber) {
      let hook = fiber.memoizedState;
      while (hook && typeof hook === 'object' && 'next' in hook) {
        if (hook.memoizedState === current && typeof hook.queue?.dispatch === 'function') {
          hook.queue.dispatch(next);
          return;
        }
        hook = hook.next;
      }
      fiber = fiber.return;
    }
    throw new Error('Guide expression setter was unavailable.');
  }, expression);
  await expect(page.locator('.camera-workspace-focus-guide .frieren-guide')).toHaveAttribute('data-expression', expression);
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
    await expect(page.locator('.camera-workspace-focus-guide .frieren-guide canvas')).toBeVisible();
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
    await expect.poll(async () => (await canvasHashes(page, LEFT_EYE)).iris).toBeGreaterThan(5);
    await expect.poll(async () => (await canvasHashes(page, RIGHT_EYE)).iris).toBeGreaterThan(5);
    const openLeftEye = await canvasHashes(page, LEFT_EYE);
    const openRightEye = await canvasHashes(page, RIGHT_EYE);
    const openLowerFace = await canvasHashes(page, LOWER_FACE);
    await forceBlinkClock(page);
    await expect.poll(async () => (await canvasHashes(page, LEFT_EYE)).hash,
      { timeout: 3000 }).not.toBe(openLeftEye.hash);
    await expect.poll(async () => (await canvasHashes(page, RIGHT_EYE)).hash,
      { timeout: 3000 }).not.toBe(openRightEye.hash);
    expect((await canvasHashes(page, LEFT_EYE)).iris, 'left iris must be fully covered at blink peak').toBe(0);
    expect((await canvasHashes(page, RIGHT_EYE)).iris, 'right iris must be fully covered at blink peak').toBe(0);
    expect((await canvasHashes(page, LOWER_FACE)).hash,
      'blink must leave the nose and lower face unchanged').toBe(openLowerFace.hash);
    await page.locator('.camera-workspace-focus-guide .frieren-guide').screenshot({ path: 'runtime/character-neutral-blink.png' });
    await page.evaluate(() => (window as any).__restoreBlinkClock());

    for (const expression of ['thinking', 'stumped'] as const) {
      await setOfflineGuideExpression(page, expression);
      await expect.poll(async () => (await canvasHashes(page, LEFT_EYE)).iris).toBeGreaterThan(5);
      await expect.poll(async () => (await canvasHashes(page, RIGHT_EYE)).iris).toBeGreaterThan(5);
      const poseLowerFace = await canvasHashes(page, LOWER_FACE);
      await page.locator('.camera-workspace-focus-guide .frieren-guide').screenshot({
        path: `runtime/character-${expression}-open.png`,
      });
      await forceBlinkClock(page);
      await expect.poll(async () => (await canvasHashes(page, LEFT_EYE)).iris,
        { timeout: 3000 }).toBe(0);
      await expect.poll(async () => (await canvasHashes(page, RIGHT_EYE)).iris,
        { timeout: 3000 }).toBe(0);
      expect((await canvasHashes(page, LOWER_FACE)).hash,
        `${expression} blink must leave the lower face unchanged`).toBe(poseLowerFace.hash);
      await page.locator('.camera-workspace-focus-guide .frieren-guide').screenshot({
        path: `runtime/character-${expression}-blink.png`,
      });
      await page.evaluate(() => (window as any).__restoreBlinkClock());
    }

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
    await expect(page.locator('.camera-workspace-focus-guide .frieren-guide canvas')).toBeVisible();
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
