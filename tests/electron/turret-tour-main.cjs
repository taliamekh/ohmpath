// Real renderer and preload; no service, model or hardware is started.
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const Module = require('node:module');
const fixturePath = resolve(__dirname, 'photo-help-replay-main.cjs');
let source = readFileSync(fixturePath, 'utf8');
const marker = 'function handle(action, payload = {}) {';
if (source.split(marker).length !== 2) throw new Error('Review changed replay fixture');
source = source.replace(marker, String.raw`
const motionAudit=[];
const motion={connected:false,armed:false,moving:false,driving:false,holding:false,commissioning:false,
  camera_ready:false,camera_focus_success:true,phase:'idle',orientation:90,message:'Simulated controller',
  commanded_us:null,at_limit:{},drive_session:'simulated',aim_reference:null,component_map:null,tour:null,framing:null,guidance:null,
  profile:{yaw:{min:1380,max:2055,home:1500},pitch:{min:1500,max:2492,home:2004}}};
const tourImage=nativeImage.createFromBuffer(fixturePng(false)).resize({width:720,height:1280}).toJPEG(90).toString('base64');
let frameSequence=0;
let guidanceSerial=0;
let laserSpot=null;
let laserSpotMessage='No clear red spot is visible in this image.';
function componentMap(roi={x:.2,y:.2,width:.6,height:.6},approved=false) {
  return {map_id:'11111111-1111-4111-8111-111111111111',phase:approved?'ready':'review',approved,roi,
    message:approved?'Components located for the current guidance.':'Review the numbered component markers.',components:[
      {id:'resistor',label:'Resistor R1',number:1,point:{x:.4,y:.4}},
      {id:'capacitor',label:'Capacitor C1',number:2,point:{x:.6,y:.6}}]};
}
function handle(action,payload={}) {
  if(action==='testMotionAudit') return motionAudit;
  if(action==='testMotionSetLaserSpot'){
    laserSpot=payload.spot;
    laserSpotMessage=payload.message||'No clear red spot is visible in this image.';
    return {ok:true};
  }
  if(action==='motionFrame') return {frame:motion.connected?{jpeg_base64:tourImage,sequence:++frameSequence,
    generation:'simulated-camera',width:720,height:1280,target:null,laser_spot:laserSpot,laser_spot_message:laserSpotMessage}:null};
  if(action.startsWith('motion')) {
    motionAudit.push({action,...payload});
    if(action==='motionConnect'){motion.connected=true;motion.camera_ready=true;}
    if(action==='motionPrepareFraming') motion.framing={framing_id:'22222222-2222-4222-8222-222222222222',state:'ready',
      bounds:payload.roi,centre:{x:.5,y:.5},geometry_current:true,fits_with_margin:true,source_touched_edge:false,message:'Circuit area marked.'};
    if(action==='motionReposition') {motion.phase='repositioning';motion.commissioning=false;motion.framing.state='running';motion.framing.message='Centring the marked circuit area…';}
    if(action==='motionIdentifyComponents') motion.component_map=componentMap(motion.framing.bounds);
    if(action==='motionApproveComponents'){motion.component_map.approved=true;motion.component_map.phase='ready';}
    if(action==='motionSpotReference') motion.aim_reference={x:.5,y:.62,distance_mm:null};
    if(action==='motionArm'){
      if('laser_disconnected' in payload)throw new Error('Unexpected laser-disconnected gate payload');
      motion.armed=true;motion.holding=true;motion.commissioning=payload.commissioning;motion.commanded_us={yaw:1500,pitch:2004};
    }
    if(action==='motionTour'){motion.commissioning=false;motion.phase='tour';motion.tour={state:'running',index:1,total:2,label:'Resistor R1',visited:[]};}
    if(action==='motionGuide'){
      const serial=++guidanceSerial;
      motion.armed=true;motion.holding=true;motion.commissioning=false;motion.phase='guiding';
      motion.commanded_us={yaw:1500,pitch:2004};motion.component_map=null;motion.tour=null;motion.framing=null;
      motion.drive_session='simulated-guide-'+serial;
      motion.guidance={state:'running',stage:'Finding circuit',message:'Finding the visible circuit.',question:payload.question,visited:[],index:0,total:0};
      motionAudit.push({action:'simulatedGuideStage',stage:'finding'});
      const stage=(delay,name,change)=>setTimeout(()=>{
        if(serial!==guidanceSerial||motion.guidance?.state!=='running')return;
        motionAudit.push({action:'simulatedGuideStage',stage:name});change();
      },delay);
      stage(500,'centring',()=>Object.assign(motion.guidance,{stage:'Centring circuit',message:'Moving the circuit into view.'}));
      stage(1000,'investigating',()=>Object.assign(motion.guidance,{stage:'Investigating',message:'Checking the circuit image and your question.'}));
      stage(1500,'pointing-first',()=>{
        motion.component_map=componentMap(undefined,true);motion.aim_reference={x:.5,y:.62,distance_mm:null};
        Object.assign(motion.guidance,{stage:'Pointing',message:'Check the resistor connection.',index:1,total:2});
      });
      stage(1900,'pointing-second',()=>Object.assign(motion.guidance,{stage:'Pointing',message:'Measure at the capacitor next.',index:2,visited:['resistor']}));
      stage(2400,'completed',()=>{
        motion.phase='idle';Object.assign(motion.guidance,{state:'completed',message:'Two areas are ready for your checks.',visited:['resistor','capacitor'],
          answer:{explanation:'The resistor connection may be open. Confirm it with a measurement.',
            next_steps:['Check the resistor lead placement.','Measure the capacitor voltage.'],limitations:['The image alone cannot confirm electrical continuity.']}});
      });
    }
    if(action==='motionPointComponent'){
      if(payload.map_id!==motion.component_map?.map_id||!motion.component_map.components.some(item=>item.id===payload.component_id))throw new Error('Unknown component');
      motion.message='Pointing to '+payload.component_id;
    }
    if(['motionStop','motionRelease','motionDisconnect'].includes(action)){
      motion.phase='idle';if(motion.tour)motion.tour.state='stopped';
      guidanceSerial++;if(motion.guidance?.state==='running')Object.assign(motion.guidance,{state:'stopped',message:'Automatic guidance stopped.',reason:'Stopped by the user.'});
      if(motion.framing?.state==='running'){motion.framing.state='stopped';motion.framing.message='Camera repositioning stopped.';}
      if(action!=='motionStop'){motion.armed=false;motion.holding=false;}
      if(action==='motionDisconnect'){motion.connected=false;motion.camera_ready=false;}
    }
    if(action==='motionClearComponents'){motion.component_map=null;motion.tour=null;motion.framing=null;}
    return {...motion};
  }
`);
const replay=new Module(fixturePath,module);
replay.filename=fixturePath;replay.paths=Module._nodeModulePaths(__dirname);
replay._compile(source,fixturePath);
