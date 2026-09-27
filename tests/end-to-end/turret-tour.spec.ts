import {test, expect, chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';

test('automatic guidance, component review, offset reference, sequential tour and stop through the real renderer', async () => {
  test.setTimeout(90000);
  const dataDir=await mkdtemp(resolve(tmpdir(),'ohmpath-turret-tour-'));
  const child=spawn(createRequire(resolve('package.json'))('electron'),[resolve('tests/electron/turret-tour-main.cjs'),
    '--remote-debugging-port=0','--disable-background-timer-throttling','--disable-renderer-backgrounding'],
    {env:{...process.env,OHMPATH_REPLAY_DATA_DIR:dataDir},windowsHide:true});
  let browser;
  try {
    const endpoint=await new Promise<string>((accept,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Replay did not start')),15000);
      child.stderr.on('data',chunk=>{const match=chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if(match){clearTimeout(timer);accept(match[1]);}});child.once('error',reject);
    });
    browser=await chromium.connectOverCDP(endpoint);
    const context=browser.contexts()[0],page=context.pages()[0]||await context.waitForEvent('page');
    page.setDefaultTimeout(6000);
    await page.evaluate(()=>{document.hasFocus=()=>true;});
    await page.getByTitle('Turret',{exact:true}).click();
    await page.getByRole('button',{name:'Connect Pi',exact:true}).click();
    const auditRequests=()=>page.evaluate(()=>(window as any).ohmpath.request('testMotionAudit'));
    await expect(page.getByLabel('Laser power is disconnected.')).toHaveCount(0);
    expect((await auditRequests()).filter((item:any)=>['motionArm','motionGuide','motionTour'].includes(item.action))).toHaveLength(0);
    const guide=page.getByRole('button',{name:'Find circuit and guide me',exact:true});
    await expect(guide).toBeEnabled();
    await expect(page.getByLabel('What should I investigate?')).toHaveValue('Find the likely problem and point to the areas I should check or measure next.');
    const camera=page.getByRole('img',{name:'Live Raspberry Pi turret camera'});
    await expect(camera).toBeVisible();
    const laserMarker=page.getByLabel('Laser spot',{exact:true});
    await expect(laserMarker).toHaveCount(0);
    await expect(page.locator('.turret-crosshair,.turret-aim-mark')).toHaveCount(0);
    await expect(page.getByLabel('Laser marker status')).toContainText('No clear red spot');
    await page.getByRole('button',{name:'Disconnect',exact:true}).click();
    await page.getByRole('button',{name:'Connect Pi',exact:true}).click();
    await expect(camera).toBeVisible();
    await expect(laserMarker).toHaveCount(0);
    await expect(page.locator('.turret-crosshair,.turret-aim-mark')).toHaveCount(0);
    const showSpot=()=>page.evaluate(()=>(window as any).ohmpath.request('testMotionSetLaserSpot',
      {spot:{x:.63,y:.61,source:'red_spot_candidate',physically_verified:false}}));
    await showSpot();
    await expect(laserMarker).toBeVisible();
    expect(await laserMarker.evaluate(element=>(element as HTMLElement).style.left)).toBe('63%');
    expect(await laserMarker.evaluate(element=>(element as HTMLElement).style.top)).toBe('61%');
    await expect(page.getByRole('button',{name:'Tour all components',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'Mark circuit area',exact:true}).click();
    await camera.scrollIntoViewIfNeeded();
    const box=(await camera.boundingBox())!;
    await page.mouse.move(box.x+.2*box.width,box.y+.2*box.height);await page.mouse.down();
    await page.mouse.move(box.x+.8*box.width,box.y+.8*box.height,{steps:5});await page.mouse.up();
    await expect(page.getByText('Circuit area marked.',{exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Centre circuit in view',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'Enable movement',exact:true}).click();
    await page.getByRole('button',{name:'Centre circuit in view',exact:true}).click();
    await expect(page.getByText('Centring the marked circuit area…',{exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Centre circuit in view',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'Stop movement',exact:true}).click();
    await expect(page.getByText('Camera repositioning stopped.',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Release motors · Esc',exact:true}).click();
    await page.getByRole('button',{name:'Identify components',exact:true}).click();
    await expect(page.locator('.turret-component-marker')).toHaveCount(2);
    await page.getByRole('button',{name:'Accept component map',exact:true}).click();
    await expect(page.getByLabel('Selected circuit area')).toHaveCount(0);
    await page.getByRole('button',{name:'Use visible red spot',exact:true}).click();
    expect(await laserMarker.evaluate(element=>(element as HTMLElement).style.top)).toBe('61%');
    const saved=await page.evaluate(()=>(window as any).ohmpath.request('motionStatus'));
    expect(saved.aim_reference).toEqual({x:.5,y:.62,distance_mm:null});
    await page.evaluate(()=>(window as any).ohmpath.request('testMotionSetLaserSpot',
      {spot:null,message:'Several red spots are visible; choose the laser spot.'}));
    await expect(laserMarker).toHaveCount(0);
    await expect(page.locator('.turret-crosshair,.turret-aim-mark')).toHaveCount(0);
    await expect(page.getByLabel('Laser marker status')).toContainText('Several red spots');
    await expect(page.getByLabel('Laser marker status')).toContainText('Click laser spot');
    await showSpot();
    await expect(laserMarker).toBeVisible();
    expect(await laserMarker.evaluate(element=>(element as HTMLElement).style.top)).toBe('61%');
    await page.getByRole('button',{name:'Enable movement',exact:true}).click();
    await page.getByRole('button',{name:'Tour all components',exact:true}).click();
    await expect(page.getByText('1/2 · Resistor R1 · running',{exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Tour all components',exact:true})).toBeDisabled();
    const audit=await page.evaluate(()=>(window as any).ohmpath.request('testMotionAudit'));
    const prepared=audit.find((item:any)=>item.action==='motionPrepareFraming');
    expect(prepared.roi.x).toBeCloseTo(.2,2);expect(prepared.roi.width).toBeCloseTo(.6,2);
    expect(prepared.generation).toBe('simulated-camera');
    const identify=audit.find((item:any)=>item.action==='motionIdentifyComponents');
    expect(identify.framing_id).toBe('22222222-2222-4222-8222-222222222222');
    expect(identify.roi).toBeUndefined();expect(identify.sequence).toBeUndefined();
    expect(audit.filter((item:any)=>item.action==='motionTour')).toHaveLength(1);
    expect(audit.filter((item:any)=>item.action==='motionPrepareFraming')).toHaveLength(1);
    expect(audit.filter((item:any)=>item.action==='motionReposition')).toHaveLength(1);
    expect(audit.filter((item:any)=>item.action==='motionArm')).toEqual([
      {action:'motionArm',clear:true,commissioning:true},{action:'motionArm',clear:true,commissioning:true}]);
    await page.getByRole('button',{name:'Stop movement',exact:true}).click();
    await expect(page.getByText('1/2 · Resistor R1 · stopped',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Clear component map',exact:true}).click();
    await expect(page.locator('.turret-component-marker')).toHaveCount(0);
    await page.getByRole('button',{name:'Release motors · Esc',exact:true}).click();
    await expect(page.getByText('MOTORS RELEASED',{exact:true})).toBeVisible();
    // No marked region, arm click or laser-off checkbox is needed for explicit guide start.
    await expect(guide).toBeEnabled();
    await page.getByLabel('What should I investigate?').fill('Why does the LED stay dark? Point to the next measurement areas.');
    await guide.click();
    await expect(guide).toBeDisabled();
    await expect(page.getByLabel('Circuit guidance result')).toContainText('Finding the visible circuit.');
    const releasesBefore=(await auditRequests()).filter((item:any)=>item.action==='motionRelease').length;
    const presenceBefore=(await auditRequests()).filter((item:any)=>item.action==='motionKeepalive').length;
    await page.evaluate(()=>{document.hasFocus=()=>false;window.dispatchEvent(new Event('blur'));});
    await expect.poll(async()=>(await auditRequests()).filter((item:any)=>item.action==='motionKeepalive').length).toBeGreaterThan(presenceBefore);
    await expect(page.getByText('Guidance complete',{exact:true})).toBeVisible();
    expect((await auditRequests()).filter((item:any)=>item.action==='motionRelease')).toHaveLength(releasesBefore);
    await page.evaluate(()=>{document.hasFocus=()=>true;});
    await expect(page.getByLabel('Circuit guidance result')).toContainText('2/2 areas');
    await expect(page.getByLabel('Circuit guidance result')).toContainText('The resistor connection may be open. Confirm it with a measurement.');
    await expect(page.getByLabel('Circuit guidance result')).toContainText('Measure the capacitor voltage.');
    await expect(page.getByLabel('Circuit guidance result')).toContainText('The image alone cannot confirm electrical continuity.');
    await expect(page.locator('.turret-component-marker')).toHaveCount(2);
    await page.getByRole('button',{name:'Point to Capacitor C1',exact:true}).click();
    const guidedAudit=await auditRequests();
    expect(guidedAudit.filter((item:any)=>item.action==='motionGuide')).toEqual([
      {action:'motionGuide',question:'Why does the LED stay dark? Point to the next measurement areas.'}]);
    expect(guidedAudit.filter((item:any)=>item.action==='simulatedGuideStage').map((item:any)=>item.stage))
      .toEqual(['finding','centring','investigating','pointing-first','pointing-second','completed']);
    expect(guidedAudit.filter((item:any)=>item.action==='motionPointComponent')).toEqual([
      {action:'motionPointComponent',map_id:'11111111-1111-4111-8111-111111111111',component_id:'capacitor'}]);
    await guide.click();
    await expect(guide).toBeDisabled();
    await page.getByRole('button',{name:'Stop movement',exact:true}).click();
    await expect(page.getByText('Guidance stopped',{exact:true})).toBeVisible();
    await expect(page.getByLabel('Circuit guidance result')).toContainText('Stopped by the user.');
    await page.waitForTimeout(2600);
    await expect(page.getByText('Guidance complete',{exact:true})).toHaveCount(0);
  } finally {
    if(child.exitCode===null)child.kill();
    if(browser)await Promise.race([browser.close().catch(()=>{}),new Promise(r=>setTimeout(r,1500))]);
  }
});
