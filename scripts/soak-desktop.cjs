// Optional software-only stability run. Chromium supplies a synthetic camera.
const { chromium } = require('@playwright/test');
const { spawn } = require('node:child_process');
const { mkdtemp, mkdir, writeFile } = require('node:fs/promises');
const { resolve, join } = require('node:path');
const { randomUUID } = require('node:crypto');

async function main() {
  const minutes = Number(process.argv[2] || 30);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) throw new Error('Choose 1 to 60 minutes.');
  const root = resolve(__dirname, '..');
  const reportRoot = join(root, 'runtime', 'soak');
  await mkdir(reportRoot, { recursive: true });
  const directory = await mkdtemp(join(reportRoot, 'run-'));
  const child = spawn(require('electron'), [root, '--remote-debugging-port=0', '--use-fake-device-for-media-stream'], {
    env: { ...process.env, OHMPATH_HEADLESS: '1', OHMPATH_DATA_DIR: directory }, windowsHide: true,
  });
  let browser;
  const report = { started_at: new Date().toISOString(), requested_minutes: minutes, mode: 'software_only_synthetic_camera',
    hardware_verification: 'pending', live_model_calls: 0, cycles: 0, failures: [], samples: [] };
  const reportPath = join(reportRoot, 'latest-report.json');
  try {
    const endpoint = await new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Desktop did not open its test endpoint')), 15000);
      child.stderr.on('data', chunk => { const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); accept(match[1]); } });
      child.once('error', reject);
    });
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page');
    page.setDefaultTimeout(12000);
    await page.getByRole('button', { name: 'Create practice bench' }).click();
    const sid = await page.evaluate(async () => (await window.ohmpath.request('sessions'))[0].session_id);
    await page.evaluate(async sid => {
      await window.ohmpath.request('setup', { sid, power_state: 'on_current_limited', setup: { low_voltage_confirmed: true } });
      await window.ohmpath.request('openCompanion');
    }, sid);
    await page.getByRole('button', { name: 'Devices', exact: false }).click();
    await page.getByRole('button', { name: 'Enable camera & list devices' }).click();
    await page.getByLabel('CAMERA DEVICE').selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Connect selected camera' }).click();
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      return video?.srcObject && video.videoWidth > 0 && video.readyState >= 2;
    });
    const deadline = Date.now() + minutes * 60000;
    while (Date.now() < deadline) {
      const began = Date.now();
      const sample = await page.evaluate(async ({ sid, ordinal, utterance }) => {
        const api = window.ohmpath;
        const request = await api.request('requestMeasurement', { sid, quantity: 'voltage', meter_mode: 'DC_voltage', red_node_id: 'B', black_node_id: 'GND' });
        const pending = await api.request('voiceText', { sid, utterance_id: utterance, request_id: request.request_id, text: 'I read one point one volts' });
        const conf = pending.result.confirmation;
        if (!conf || conf.readback_completed) throw new Error('Unexpected confirmation state');
        await api.request('readback', { sid, confirmation_id: conf.confirmation_id });
        const fields = Object.fromEntries(['confirmation_id', 'candidate_id', 'request_id', 'measurement_context_hash', 'revisions'].map(key => [key, conf[key]]));
        const event = await api.request('confirm', { sid, ...fields });
        if (event.payload.evidence_kind !== 'simulated_user_input') throw new Error('Incorrect practice provenance');
        let solver = 'not_requested';
        if (ordinal % 6 === 0) {
          const solved = await api.request('simulate', { sid });
          if (solved.payload.status !== 'succeeded') throw new Error('Local solver failed');
          solver = solved.payload.provenance;
        }
        const events = await api.request('events', { sid });
        if (!events.some(row => row.event_id === event.event_id)) throw new Error('Latest evidence is missing');
        const video = document.querySelector('video');
        if (!video || !video.srcObject || video.videoWidth < 1) throw new Error('Synthetic preview disconnected');
        await api.request('updateCompanion', { activity: 'idle', caption: 'Software stability check completed.', reducedMotion: true });
        return { sequence: event.sequence, recent_event_count: events.length, solver, frame_time_s: video.currentTime,
          js_heap_bytes: performance.memory?.usedJSHeapSize ?? null };
      }, { sid, ordinal: report.cycles, utterance: randomUUID() });
      report.cycles++;
      report.samples.push({ cycle: report.cycles, duration_ms: Date.now() - began, ...sample });
      await writeFile(reportPath, JSON.stringify(report, null, 2));
      if (report.cycles % 6 === 0) console.log(JSON.stringify({ cycles: report.cycles, elapsed_minutes: Math.round((Date.now() - Date.parse(report.started_at)) / 6000) / 10 }));
      await new Promise(resolveSleep => setTimeout(resolveSleep, Math.min(10000, Math.max(0, deadline - Date.now()))));
    }
    await page.evaluate(async sid => { await window.ohmpath.request('pause', { sid }); await window.ohmpath.request('piVideoDisconnect'); }, sid);
    await page.close();
    await new Promise((accept, reject) => {
      if (child.exitCode !== null) return child.exitCode === 0 ? accept() : reject(new Error('Desktop exit failed'));
      const timer = setTimeout(() => reject(new Error('Desktop shutdown timed out')), 12000);
      child.once('exit', code => { clearTimeout(timer); code === 0 ? accept() : reject(new Error('Desktop exit failed')); });
    });
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.failures.push(String(error.message).slice(0, 300));
    process.exitCode = 1;
  } finally {
    if (child.exitCode === null) child.kill();
    if (browser) await browser.close().catch(() => {});
    report.finished_at = new Date().toISOString();
    report.duration_seconds = Math.round((Date.parse(report.finished_at) - Date.parse(report.started_at)) / 1000);
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, cycles: report.cycles, duration_seconds: report.duration_seconds }));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
