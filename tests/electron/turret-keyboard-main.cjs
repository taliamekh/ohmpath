// Real renderer/preload, simulated motion only. The shared offline fixture starts no services/devices.
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const Module = require('node:module');
const fixturePath = resolve(__dirname, 'photo-help-replay-main.cjs');
let source = readFileSync(fixturePath, 'utf8');
const marker = 'function handle(action, payload = {}) {';
if (source.split(marker).length !== 2) throw new Error('Review changed offline replay fixture');
source = source.replace(marker, String.raw`
const motionAudit = [];
const motion = {connected: false, connecting: false, armed: false, moving: false, driving: false,
  holding: false, commissioning: false, camera_ready: false, calibrated: false, target_selected: false,
  phase: 'idle', message: 'Simulated controller', orientation: 0, aim_reference: null, guidance: null,
  manual_bounds_us: null, active_bounds_us: null, at_limit: {},
  profile: {yaw: {min:1300,max:1700,home:1500},pitch:{min:1350,max:1650,home:1500}},
  drive_session: 'simulated-session-0', commanded_us: {yaw:1500,pitch:1500}};
let serial = 0;
function handle(action, payload = {}) {
  if (action === 'testMotionAudit') return motionAudit;
  if (action === 'motionFrame') return {frame: null};
  if (action.startsWith('motion')) {
    motionAudit.push({action, ...payload});
    if (action === 'motionConnect') {motion.connected = true; motion.camera_ready = true;}
    if (action === 'motionArm') {
      if ('laser_disconnected' in payload) throw new Error('The renderer must not require a laser-disconnected confirmation.');
      motion.armed = true; motion.holding = true; motion.commissioning = payload.commissioning;
    }
    if (action === 'motionTeaching') {motion.commissioning = payload.enabled; motion.drive_session = 'simulated-session-' + ++serial;}
    if (['motionStop', 'motionRelease', 'motionDisconnect'].includes(action)) {
      motion.driving = false; motion.drive_session = 'simulated-session-' + ++serial;
      if (action !== 'motionStop') {motion.armed = false; motion.holding = false;}
      if (action === 'motionDisconnect') {motion.connected = false; motion.camera_ready = false;}
    }
    if (action === 'motionDrive') motion.driving = Boolean(payload.yaw || payload.pitch);
    return {...motion};
  }
`);
const replay = new Module(fixturePath, module);
replay.filename = fixturePath;
replay.paths = Module._nodeModulePaths(__dirname);
replay._compile(source, fixturePath);
