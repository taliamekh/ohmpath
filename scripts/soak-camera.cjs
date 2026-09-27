// Software-only camera stability check. The renderer receives a canvas stream,
// never an OS camera or microphone. This script never invokes Ask or speech.
const { chromium } = require('@playwright/test');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, mkdir, writeFile } = require('node:fs/promises');
const { resolve, join } = require('node:path');

const runFile = promisify(execFile);
const root = resolve(__dirname, '..');
const reportRoot = join(root, 'runtime', 'camera-soak');
const reportPath = join(reportRoot, 'latest-report.json');

function durationArgument(value) {
  if (value === undefined) return 20;
  if (!/^(?:[1-9]|[12]\d|30)$/.test(value)) throw new Error('Choose a whole number of minutes from 1 to 30.');
  return Number(value);
}

function delay(ms) { return new Promise(done => setTimeout(done, ms)); }

async function childBenchPids(parentPid) {
  if (process.platform !== 'win32') return null;
  if (!Number.isSafeInteger(parentPid) || parentPid < 1) throw new Error('Invalid desktop process ID.');
  const command = `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${parentPid}' | Where-Object { $_.Name -match '^python(w)?\\.exe$' } | ForEach-Object { $_.ProcessId }`;
  const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 10000, windowsHide: true });
  return stdout.split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function waitForExit(child, timeoutMs = 15000) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Desktop shutdown timed out.')), timeoutMs);
    child.once('exit', code => { clearTimeout(timer); accept(code); });
  });
}

async function installSyntheticCamera(page) {
  await page.evaluate(() => {
    if (!navigator.mediaDevices) throw new Error('Media devices are unavailable in this renderer.');
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext('2d');
    if (!context || !canvas.captureStream) throw new Error('Synthetic canvas video is unavailable.');
    let frame = 0;
    function paint() {
      frame += 1;
      context.fillStyle = '#17333a';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#5cd2bc';
      context.fillRect((frame * 7) % 590, 130, 50, 50);
      context.fillStyle = '#e1f5ed';
      context.font = '24px sans-serif';
      context.fillText(`SYNTHETIC ${frame}`, 24, 50);
    }
    paint();
    const timer = window.setInterval(paint, 67);
    const streams = [];
    const devices = navigator.mediaDevices;
    Object.defineProperty(devices, 'enumerateDevices', { configurable: true, value: async () => [
      { kind: 'videoinput', deviceId: 'soak-canvas', label: 'Synthetic canvas camera', groupId: 'soak' },
    ] });
    Object.defineProperty(devices, 'getUserMedia', { configurable: true, value: async constraints => {
      if (!constraints?.video || constraints.audio) throw new Error('Only synthetic silent video is allowed in this soak.');
      const stream = canvas.captureStream(15);
      if (stream.getVideoTracks().length !== 1) throw new Error('Synthetic video track was not created.');
      streams.push(stream);
      return stream;
    } });
    window.__ohmCameraSoak = { streams, stop: () => {
      window.clearInterval(timer);
      streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    } };
  });
}

