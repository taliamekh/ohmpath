import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('fixed character pose keeps its head and waist anchored through long animation phases', async () => {
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
          upperFace: { x0: .43, y0: .12, x1: .61, y1: .16 },
          lowerFace: { x0: .44, y0: .215, x1: .60, y1: .255 },
          waist: { x0: .45, y0: .51, x1: .55, y1: .72 },
          outer: { x0: .04, y0: .35, x1: .34, y1: .88 },
        };
        const hashRegion = (box: typeof regions.upperFace) => {
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
        const upperFaceHashes = new Set<number>();
        const lowerFaceHashes = new Set<number>();
        const waistHashes = new Set<number>();
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
          const upperFace = hashRegion(regions.upperFace);
          const lowerFace = hashRegion(regions.lowerFace);
          const waist = hashRegion(regions.waist);
          const outer = hashRegion(regions.outer);
          upperFaceHashes.add(upperFace.hash);
          lowerFaceHashes.add(lowerFace.hash);
          waistHashes.add(waist.hash);
          outerHashes.add(outer.hash);
          minFaceOpaque = Math.min(minFaceOpaque, upperFace.opaque, lowerFace.opaque);
        }
        return { samples: samples - 2, phaseSpanSeconds: (lastPhase - firstPhase) / 1000,
          maxPhaseSeconds: lastPhase / 1000, upperFaceHashes: [...upperFaceHashes],
          lowerFaceHashes: [...lowerFaceHashes], waistHashes: [...waistHashes], outerHashCount: outerHashes.size,
          minFaceOpaque, canvasWidth: element.width, canvasHeight: element.height };
      });
    } catch (error) {
      await page.screenshot({ path: 'runtime/character-longphase-failure.png' }).catch(() => undefined);
      throw error;
    }
    console.log('character long-phase diagnostic', result);
    if (result.upperFaceHashes.length !== 1 || result.lowerFaceHashes.length !== 1
        || result.waistHashes.length !== 1 || result.minFaceOpaque <= 50
        || result.outerHashCount <= 1 || result.phaseSpanSeconds < 1800) {
      await page.screenshot({ path: 'runtime/character-longphase-failure.png' });
    }
    expect(result.phaseSpanSeconds).toBeGreaterThanOrEqual(1800);
    expect(result.minFaceOpaque).toBeGreaterThan(50);
    expect(result.upperFaceHashes, 'hair and brows must remain pixel-stable').toHaveLength(1);
    expect(result.lowerFaceHashes, 'lower face must remain pixel-stable').toHaveLength(1);
    expect(result.waistHashes, 'waist must remain pixel-stable').toHaveLength(1);
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

