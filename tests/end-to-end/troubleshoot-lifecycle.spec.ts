import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('obsolete troubleshooting replies cannot reappear after a context change or cancel', async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'ohmpath-troubleshoot-lifecycle-'));
  const requireElectron = createRequire(resolve('package.json'));
  const desktop = spawn(requireElectron('electron'), [resolve('tests/electron/troubleshoot-lifecycle-main.cjs'), '--remote-debugging-port=0'], {
    env: { ...process.env, OHMPATH_REPLAY_DATA_DIR: dataDir }, windowsHide: true,
  });
  let browser;
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Troubleshoot replay did not open')), 15000);
      desktop.stderr.on('data', chunk => {
        const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      desktop.once('error', error => { clearTimeout(timer); reject(error); });
    });
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page');
    const audit = () => page.evaluate(() => (window as any).ohmpath.request('testAudit'));
    const pending = async (kind: string, count: number): Promise<number> => {
      await expect.poll(async () => (await audit()).requests.filter((item: any) => item.kind === kind).length).toBe(count);
      return (await audit()).requests.filter((item: any) => item.kind === kind)[count - 1].id;
    };
    const resolveReply = (id: number, kind: string, result: unknown) =>
      page.evaluate(({ id, kind, result }) => (window as any).ohmpath.request('testResolve', { id, kind, result }), { id, kind, result });
    const assembly = (label: string) => ({ physical_verification: 'pending', steps: [{ step_id: label, title: `${label} assembly step`, instruction: 'Inspect the stated nodes with power off.', component_ids: [], node_ids: [], requires_unpowered: true }] });
    const firmware = (label: string) => ({ firmware_revision: label, source: 'user_supplied_log', observations: [{ kind: 'note', summary: `${label} firmware observation`, line_numbers: [1] }], hypotheses: [] });
    const answer = (label: string) => ({ turn_id: label, status: 'completed', answer: { explanation: `${label} investigator answer`, circuit_revision: 'rev-b', evidence_ids: [], proposed_test_id: '' } });

    await expect(page.getByRole('heading', { name: 'Troubleshoot' })).toBeVisible();
    await page.getByRole('button', { name: 'Prepare assembly plan' }).click();
    const oldAssembly = await pending('assemblyPlan', 1);
    await page.getByLabel('PASTE LOG TEXT · MAX 20,000 CHARACTERS').fill('Replay build log line');
    await page.getByRole('button', { name: 'Analyze supplied log' }).click();
    const oldFirmware = await pending('firmwareAnalyze', 1);
    await page.getByRole('button', { name: 'Change circuit revision' }).click();
    await expect(page.getByLabel('Current context')).toContainText('rev-b / epoch-a');
    await page.getByRole('button', { name: 'Prepare assembly plan' }).click();
    const newAssembly = await pending('assemblyPlan', 2);
    await page.getByRole('button', { name: 'Analyze supplied log' }).click();
    const newFirmware = await pending('firmwareAnalyze', 2);
    await resolveReply(oldAssembly, 'assemblyPlan', assembly('Obsolete'));
    await resolveReply(oldFirmware, 'firmwareAnalyze', firmware('Obsolete'));
    await expect(page.getByText('Obsolete assembly step')).toHaveCount(0);
    await expect(page.getByText('Obsolete firmware observation')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Preparing guide…' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Reviewing text…' })).toBeDisabled();
    await resolveReply(newAssembly, 'assemblyPlan', assembly('Current'));
    await resolveReply(newFirmware, 'firmwareAnalyze', firmware('Current'));
    await expect(page.getByText('Current assembly step')).toBeVisible();
    await expect(page.getByText('Current firmware observation')).toBeVisible();
    await page.getByRole('button', { name: 'Analyze supplied log' }).click();
    const oldInputFirmware = await pending('firmwareAnalyze', 3);
    await page.getByLabel('PASTE LOG TEXT · MAX 20,000 CHARACTERS').fill('Changed replay log line');
    await page.getByLabel('BOARD (OPTIONAL)').fill('Replay MCU');
    await page.getByLabel('BAUD RATE').selectOption('57600');
    await expect(page.getByText('Current firmware observation')).toHaveCount(0);
    await page.getByRole('button', { name: 'Analyze supplied log' }).click();
    const newInputFirmware = await pending('firmwareAnalyze', 4);
    const newInputPayload = (await audit()).requests.find((item: any) => item.id === newInputFirmware).payload;
    expect(newInputPayload).toMatchObject({ log_text: 'Changed replay log line', board: 'Replay MCU', baud_rate: 57600 });
    await resolveReply(oldInputFirmware, 'firmwareAnalyze', firmware('Old inputs'));
    await expect(page.getByText('Old inputs firmware observation')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reviewing text…' })).toBeDisabled();
    await resolveReply(newInputFirmware, 'firmwareAnalyze', firmware('New inputs'));
    await expect(page.getByText('New inputs firmware observation')).toBeVisible();

    await page.getByLabel('YOUR QUESTION · MAX 4,000 CHARACTERS').fill('What changed?');
    await page.getByRole('button', { name: 'Start investigation' }).click();
    const firstStart = await pending('investigateStart', 1);
    await resolveReply(firstStart, 'investigateStart', { turn_id: 'turn-old-status', status: 'running' });
    const oldStatus = await pending('investigateStatus', 1);
    await page.getByRole('button', { name: 'Change context epoch' }).click();
    await expect(page.getByLabel('Current context')).toContainText('rev-b / epoch-b');
    await expect.poll(async () => (await audit()).cancels.some((item: any) => item.turn_id === 'turn-old-status')).toBe(true);
    await resolveReply(oldStatus, 'investigateStatus', answer('Obsolete'));
    await expect(page.getByText('Obsolete investigator answer')).toHaveCount(0);

    await page.getByLabel('YOUR QUESTION · MAX 4,000 CHARACTERS').fill('What is current?');
    await page.getByRole('button', { name: 'Start investigation' }).click();
    const freshStart = await pending('investigateStart', 2);
    await resolveReply(freshStart, 'investigateStart', { turn_id: 'turn-fresh', status: 'running' });
    const freshStatus = await pending('investigateStatus', 2);
    await resolveReply(freshStatus, 'investigateStatus', answer('Fresh'));
    await expect(page.getByText('Fresh investigator answer')).toBeVisible();

    await page.getByRole('button', { name: 'Change context epoch' }).click();
    await page.getByLabel('YOUR QUESTION · MAX 4,000 CHARACTERS').fill('Cancel before the turn ID');
    await page.getByRole('button', { name: 'Start investigation' }).click();
    const lateStart = await pending('investigateStart', 3);
    await page.getByRole('button', { name: 'Cancel turn' }).click();
    await expect(page.getByText('This turn was cancelled.')).toBeVisible();
    await resolveReply(lateStart, 'investigateStart', { turn_id: 'turn-late', status: 'running' });
    await expect.poll(async () => (await audit()).cancels.some((item: any) => item.turn_id === 'turn-late')).toBe(true);
    await expect(page.getByText('This turn was cancelled.')).toBeVisible();

    await page.getByRole('button', { name: 'Start investigation' }).click();
    const cancelStart = await pending('investigateStart', 4);
    await resolveReply(cancelStart, 'investigateStart', { turn_id: 'turn-cancel-await', status: 'running' });
    await pending('investigateStatus', 3);
    await page.evaluate(() => (window as any).ohmpath.request('testDelayNextCancel'));
    await page.getByRole('button', { name: 'Cancel turn' }).click();
    const oldCancel = await pending('investigateCancel', 1);
    await page.getByRole('button', { name: 'Start investigation' }).click();
    const newestStart = await pending('investigateStart', 5);
    await resolveReply(newestStart, 'investigateStart', { turn_id: 'turn-newest', status: 'running' });
    const newestStatus = await pending('investigateStatus', 4);
    await resolveReply(oldCancel, 'investigateCancel', { status: 'cancelled', turn_id: 'turn-cancel-await', message: 'Old cancellation returned.' });
    await expect(page.getByRole('button', { name: 'Cancel turn' })).toBeVisible();
    await resolveReply(newestStatus, 'investigateStatus', answer('Newest'));
    await expect(page.getByText('Newest investigator answer')).toBeVisible();

    await page.getByRole('button', { name: 'Start investigation' }).click();
    const unmountedStart = await pending('investigateStart', 6);
    await page.getByRole('button', { name: 'Leave troubleshooting' }).click();
    await expect(page.getByRole('heading', { name: 'Troubleshoot' })).toHaveCount(0);
    await resolveReply(unmountedStart, 'investigateStart', { turn_id: 'turn-after-leave', status: 'running' });
    await expect.poll(async () => (await audit()).cancels.some((item: any) => item.turn_id === 'turn-after-leave')).toBe(true);
    await page.getByRole('button', { name: 'Return to troubleshooting' }).click();
    await expect(page.getByText('Newest investigator answer')).toHaveCount(0);
    await expect(page.getByText('turn-after-leave')).toHaveCount(0);
    await page.getByLabel('YOUR QUESTION · MAX 4,000 CHARACTERS').fill('Old revision question');
    await page.getByRole('button', { name: 'Start investigation' }).click();
    const changedStart = await pending('investigateStart', 7);
    await page.getByRole('button', { name: 'Change circuit revision' }).click();
    await resolveReply(changedStart, 'investigateStart', { turn_id: 'turn-old-revision', status: 'running' });
    await expect.poll(async () => (await audit()).cancels.some((item: any) => item.turn_id === 'turn-old-revision')).toBe(true);
    await expect(page.getByText('turn-old-revision')).toHaveCount(0);
    expect((await audit()).unexpected).toEqual([]);
    await page.close();
    await expect.poll(() => desktop.exitCode, { timeout: 8000 }).toBe(0);
  } finally {
    if (desktop.exitCode === null) desktop.kill();
    if (browser) await browser.close().catch(() => undefined);
  }
});
