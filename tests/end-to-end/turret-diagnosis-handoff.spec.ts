import {test, expect, chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';

test('completed photo diagnosis becomes a turret draft without starting movement', async () => {
  test.setTimeout(60000);
  const dataDir=await mkdtemp(resolve(tmpdir(),'ohmpath-turret-handoff-'));
  const desktop=spawn(createRequire(resolve('package.json'))('electron'),[
    resolve('tests/electron/turret-tour-main.cjs'),'--remote-debugging-port=0',
    '--disable-background-timer-throttling','--disable-renderer-backgrounding',
  ],{env:{...process.env,OHMPATH_REPLAY_DATA_DIR:dataDir},windowsHide:true});
  let browser: import('@playwright/test').Browser|undefined;
  try {
    const endpoint=await new Promise<string>((accept,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Offline turret handoff replay did not open')),15000);
      desktop.stderr.on('data',chunk=>{
        const match=chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if(match){clearTimeout(timer);accept(match[1]);}
      });
      desktop.once('error',error=>{clearTimeout(timer);reject(error);});
      desktop.once('exit',code=>{clearTimeout(timer);reject(new Error(`Offline handoff exited early (${code})`));});
    });
    browser=await chromium.connectOverCDP(endpoint,{timeout:12000});
    const context=browser.contexts()[0],page=context.pages()[0]||await context.waitForEvent('page');
    page.setDefaultTimeout(8000);
    // Only the hardware-free replay treats this hidden test window as focused.
    await page.evaluate(()=>{document.hasFocus=()=>true;});
    const motionAudit=()=>page.evaluate(()=>(window as any).ohmpath.request('testMotionAudit'));
    const photoAudit=()=>page.evaluate(()=>(window as any).ohmpath.request('testAudit'));
    const movementActions=['motionGuide','motionArm','motionJog','motionDrive','motionTour','motionPointComponent','motionReposition'];

    await page.getByRole('button',{name:'Photo help',exact:false}).first().click();
    await expect(page.getByRole('button',{name:'Show these checks with the turret →',exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:'Add a photo or diagram',exact:false}).click();
    const question='Why is this LED dark, and which connection should I measure first?';
    await page.getByLabel('What would you like help with?').fill(question);
    await page.getByRole('button',{name:'Ask about these images',exact:false}).click();
    await expect(page.locator('.photo-help-explanation')).toHaveText(`Replay explanation for ${question}`);
    await page.getByRole('button',{name:'Show these checks with the turret →',exact:true}).click();

    const draft=page.getByLabel('What should I investigate?');
    await expect(draft).toBeVisible();
    await expect(draft).toHaveValue(new RegExp(`Original question: Why is this LED dark`));
    const received=await draft.inputValue();
    expect(received).toContain('CURRENT Pi camera view');
    expect(received).toContain(`Original question: ${question}`);
    expect(received).toContain(`Earlier visual explanation: Replay explanation for ${question}`);
    expect(received).toContain('Suggested checks: Inspect the marked area.');
    expect(received).toContain('Uncertainty: This answer is an offline test fixture.');
    expect(received).not.toContain('10000000-0000-4000-8000-000000000001');
    expect((await motionAudit()).filter((item:any)=>movementActions.includes(item.action))).toEqual([]);

    const guide=page.getByRole('button',{name:'Find circuit and guide me',exact:true});
    await expect(guide).toBeDisabled();
    await page.getByRole('button',{name:'Connect Pi',exact:true}).click();
    await expect(page.getByRole('img',{name:'Live Raspberry Pi turret camera'})).toBeVisible();
    await expect(guide).toBeEnabled();
    await expect(page.getByText('MOTORS RELEASED',{exact:true})).toBeVisible();
    expect((await motionAudit()).filter((item:any)=>movementActions.includes(item.action))).toEqual([]);

    const edited=received+'\nStart with the supply connection.';
    await draft.fill(edited);
    await page.waitForTimeout(500); // Allow the parent consumption callback and status polling to rerender.
    await expect(draft).toHaveValue(edited);
    expect((await motionAudit()).filter((item:any)=>movementActions.includes(item.action))).toEqual([]);
    await guide.click();
    await expect(guide).toBeDisabled();
    const started=await motionAudit();
    expect(started.filter((item:any)=>item.action==='motionGuide')).toEqual([{action:'motionGuide',question:edited}]);
    expect(started.filter((item:any)=>item.action==='motionArm')).toEqual([]);
    expect((await photoAudit()).asks).toHaveLength(1);
    expect((await photoAudit()).modelCalls).toBe(0);
    await page.getByRole('button',{name:'Stop movement',exact:true}).click();
    expect((await motionAudit()).some((item:any)=>item.action==='motionStop')).toBe(true);
  } finally {
    if(desktop.exitCode===null)desktop.kill();
    if(browser)await Promise.race([browser.close().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,1500))]);
  }
});
