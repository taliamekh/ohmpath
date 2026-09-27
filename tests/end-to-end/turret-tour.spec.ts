import {test, expect, chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';

test('current test can point to one reviewed component without running turret diagnosis', async () => {
  test.setTimeout(70000);
  const dataDir=await mkdtemp(resolve(tmpdir(),'ohmpath-pointer-map-'));
  const child=spawn(createRequire(resolve('package.json'))('electron'),[
    resolve('tests/electron/turret-tour-main.cjs'),'--remote-debugging-port=0',
    '--disable-background-timer-throttling','--disable-renderer-backgrounding',
  ],{env:{...process.env,OHMPATH_REPLAY_DATA_DIR:dataDir},windowsHide:true});
  let browser: import('@playwright/test').Browser|undefined;
  try {
    const endpoint=await new Promise<string>((accept,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Offline pointer map replay did not open')),15000);
      child.stderr.on('data',chunk=>{
        const match=chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if(match){clearTimeout(timer);accept(match[1]);}
      });
      child.once('error',reject);
    });
    browser=await chromium.connectOverCDP(endpoint);
    const context=browser.contexts()[0],page=context.pages()[0]||await context.waitForEvent('page');
    page.setDefaultTimeout(7000);
    await page.evaluate(()=>{document.hasFocus=()=>true;});
    const audit=()=>page.evaluate(()=>(window as any).ohmpath.request('testMotionAudit'));

    await page.getByRole('button',{name:'Photo help',exact:false}).first().click();
    await page.getByRole('button',{name:'Add a photo or diagram',exact:false}).click();
    await page.getByLabel('What would you like help with?').fill('Which component should I test?');
    await page.getByRole('button',{name:'Ask about these images',exact:false}).click();
    await page.getByRole('button',{name:'Show this test location with the pointer'}).click();
    await page.getByRole('button',{name:'Connect Pi',exact:true}).click();
    const camera=page.getByRole('img',{name:'Live Raspberry Pi turret camera'});
    await expect(camera).toBeVisible();
    const marker=page.getByLabel('Detected beam candidate',{exact:true});
    await expect(marker).toHaveCount(0);
    await page.evaluate(()=>(window as any).ohmpath.request('testMotionSetLaserSpot',
      {spot:{x:.63,y:.61,source:'red_spot_candidate',physically_verified:false}}));
    await expect(marker).toBeVisible();
    await expect(marker).toHaveText('');
    expect(await marker.evaluate(element=>(element as HTMLElement).style.left)).toBe('63%');
    await page.getByRole('button',{name:'Mark circuit area',exact:true}).click();
    const box=(await camera.boundingBox())!;
    await page.mouse.move(box.x+.2*box.width,box.y+.2*box.height);
    await page.mouse.down();
    await page.mouse.move(box.x+.8*box.width,box.y+.8*box.height,{steps:5});
    await page.mouse.up();
    await expect(page.getByText('Circuit area marked.',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Identify components',exact:true}).click();
    await expect(page.locator('.turret-component-marker')).toHaveCount(2);
    await page.getByRole('button',{name:'Accept component map',exact:true}).click();
    await expect(page.getByRole('button',{name:'Point to Resistor R1'})).toBeDisabled();
    await page.getByRole('button',{name:'Use visible red spot',exact:true}).click();
    await page.getByRole('button',{name:'Enable movement',exact:true}).click();
    await page.getByRole('button',{name:'Point to Resistor R1'}).click();
    const actions=await audit();
    expect(actions.filter((item:any)=>item.action==='motionPointComponent')).toEqual([
      {action:'motionPointComponent',map_id:'11111111-1111-4111-8111-111111111111',component_id:'resistor'},
    ]);
    expect(actions.filter((item:any)=>['motionGuide','motionTour'].includes(item.action))).toEqual([]);
    await page.getByRole('button',{name:'Stop movement',exact:true}).click();
    await expect(page.getByText('MOTORS RELEASED',{exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:'Back to diagnosis'}).click();
    await expect(page.locator('.photo-help-explanation')).toBeVisible();
  } finally {
    if(child.exitCode===null)child.kill();
    if(browser)await Promise.race([browser.close().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,1500))]);
  }
});