test('camera focus remounts keep fixed pixels through accelerated long animation phases', async () => {
  const requireElectron = createRequire(resolve('package.json'));
  const dataDir = await mkdtemp(resolve(tmpdir(), 'ohmpath-character-camera-phase-'));
  const desktop = spawn(requireElectron('electron'), [
    resolve('tests/electron/photo-help-replay-main.cjs'), '--remote-debugging-port=0',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  ], { env: { ...process.env, OHMPATH_REPLAY_DATA_DIR: dataDir }, windowsHide: true });
  let browser: import('@playwright/test').Browser | undefined;
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Character camera replay did not open.')), 15000);
      desktop.stderr.on('data', chunk => {
        const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      desktop.once('error', error => { clearTimeout(timer); reject(error); });
      desktop.once('exit', code => { clearTimeout(timer); reject(new Error(`Character camera replay exited early (${code}).`)); });
    });
    browser = await chromium.connectOverCDP(endpoint, { timeout: 12000 });
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 12000 });
    page.setDefaultTimeout(12000);
    await page.evaluate(() => {
      // Drive the real character renderer with a monotonic clock while keeping
      // each test paint short enough to exercise many readbacks and remounts.
      let virtualNow = performance.now();
      const origin = virtualNow;
      window.requestAnimationFrame = callback => window.setTimeout(() => {
        virtualNow += 50;
        callback(virtualNow);
      }, 16);
      window.cancelAnimationFrame = handle => window.clearTimeout(handle);
      (window as any).__cameraPhaseClock = {
        advanceTo: (elapsedMs: number) => { virtualNow = Math.max(virtualNow, origin + elapsedMs); },
        seconds: () => (virtualNow - origin) / 1000,
      };
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));

      const source = document.createElement('canvas');
      source.width = 640;
      source.height = 360;
      const sourceContext = source.getContext('2d');
      if (!sourceContext || !source.captureStream) throw new Error('Synthetic camera canvas unavailable.');
      let frame = 0;
      const paint = () => {
        sourceContext.fillStyle = '#17333a';
        sourceContext.fillRect(0, 0, source.width, source.height);
        sourceContext.fillStyle = '#5cd2bc';
        sourceContext.fillRect((frame++ * 7) % 590, 130, 50, 50);
      };
      paint();
      const timer = window.setInterval(paint, 67);
      const streams: MediaStream[] = [];
      Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true,
        value: async () => [{ kind: 'videoinput', deviceId: 'phase-canvas', label: 'Synthetic canvas camera', groupId: 'phase' }] });
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true,
        value: async (constraints: MediaStreamConstraints) => {
          if (!constraints.video || constraints.audio) throw new Error('Only silent synthetic video is allowed.');
          const stream = source.captureStream(15);
          streams.push(stream);
          return stream;
        } });
      (window as any).__cameraPhaseStop = () => {
        window.clearInterval(timer);
        streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
        return streams.length > 0 && streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'));
      };
    });

    const camera = page.getByRole('region', { name: 'Camera workspace' });
    await camera.getByText('Camera setup').click();
    await camera.getByRole('button', { name: 'Enable & list cameras' }).click();
    await camera.getByLabel('Camera device').selectOption('phase-canvas');
    await camera.getByRole('button', { name: 'Connect selected' }).click();
    await expect.poll(() => camera.locator('video').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
    await camera.getByRole('button', { name: 'Full screen', exact: true }).click();

    const readPixels = () => page.evaluate(async () => {
      await new Promise<void>(done => window.requestAnimationFrame(() => window.requestAnimationFrame(() => done())));
      const guide = document.querySelector('.camera-workspace-focus-guide [role="img"]');
      const canvas = guide?.querySelector('canvas');
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Focused character canvas unavailable.');
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Focused character pixels unavailable.');
      const ratio = .75;
      const width = Math.floor(Math.min(canvas.width, canvas.height * ratio));
      const height = Math.floor(width / ratio);
      const left = Math.floor((canvas.width - width) / 2);
      const top = canvas.height - height;
      const hashRegion = (box: [number, number, number, number]) => {
        const pixels = ctx.getImageData(left + Math.floor(width * box[0]), top + Math.floor(height * box[1]),
          Math.max(1, Math.floor(width * (box[2] - box[0]))),
          Math.max(1, Math.floor(height * (box[3] - box[1])))).data;
        let hash = 2166136261;
        let opaque = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] > 0) opaque += 1;
          for (let channel = 0; channel < 4; channel += 1) hash = Math.imul(hash ^ pixels[index + channel], 16777619);
        }
        return { hash: hash >>> 0, opaque };
      };
      const bounds = canvas.getBoundingClientRect();
      return {
        phaseSeconds: (window as any).__cameraPhaseClock.seconds(),
        geometry: `${canvas.width}x${canvas.height}`,
        bounds: [bounds.x, bounds.y, bounds.width, bounds.height].map(Math.round).join(','),
        expression: guide?.getAttribute('data-expression'),
        activity: [...(guide?.classList ?? [])].find(value => value.startsWith('activity-')),
        upperFace: hashRegion([.43, .12, .61, .16]),
        lowerFace: hashRegion([.44, .215, .60, .255]),
        waist: hashRegion([.45, .51, .55, .72]),
        outer: hashRegion([.04, .35, .34, .88]),
      };
    });
    const phasesMs = [0, 180_000, 360_000, 540_000, 720_000, 900_000,
      1_064_000, 1_200_000, 1_500_000, 1_800_000];
    let baseline: Awaited<ReturnType<typeof readPixels>> | undefined;
    const outerHashes = new Set<number>();
    let readbacks = 0;
    let lastPhase = 0;
    try {
      for (const [index, phaseMs] of phasesMs.entries()) {
        await page.evaluate(value => (window as any).__cameraPhaseClock.advanceTo(value), phaseMs);
        await expect(camera.locator('.camera-workspace-focus-guide [role="img"]')).toBeVisible();
        for (let readback = 0; readback < 10; readback += 1) {
          const sample = await readPixels();
          if (!baseline) baseline = sample;
          expect(sample.phaseSeconds).toBeGreaterThanOrEqual(phaseMs / 1000);
          expect(sample.geometry).toBe(baseline.geometry);
          expect(sample.bounds).toBe(baseline.bounds);
          expect(sample.expression).toBe('neutral');
          expect(sample.activity).toBe('activity-idle');
          expect(sample.upperFace.opaque).toBeGreaterThan(50);
          expect(sample.lowerFace.opaque).toBeGreaterThan(50);
          expect(sample.waist.opaque).toBeGreaterThan(50);
          expect(sample.upperFace.hash, `upper face at readback ${readbacks + 1}`).toBe(baseline.upperFace.hash);
          expect(sample.lowerFace.hash, `lower face at readback ${readbacks + 1}`).toBe(baseline.lowerFace.hash);
          expect(sample.waist.hash, `waist at readback ${readbacks + 1}`).toBe(baseline.waist.hash);
          outerHashes.add(sample.outer.hash);
          lastPhase = sample.phaseSeconds;
          readbacks += 1;
        }
        if (index < phasesMs.length - 1) {
          await camera.getByRole('button', { name: 'Exit full screen' }).last().click();
          await camera.getByRole('button', { name: 'Full screen', exact: true }).click();
        }
      }
    } catch (error) {
      await page.screenshot({ path: 'runtime/character-camera-phase-failure.png' }).catch(() => undefined);
      throw error;
    }
    expect(readbacks).toBe(100);
    expect(lastPhase).toBeGreaterThanOrEqual(1800);
    expect(outerHashes.size).toBeGreaterThan(1);
    expect((await page.evaluate(() => (window as any).ohmpath.request('testAudit'))).modelCalls).toBe(0);
    await camera.getByRole('button', { name: 'Exit full screen' }).last().click();
    await camera.getByRole('button', { name: 'Disconnect overview' }).click();
    expect(await page.evaluate(() => (window as any).__cameraPhaseStop())).toBe(true);
    await page.close();
    await expect.poll(() => desktop.exitCode, { timeout: 8000 }).toBe(0);
    console.log('character camera phase diagnostic', { readbacks, focusReentries: phasesMs.length - 1,
      lastPhaseSeconds: lastPhase, outerFrames: outerHashes.size });
  } finally {
    if (desktop.exitCode === null) desktop.kill();
    if (browser) await browser.close().catch(() => undefined);
  }
});
