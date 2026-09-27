import {test, expect, chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';

test('photo diagnosis opens a pointer for its active test without another diagnosis', async () => {
  test.setTimeout(60000);
  const dataDir=await mkdtemp(resolve(tmpdir(),'ohmpath-pointer-handoff-'));
  const desktop=spawn(createRequire(resolve('package.json'))('electron'),[
    resolve('tests/electron/turret-tour-main.cjs'),'--remote-debugging-port=0',
    '--disable-background-timer-throttling','--disable-renderer-backgrounding',
  ],{env:{...process.env,OHMPATH_REPLAY_DATA_DIR:dataDir},windowsHide:true});
  let browser: import('@playwright/test').Browser|undefined;
  try {
    const endpoint=await new Promise<string>((accept,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Offline pointer replay did not open')),15000);
      desktop.stderr.on('data',chunk=>{
        const match=chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if(match){clearTimeout(timer);accept(match[1]);}
      });
      desktop.once('error',error=>{clearTimeout(timer);reject(error);});
      desktop.once('exit',code=>{clearTimeout(timer);reject(new Error(`Offline pointer replay exited early (${code})`));});
    });
    browser=await chromium.connectOverCDP(endpoint,{timeout:12000});
    const context=browser.contexts()[0],page=context.pages()[0]||await context.waitForEvent('page');
    page.setDefaultTimeout(8000);
    const motionAudit=()=>page.evaluate(()=>(window as any).ohmpath.request('testMotionAudit'));
    const photoAudit=()=>page.evaluate(()=>(window as any).ohmpath.request('testAudit'));

    await expect(page.getByRole('navigation',{name:'Workspace'}).getByRole('button',{name:'Turret'})).toHaveCount(0);
    await page.getByRole('button',{name:'Photo help',exact:false}).first().click();
    await page.getByRole('button',{name:'Add a photo or diagram',exact:false}).click();
    const question='Why is this LED dark, and which connection should I measure first?';
    await page.getByLabel('What would you like help with?').fill(question);
    await page.getByRole('button',{name:'Ask about these images',exact:false}).click();
    await expect(page.locator('.photo-help-explanation')).toHaveText(`Replay explanation for ${question}`);
    await expect(page.getByRole('button',{name:'Show this test location with the pointer'})).toBeVisible();
    expect((await photoAudit()).asks).toHaveLength(1);
    await page.getByRole('button',{name:'Show this test location with the pointer'}).click();
    await expect(page.getByRole('dialog',{name:'Pointer for current check'})).toBeVisible();
    await expect(page.getByRole('heading',{name:'Point to the current check'})).toBeVisible();
    await expect(page.locator('.turret-heading')).toContainText('Inspect the marked area.');
    await expect(page.getByRole('button',{name:'Find circuit and guide me'})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Tour all components'})).toHaveCount(0);
    expect((await motionAudit()).filter((item:any)=>['motionGuide','motionTour','motionArm','motionPointComponent'].includes(item.action))).toEqual([]);
    expect((await photoAudit()).asks).toHaveLength(1);
    expect((await photoAudit()).modelCalls).toBe(0);

    await page.getByRole('button',{name:'Back to diagnosis'}).click();
    await expect(page.locator('.photo-help-explanation')).toHaveText(`Replay explanation for ${question}`);
    await expect(page.getByLabel('What happened when you ran this test?')).toBeVisible();
    expect((await motionAudit()).some((item:any)=>item.action==='motionRelease')).toBe(true);
  } finally {
    if(desktop.exitCode===null)desktop.kill();
    if(browser)await Promise.race([browser.close().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,1500))]);
  }
});