async function sampleCamera(page, previous, sampleMs, baselines) {
  const sample = await page.evaluate(knownBaselines => {
    const camera = document.querySelector('.camera-workspace');
    const video = camera?.querySelector('.camera-workspace-overview video');
    const guide = camera?.querySelector('.camera-workspace-focus-guide [role="img"]');
    const canvas = guide?.querySelector('canvas');
    const image = guide?.querySelector('img');
    const track = video?.srcObject instanceof MediaStream ? video.srcObject.getVideoTracks()[0] : null;
    function regionHash(box) {
      if (!(canvas instanceof HTMLCanvasElement)) return null;
      const context = canvas.getContext('2d');
      if (!context || !canvas.width || !canvas.height) return null;
      const width = Math.floor(Math.min(canvas.width, canvas.height * .75));
      const height = Math.floor(width / .75);
      const left = Math.floor((canvas.width - width) / 2);
      const top = canvas.height - height;
      const pixels = context.getImageData(left + Math.floor(width * box[0]), top + Math.floor(height * box[1]),
        Math.max(1, Math.floor(width * (box[2] - box[0]))),
        Math.max(1, Math.floor(height * (box[3] - box[1])))).data;
      let hash = 2166136261;
      let opaque = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] > 0) opaque += 1;
        for (let channel = 0; channel < 4; channel += 1) hash = Math.imul(hash ^ pixels[index + channel], 16777619);
      }
      return { hash: hash >>> 0, opaque };
    }
    const bounds = guide?.getBoundingClientRect();
    const canvasBounds = canvas?.getBoundingClientRect();
    const sample = {
      focused: Boolean(camera?.classList.contains('is-focused')),
      video_time: video?.currentTime ?? -1,
      video_frames: video?.getVideoPlaybackQuality?.().totalVideoFrames ?? null,
      video_width: video?.videoWidth ?? 0,
      track_state: track?.readyState ?? 'none',
      guide_present: Boolean(guide && guide.getBoundingClientRect().width > 0
        && ((canvas && canvas.width > 0 && canvas.height > 0) || (image && image.complete && image.naturalWidth > 0))),
      // Eyelids intentionally blink. Sample the lower face and central waist
      // independently so blinking cannot disguise a shifting head or torso.
      upper_face: regionHash([.43, .12, .61, .16]),
      face: regionHash([.44, .215, .60, .255]),
      waist: regionHash([.45, .51, .55, .72]),
      outer: regionHash([.04, .35, .34, .88]),
      guide_geometry: canvas ? `${canvas.width}x${canvas.height}` : 'none',
      guide_expression: guide?.getAttribute('data-expression') ?? 'none',
      guide_activity: [...(guide?.classList ?? [])].find(value => value.startsWith('activity-')) ?? 'none',
      guide_bounds: bounds ? [bounds.x, bounds.y, bounds.width, bounds.height].map(Math.round).join(',') : 'none',
      canvas_bounds: canvasBounds ? [canvasBounds.x, canvasBounds.y, canvasBounds.width, canvasBounds.height].map(Math.round).join(',') : 'none',
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      device_pixel_ratio: window.devicePixelRatio,
    };
    const rasterKey = [sample.guide_geometry, sample.guide_expression, sample.guide_activity].join('|');
    const baseline = knownBaselines[rasterKey];
    const stable = { upper_face: sample.upper_face?.hash, lower_face: sample.face?.hash,
      waist: sample.waist?.hash };
    if (canvas instanceof HTMLCanvasElement && (!baseline
        || Object.keys(stable).some(region => stable[region] !== baseline[region]))) {
      // Capture in this renderer turn, before another animation frame can paint.
      sample.canvas_data_url = canvas.toDataURL('image/png');
    }
    return sample;
  }, Object.fromEntries(baselines));
  if (!sample.focused || sample.video_width < 1 || sample.track_state !== 'live' || !sample.guide_present)
    throw new Error(`Camera or animated guide disappeared: ${JSON.stringify(sample)}`);
  // A one-second diagnostic interval can land between decoded frames. Keep
  // the normal ten-second threshold while scaling the short-interval check.
  const minimumVideoProgress = Math.min(0.2, sampleMs / 20000);
  if (previous && sample.video_time < previous.video_time + minimumVideoProgress)
    throw new Error(`Synthetic video time stopped (${previous.video_time} to ${sample.video_time}).`);
  if (previous && sample.video_frames !== null && previous.video_frames !== null
      && sample.video_frames <= previous.video_frames)
    throw new Error('Synthetic video decoded frame count stopped.');
  if (!sample.upper_face || sample.upper_face.opaque < 50 || !sample.face || sample.face.opaque < 50
      || !sample.waist || sample.waist.opaque < 50 || !sample.outer || sample.outer.opaque < 50)
    throw new Error('Animated guide canvas was blank.');
  return sample;
}

