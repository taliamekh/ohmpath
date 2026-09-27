import {test, expect, chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';

test('simulated keyboard lock holds arrows continuously and releases on keyup, Escape and blur', async () => {
  test.setTimeout(45000);
  const dataDir = await mkdtemp(resolve(tmpdir(), 'ohmpath-turret-keys-'));
  const child = spawn(createRequire(resolve('package.json'))('electron'), [resolve('tests/electron/turret-keyboard-main.cjs'),
    '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], {
      env: {...process.env, OHMPATH_REPLAY_DATA_DIR: dataDir}, windowsHide: true});
  let browser;
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Replay did not start')), 15000);
      child.stderr.on('data', chunk => { const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) {clearTimeout(timer); accept(match[1]);} });
      child.once('error', reject);
    });
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0], page = context.pages()[0] || await context.waitForEvent('page');
    page.setDefaultTimeout(6000);
    // Only this offline, hardware-free fixture treats the hidden page as focused.
    await page.evaluate(() => {document.hasFocus = () => true;});
    await page.getByRole('button',{name:'Photo help',exact:false}).first().click();
    await page.getByRole('button',{name:'Add a photo or diagram',exact:false}).click();
    await page.getByLabel('What would you like help with?').fill('Point to the current check.');
    await page.getByRole('button',{name:'Ask about these images',exact:false}).click();
    await page.getByRole('button',{name:'Show this test location with the pointer'}).click();
    await page.getByRole('button', {name:'Connect Pi',exact:true}).click();
    await expect(page.getByLabel('Laser power is disconnected.')).toHaveCount(0);
    await page.getByRole('button', {name:'Enable movement',exact:true}).click();
    await expect(page.getByText('MANUAL · travel limits off', {exact:true})).toBeVisible();
    await page.getByRole('button', {name:'Pan →',exact:true}).click();
    const audit = () => page.evaluate(() => (window as any).ohmpath.request('testMotionAudit'));
    expect((await audit()).find((v:any) => v.action === 'motionArm')).toEqual({action:'motionArm',clear:true,commissioning:true});
    expect((await audit()).find((v:any) => v.action === 'motionJog').fine).toBe(false);
    // Ordinary arrows work without a hidden toggle or entering the locked view.
    await expect(page.getByLabel('Use arrow keys', {exact:true})).toBeChecked();
    await expect(page.getByRole('button', {name:'Pan →',exact:true})).toBeEnabled();
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await page.keyboard.down('ArrowDown');
    await expect.poll(async () => (await audit()).filter((v:any) => v.action === 'motionDrive' && v.pitch === -1).length).toBeGreaterThan(1).catch(async error => {
      console.log('Keyboard failure state', JSON.stringify(await page.evaluate(async () => ({active: document.activeElement?.outerHTML,
        status: await (window as any).ohmpath.request('motionStatus'), audit: (await (window as any).ohmpath.request('testMotionAudit')).slice(-15)}))));
      throw error;
    });
    await page.keyboard.up('ArrowDown');
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    await page.getByRole('button', {name:'Use saved limits',exact:true}).click();
    await page.getByRole('button', {name:'Full manual range',exact:true}).click();
    await expect(page.getByText('MANUAL · travel limits off', {exact:true})).toBeVisible();
    await expect(page.getByLabel('Live servo commands')).toContainText('Pan 1500 µs');
    await expect(page.getByLabel('Live servo commands')).toBeInViewport();
    await page.getByRole('button', {name:'Lock camera view',exact:true}).click();
    await expect(page.locator('.turret-page')).toHaveClass(/keyboard-locked/);
    await expect(page.getByRole('button', {name:'Stop movement',exact:true})).toBeInViewport();
    await page.keyboard.down('ArrowRight');
    await expect.poll(async () => (await audit()).filter((v:any) => v.action === 'motionDrive' && v.yaw === 1).length).toBeGreaterThan(2);
    await page.keyboard.down('ArrowUp');
    await expect.poll(async () => (await audit()).filter((v:any) => v.action === 'motionDrive').at(-1)?.pitch).toBe(1);
    await page.keyboard.up('ArrowRight'); await page.keyboard.up('ArrowUp');
    await expect.poll(async () => (await audit()).filter((v:any) => v.action === 'motionDrive').at(-1)).toMatchObject({yaw:0,pitch:0});
    await page.keyboard.press('Escape');
    await expect(page.locator('.turret-page')).not.toHaveClass(/keyboard-locked/);
    await expect(page.getByText('MOTORS RELEASED', {exact:true})).toBeVisible();
    await page.getByRole('button', {name:'Enable movement',exact:true}).click();
    await page.getByRole('button', {name:'Lock camera view',exact:true}).click();
    await page.keyboard.down('ArrowLeft');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.keyboard.up('ArrowLeft');
    await expect(page.getByText('MOTORS RELEASED', {exact:true})).toBeVisible();
    await expect(page.locator('.turret-page')).not.toHaveClass(/keyboard-locked/);
  } finally {
    if (child.exitCode === null) child.kill();
    if (browser) await Promise.race([browser.close().catch(() => {}), new Promise(r => setTimeout(r, 1500))]);
  }
});
