import {test, expect, chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';

test('integrated pointer starts released and leaving it releases motors without dropping Pi camera', async () => {
  test.setTimeout(50000);
  const dataDir=await mkdtemp(resolve(tmpdir(),'ohmpath-pointer-gates-'));
  const child=spawn(createRequire(resolve('package.json'))('electron'),[
    resolve('tests/electron/turret-tour-main.cjs'),'--remote-debugging-port=0',
    '--disable-background-timer-throttling','--disable-renderer-backgrounding',
  ],{env:{...process.env,OHMPATH_REPLAY_DATA_DIR:dataDir},windowsHide:true});
  let browser: import('@playwright/test').Browser|undefined;
  try {
    const endpoint=await new Promise<string>((accept,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Offline pointer replay did not open')),15000);
      child.stderr.on('data',chunk=>{
        const match=chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if(match){clearTimeout(timer);accept(match[1]);}
      });
      child.once('error',reject);
    });
    browser=await chromium.connectOverCDP(endpoint);
    const context=browser.contexts()[0],page=context.pages()[0]||await context.waitForEvent('page');
    page.setDefaultTimeout(7000);
    await page.getByRole('button',{name:'Turret control',exact:false}).click();
    await expect(page.getByRole('heading',{name:'Point to the current check'})).toBeVisible();
    await expect(page.getByText('Saved demo points',{exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Open LED walkthrough'})).toHaveCount(0);
    const initialStatus=await page.evaluate(()=>(window as any).ohmpath.request('motionStatus'));
    expect(initialStatus.armed).toBe(false);
    await page.getByRole('button',{name:'Photo help',exact:false}).first().click();
    await page.getByRole('button',{name:'Add a photo or diagram',exact:false}).click();
    await page.getByLabel('What would you like help with?').fill('Locate the next safe check.');
    await page.getByRole('button',{name:'Ask about these images',exact:false}).click();
    await page.getByRole('button',{name:'Show this test location with the pointer'}).click();
    await expect(page.getByRole('heading',{name:'Point to the current check'})).toBeVisible();
    await expect(page.getByText('MOTORS RELEASED',{exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Enable movement',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'Connect Pi',exact:true}).click();
    await expect(page.getByRole('img',{name:'Live Raspberry Pi turret camera'})).toBeVisible();
    await expect(page.getByRole('button',{name:'Enable movement',exact:true})).toBeEnabled();
    await page.getByRole('button',{name:'Back to diagnosis'}).click();
    const status=await page.evaluate(()=>(window as any).ohmpath.request('motionStatus'));
    expect(status.connected).toBe(true);
    expect(status.armed).toBe(false);
    expect(status.laser_enabled ?? false).toBe(false);
    await expect(page.locator('.photo-help-explanation')).toBeVisible();
  } finally {
    if(child.exitCode===null)child.kill();
    if(browser)await Promise.race([browser.close().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,1500))]);
  }
});