async function saveGuideCanvas(dataUrl, name) {
  if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('Guide pixel capture was not PNG.');
  const path = join(reportRoot, name);
  await writeFile(path, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'));
  return path;
}

async function exerciseCamera(page, ordinal, report) {
  const camera = page.getByRole('region', { name: 'Camera workspace' });
  if (ordinal % 2 === 0) {
    const current = camera.getByRole('button', { name: 'Subtitles on' }).first();
    const on = await current.count() > 0;
    await camera.getByRole('button', { name: on ? 'Subtitles on' : 'Subtitles off' }).first().click();
    report.subtitle_toggles += 1;
  } else {
    await camera.getByRole('button', { name: 'Exit full screen' }).last().click();
    await camera.getByRole('button', { name: 'Full screen', exact: true }).click();
    await camera.locator('.camera-workspace-focus-guide [role="img"]').waitFor({ state: 'visible' });
    report.focus_cycles += 1;
  }
  if (ordinal % 3 === 0) {
    // This button selects one local still for the inline question workspace.
    await camera.getByRole('button', { name: 'Ask question about circuit' }).click();
    const review = camera.getByRole('region', { name: 'Ask question about circuit' });
    await review.getByText('Overview snapshot').first().waitFor({ state: 'visible' });
    await review.getByRole('button', { name: 'Remove Overview snapshot' }).click();
    await review.getByText('Start with an image').waitFor({ state: 'visible' });
    await review.getByRole('button', { name: 'Close question workspace' }).click();
    report.snapshots_reviewed_removed += 1;
  }
}

async function main() {
  const minutes = durationArgument(process.argv[2]); // Validate before any app or filesystem work.
  const diagnosticCycleMs = process.env.OHMPATH_SOAK_DIAGNOSTIC_CYCLE_MS;
  const cycleMs = diagnosticCycleMs === undefined ? 60000 : Number(diagnosticCycleMs);
  if (!Number.isSafeInteger(cycleMs) || cycleMs < 10000 || cycleMs > 60000)
    throw new Error('Diagnostic cycle must be 10000 to 60000 milliseconds.');
  const diagnosticSampleMs = process.env.OHMPATH_SOAK_DIAGNOSTIC_SAMPLE_MS;
  const sampleMs = diagnosticSampleMs === undefined ? 10000 : Number(diagnosticSampleMs);
  if (!Number.isSafeInteger(sampleMs) || sampleMs < 1000 || sampleMs > 10000)
    throw new Error('Diagnostic sample interval must be 1000 to 10000 milliseconds.');
  await mkdir(reportRoot, { recursive: true });
  const dataDir = await mkdtemp(join(reportRoot, 'data-'));
  const report = { started_at: new Date().toISOString(), requested_minutes: minutes,
    mode: 'software_only_synthetic_canvas_video', status: 'running', video_samples: 0,
    cycle_seconds: cycleMs / 1000, sample_seconds: sampleMs / 1000,
    guide_geometry_changes: 0, guide_layout_changes: 0,
    focus_cycles: 0, subtitle_toggles: 0, snapshots_reviewed_removed: 0,
    samples: [], raster_baselines: [],
    page_errors: [], failures: [], electron_exit_code: null, bench_pids: [], bench_exited: null,
    model_calls: 0, audio_calls: 0, physical_camera_calls: 0,
    memory_note: 'JavaScript heap and process memory are not measured; browser allocations are not reliable leak evidence.' };
  const child = spawn(require('electron'), [root, '--remote-debugging-port=0', '--use-fake-device-for-media-stream',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'], {
    env: { ...process.env, OHMPATH_HEADLESS: '1', OHMPATH_DATA_DIR: dataDir }, windowsHide: true,
  });
  let browser;
  let page;
  try {
    const endpoint = await new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Desktop did not open its local debug endpoint.')), 20000);
      child.stderr.on('data', chunk => {
        const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Desktop exited early (${code}).`)); });
    });
    browser = await chromium.connectOverCDP(endpoint, { timeout: 12000 });
    const context = browser.contexts()[0];
    page = context.pages()[0] || await context.waitForEvent('page', { timeout: 12000 });
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => report.page_errors.push(`page: ${error.message.slice(0, 300)}`));
    page.on('crash', () => report.page_errors.push('Renderer crashed.'));
    page.on('console', message => { if (message.type() === 'error') report.page_errors.push(`console: ${message.text().slice(0, 300)}`); });
    // The Electron window stays hidden. Simulate foreground visibility so the
    // guide's real animation loop runs, as in the dedicated character test.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await installSyntheticCamera(page);
    const camera = page.getByRole('region', { name: 'Camera workspace' });
    await camera.getByText('Camera setup').click();
    await camera.getByRole('button', { name: 'Enable & list cameras' }).click();
    await camera.getByLabel('Camera device').selectOption('soak-canvas');
    await camera.getByRole('button', { name: 'Turn on overview' }).click();
    await camera.locator('video').waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const video = document.querySelector('.camera-workspace-overview video');
      return video && video.videoWidth > 0 && video.srcObject instanceof MediaStream;
    });
    await camera.getByRole('button', { name: 'Full screen', exact: true }).click();
    await camera.locator('.camera-workspace-focus-guide [role="img"]').waitFor({ state: 'visible' });
    try { report.bench_pids = await childBenchPids(child.pid) || []; }
    catch { report.bench_pids = []; }
    if (process.platform === 'win32' && report.bench_pids.length < 1)
      throw new Error('Could not identify the private bench child process for exit verification.');
    const deadline = Date.now() + minutes * 60000;
    report.soak_started_at = new Date().toISOString();
    let nextMinute = Date.now() + cycleMs;
    let previous;
    const baselines = new Map();
    const outerHashes = new Map();
    let previousRasterKey = null;
    let previousLayoutKey = null;
    let cycle = 0;
    async function inspectSample() {
      const current = await sampleCamera(page, previous, sampleMs, baselines);
      const canvasDataUrl = current.canvas_data_url;
      delete current.canvas_data_url;
      previous = current;
      report.video_samples += 1;
      if (current.guide_expression !== 'neutral' || current.guide_activity !== 'activity-idle')
        throw new Error(`Guide pose changed unexpectedly: ${current.guide_expression}/${current.guide_activity}.`);
      const rasterKey = [current.guide_geometry, current.guide_expression, current.guide_activity].join('|');
      const layoutKey = [current.guide_bounds, current.canvas_bounds, current.viewport, current.device_pixel_ratio].join('|');
      if (previousRasterKey !== null && rasterKey !== previousRasterKey) report.guide_geometry_changes += 1;
      if (previousLayoutKey !== null && layoutKey !== previousLayoutKey) report.guide_layout_changes += 1;
      previousRasterKey = rasterKey;
      previousLayoutKey = layoutKey;
      const baseline = baselines.get(rasterKey);
      const stable = { upper_face: current.upper_face.hash, lower_face: current.face.hash, waist: current.waist.hash };
      if (!baseline) {
        baselines.set(rasterKey, stable);
        report.raster_baselines.push({ raster_key: rasterKey, hashes: stable, first_sample: report.video_samples });
        if (report.raster_baselines.length === 1) {
          report.baseline_canvas = await saveGuideCanvas(canvasDataUrl, 'diagnostic-baseline-canvas.png');
        }
      } else if (Object.keys(stable).some(region => stable[region] !== baseline[region])) {
        report.samples.push({ at: new Date().toISOString(), number: report.video_samples, ...current });
        report.mismatch_canvas = await saveGuideCanvas(canvasDataUrl, 'diagnostic-mismatch-canvas.png');
        throw new Error(`Animated guide changed at a previously seen raster geometry: baseline=${JSON.stringify(baseline)}, current=${JSON.stringify(stable)}, raster=${rasterKey}, layout=${layoutKey}.`);
      }
      if (!outerHashes.has(rasterKey)) outerHashes.set(rasterKey, new Set());
      outerHashes.get(rasterKey).add(current.outer.hash);
      report.guide_outer_distinct_frames = Math.max(...[...outerHashes.values()].map(hashes => hashes.size));
      report.samples.push({ at: new Date().toISOString(), number: report.video_samples, ...current });
      if (report.page_errors.length) throw new Error(`Renderer error: ${report.page_errors[0]}`);
    }
    await delay(250);
    await inspectSample();
    while (Date.now() < deadline) {
      await delay(Math.min(sampleMs, Math.max(0, deadline - Date.now())));
      if (Date.now() >= deadline) break;
      await inspectSample();
      if (Date.now() >= nextMinute) {
        cycle += 1;
        await exerciseCamera(page, cycle, report);
        await delay(250); // Let a remounted focus guide paint its first frame.
        await inspectSample(); // Validate the first frame after every focus or subtitle transition.
        console.log(JSON.stringify({ cycle, elapsed_minutes: Math.round((Date.now() - Date.parse(report.started_at)) / 6000) / 10,
          requested_minutes: minutes, video_samples: report.video_samples,
          focus_cycles: report.focus_cycles, subtitle_toggles: report.subtitle_toggles,
          snapshots_reviewed_removed: report.snapshots_reviewed_removed }));
        await writeFile(reportPath, JSON.stringify(report, null, 2));
        nextMinute += cycleMs;
      }
    }
    if (report.video_samples < minutes * 4) throw new Error('Too few decoded video checks for requested duration.');
    if (![...outerHashes.values()].some(hashes => hashes.size > 1))
      throw new Error('The guide was present but its outer cloth never animated at a fixed raster size.');
    // The app's Disconnect action must stop its stream before the renderer closes.
    await camera.getByRole('button', { name: 'Exit full screen' }).last().click();
    await camera.getByRole('button', { name: 'Turn off overview' }).click();
    const stopped = await page.evaluate(() => {
      const video = document.querySelector('.camera-workspace-overview video');
      const tracks = window.__ohmCameraSoak?.streams.flatMap(stream => stream.getVideoTracks()) || [];
      return { detached: video?.srcObject === null, all_ended: tracks.length >= 2 && tracks.every(track => track.readyState === 'ended') };
    });
    if (!stopped.detached || !stopped.all_ended) throw new Error('Synthetic video track survived camera disconnect.');
    await page.evaluate(() => window.__ohmCameraSoak?.stop());
    await page.close();
    report.electron_exit_code = await waitForExit(child);
    if (report.electron_exit_code !== 0) throw new Error(`Desktop exited with code ${report.electron_exit_code}.`);
    report.bench_exited = report.bench_pids.every(pid => !processAlive(pid));
    if (!report.bench_exited) throw new Error('Private bench process survived desktop shutdown.');
    report.status = 'passed';
    report.verified_soak_seconds = Math.round((Date.now() - Date.parse(report.soak_started_at)) / 1000);
  } catch (error) {
    report.status = 'failed';
    report.failure_detail = String(error.message || error).slice(0, 1200);
    report.failures.push(String(error.message || error).slice(0, 300));
    if (page && !page.isClosed()) {
      await page.screenshot({ path: join(reportRoot, 'failure-screenshot.png'), timeout: 5000 }).catch(() => {});
    }
    process.exitCode = 1;
  } finally {
    if (page && !page.isClosed()) {
      report.synthetic_tracks_stopped = await page.evaluate(() => {
        window.__ohmCameraSoak?.stop();
        const tracks = window.__ohmCameraSoak?.streams.flatMap(stream => stream.getTracks()) || [];
        return tracks.length > 0 && tracks.every(track => track.readyState === 'ended');
      }).catch(() => false);
      await page.close().catch(() => {});
    }
    if (child.exitCode === null) {
      await waitForExit(child, 12000).catch(() => child.kill());
    }
    report.electron_exit_code = child.exitCode;
    if (report.bench_pids.length) {
      report.bench_exited = report.bench_pids.every(pid => !processAlive(pid));
    }
    if (browser) await browser.close().catch(() => {});
    report.finished_at = new Date().toISOString();
    report.duration_seconds = Math.round((Date.parse(report.finished_at) - Date.parse(report.started_at)) / 1000);
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, duration_seconds: report.duration_seconds,
      video_samples: report.video_samples, focus_cycles: report.focus_cycles,
      subtitle_toggles: report.subtitle_toggles, snapshots_reviewed_removed: report.snapshots_reviewed_removed,
      page_errors: report.page_errors.length, failures: report.failures.length, bench_exited: report.bench_exited }));
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
