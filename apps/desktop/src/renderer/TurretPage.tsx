import { useEffect, useRef, useState } from 'react';
import { TurretKeyboard } from './turret-keyboard';
import './turret.css';

type Region = {x:number; y:number; width:number; height:number};
type ComponentMap = {map_id:string; phase:string; approved:boolean; message:string; roi:Region;
  components:Array<{id:string; label:string; number:number; point:{x:number;y:number}|null}>};
type Guidance = {state:'running'|'completed'|'stopped'; stage:string; message:string; question:string;
  visited:string[]; index:number; total:number; reason?:string;
  answer?:{explanation:string;next_steps:string[];limitations:string[]}};
type Status = { connected: boolean; connecting: boolean; armed: boolean; moving: boolean; holding: boolean; driving: boolean; drive_session: string;
  commissioning: boolean; camera_ready: boolean; camera_focus_success: boolean | null; calibrated: boolean; target_selected: boolean; phase: string;
  message: string; orientation: number; profile: Record<string, {min: number; max: number; home: number}>;
  manual_bounds_us: {min: number; max: number} | null; active_bounds_us: Record<string, {min: number; max: number}> | null;
  at_limit: Record<string, 'lower' | 'upper' | null>;
  commanded_us: Record<string, number> | null; aim_reference: {x: number; y: number; distance_mm: number|null; source?:string} | null;
  component_map?:ComponentMap|null; tour?:{state:string;index:number;total:number;label:string;visited:string[];reason?:string}|null;
  guidance?:Guidance|null;
  framing?:{framing_id:string;state:string;message:string;bounds:Region|null;centre:{x:number;y:number}|null;
    geometry_current:boolean;fits_with_margin:boolean;source_touched_edge:boolean}|null };
type Frame = {jpeg_base64: string; sequence: number; generation: string; width: number; height: number;
  target: {x: number; y: number} | null;
  laser_spot?: {x:number;y:number;source:'red_spot_candidate'} | null; laser_spot_message?:string};

async function request(action: string, payload: Record<string, unknown> = {}) {
  if (!window.ohmpath) throw new Error('The local bench connection is unavailable.');
  const raw = await window.ohmpath.request(action, payload) as any;
  if (raw?.error) throw new Error(raw.message || raw.error);
  return raw?.data ?? raw;
}

export default function TurretPage({focusText = '', sharedCamera = false}: {
  focusText?:string; sharedCamera?:boolean;
} = {}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [fine, setFine] = useState(false);
  const [locked, setLocked] = useState(false);
  const [keysEnabled, setKeysEnabled] = useState(true);
  const [fps, setFps] = useState(0);
  const [setup, setSetup] = useState(true);
  const [referenceMode, setReferenceMode] = useState(false);
  const [spotMode, setSpotMode] = useState(false);
  const [regionMode, setRegionMode] = useState(false);
  const [region, setRegion] = useState<Region|null>(null);
  const [preparedFramingId, setPreparedFramingId] = useState<string|null>(null);
  const regionStart = useRef<{x:number;y:number}|null>(null);
  const skipClick = useRef(false);
  const [distance, setDistance] = useState(300);
  const [reverseYaw, setReverseYaw] = useState(false);
  const [reversePitch, setReversePitch] = useState(false);
  const alive = useRef(true);
  const shown = useRef<Frame | null>(null);
  const current = useRef<Status | null>(null);
  const lockedSession = useRef('');
  const inputOptions = useRef({keysEnabled: true, busy: false});
  inputOptions.current = {keysEnabled, busy: !!busy};
  const keyboard = useRef<TurretKeyboard | null>(null);
  const frameRate = useRef({start: performance.now(), count: 0, key: ''});
  if (!keyboard.current) keyboard.current = new TurretKeyboard(
    intent => request('motionDrive', intent),
    err => { endKeyboard(); setError(err instanceof Error ? err.message : String(err)); void request('motionRelease').then(update).catch(() => {}); }
  );
  keyboard.current.configure(fine, reverseYaw, reversePitch);

  function endKeyboard() { keyboard.current?.stop(); lockedSession.current = ''; if (alive.current) setLocked(false); }
  function update(value: Status) {
    if (!alive.current) return;
    current.current = value; setStatus(value);
    if (lockedSession.current && (!value.armed || value.drive_session !== lockedSession.current)) endKeyboard();
  }
  async function act(action: string, payload: Record<string, unknown> = {}) {
    if (['motionStop', 'motionRelease', 'motionDisconnect', 'motionRefocus', 'motionHome', 'motionTeaching', 'motionJog', 'motionSave', 'motionCalibrate', 'motionFollow', 'motionClearComponents', 'motionReposition', 'motionPrepareFraming', 'motionPointComponent'].includes(action)) endKeyboard();
    if (['motionDisconnect', 'motionRefocus', 'motionRotate'].includes(action)) {
      setRegion(null); setRegionMode(false); setSpotMode(false); setReferenceMode(false); regionStart.current=null;
      setPreparedFramingId(null);
    }
    setError(''); setBusy(action);
    try { const value=await request(action, payload); update(value);
      if (action==='motionPrepareFraming') setPreparedFramingId(value.framing.framing_id);
    }
    catch (err) { if (alive.current) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (alive.current) setBusy(''); }
  }
  async function lockKeyboard() {
    if (locked) { await act('motionStop'); return; }
    setKeysEnabled(true); setLocked(true);
  }

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>, previewTimer: ReturnType<typeof setTimeout>;
    let frameKey = '';
    async function poll() {
      try {
        // The mounted control page owns presence. Focus loss separately releases
        // manual control, but must not silently cancel an explicit automatic job.
        const value = await request('motionKeepalive');
        if (!alive.current) return;
        update(value);
      } catch (err) {
        if (alive.current) { setFrame(null); setError(err instanceof Error ? err.message : String(err)); }
      } finally { if (alive.current) timer = setTimeout(poll, 200); }
    }
    async function preview() {
      const started = performance.now();
      try {
        const result = current.current?.connected && document.visibilityState === 'visible' ? await request('motionFrame') : {frame: null};
        if (!alive.current) return;
        const key = result.frame ? `${result.frame.generation}:${result.frame.sequence}:${result.frame.width}:${current.current?.orientation}` : '';
        if (key !== frameKey) { frameKey = key; setFrame(result.frame); }
        if (!result.frame) { shown.current = null; setFps(0); }
      } catch { if (alive.current) { setFrame(null); setFps(0); } }
      finally { if (alive.current) previewTimer = setTimeout(preview, Math.max(0, 33 - (performance.now() - started))); }
    }
    const release = () => { endKeyboard(); void request('motionRelease').then(update).catch(() => {}); };
    const focusLost = () => {
      endKeyboard();
      const value = current.current;
      if (value?.guidance?.state === 'running' || value?.tour?.state === 'running') return;
      release();
    };
    const hidden = () => { if (document.visibilityState !== 'visible') focusLost(); };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { release(); return; }
      if ((event.target as HTMLElement)?.closest('textarea,select,input:not([type="checkbox"]):not([type="radio"]):not([type="button"]),[contenteditable="true"]') || event.altKey || event.ctrlKey || event.metaKey) return;
      if (!inputOptions.current.keysEnabled) return;
      if (event.code === 'Space' && current.current?.armed) { event.preventDefault(); endKeyboard(); void request('motionStop').then(update).catch(() => {}); return; }
      if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
      event.preventDefault(); // Never scroll the turret page while arrow control is selected.
      const value = current.current;
      if (!value?.armed || value.phase !== 'idle' || inputOptions.current.busy) return;
      if (!lockedSession.current) {
        lockedSession.current = value.drive_session;
        keyboard.current?.start(value.drive_session);
      }
      if (keyboard.current?.key(event.key, true)) event.preventDefault();
    };
    const keyup = (event: KeyboardEvent) => { if (keyboard.current?.key(event.key, false)) event.preventDefault(); };
    window.addEventListener('blur', focusLost);
    window.addEventListener('keydown', keydown, true); window.addEventListener('keyup', keyup, true);
    document.addEventListener('visibilitychange', hidden);
    void poll(); void preview();
    return () => {
      alive.current = false; keyboard.current?.stop(); clearTimeout(timer); clearTimeout(previewTimer);
      window.removeEventListener('blur', focusLost); window.removeEventListener('keydown', keydown, true); window.removeEventListener('keyup', keyup, true);
      document.removeEventListener('visibilitychange', hidden);
      if (sharedCamera) void request('motionRelease').catch(() => {});
      else void request('motionDisconnect').catch(() => {});
    };
  }, []);

  const enabled = Boolean(status?.armed && !busy && status.phase === 'idle' && !status.moving && !status.driving);
  const automatic = enabled && !status?.commissioning && status?.target_selected;
  const map = status?.component_map;
  const guidance = status?.guidance;
  const spot = frame?.laser_spot;
  const laserSpot = spot?.source === 'red_spot_candidate' && Number.isFinite(spot.x) && Number.isFinite(spot.y)
    && spot.x >= 0 && spot.x <= 1 && spot.y >= 0 && spot.y <= 1 ? spot : null;
  const framing = status?.framing;
  const framingCurrent = Boolean(framing && framing.framing_id===preparedFramingId && framing.state!=='lost' && framing.geometry_current && framing.fits_with_margin);
  const markedRegion = regionMode ? region : framingCurrent ? framing!.bounds : null;
  const canMark = Boolean(frame && !busy && status?.phase==='idle' && !status.moving && !status.driving && map?.phase!=='identifying');
  function coordinates(event: React.PointerEvent<HTMLImageElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    return {x:Math.max(0,Math.min(1,(event.clientX-box.left)/box.width)),y:Math.max(0,Math.min(1,(event.clientY-box.top)/box.height))};
  }
  function identify() {
    if (framingCurrent) void act('motionIdentifyComponents', {framing_id:framing!.framing_id});
  }
  function findSpot() {
    const displayed = shown.current;
    if (displayed) void act('motionSpotReference', {sequence:displayed.sequence,generation:displayed.generation});
  }
  function jog(axis: 'yaw' | 'pitch', direction: number) {
    const reverse = axis === 'yaw' ? reverseYaw : reversePitch;
    void act('motionJog', {axis, direction: reverse ? -direction : direction, fine});
  }

  return <section className={`turret-page ${locked ? 'keyboard-locked' : ''}`}>
    <header className="turret-heading"><div><p className="turret-eyebrow">LIVE HELP POINTER</p>
      <h1>Point to the current check</h1><p>{focusText || 'Choose a test in Live help or Photo help, then return here to point to its location.'}</p></div>
      <div className="turret-actions"><div className="turret-live-values" aria-label="Live servo commands"><strong>Pan {status?.commanded_us?.yaw?.toFixed(0) ?? '—'} µs</strong><strong>Tilt {status?.commanded_us?.pitch?.toFixed(0) ?? '—'} µs</strong>
        <small>{status?.armed ? 'Command being sent · not a measured position' : status?.commanded_us ? 'Last command · motors released' : 'Position unknown · motors released'}</small>
        <small>{status?.commissioning ? 'MANUAL · travel limits off' : 'Saved travel limits active'}</small>
        {Object.values(status?.at_limit ?? {}).some(Boolean) && <small className="turret-limit-reached">{(['yaw','pitch'] as const).filter(a => status?.at_limit?.[a]).map(a => `${a === 'yaw' ? 'Pan' : 'Tilt'} at ${status?.at_limit?.[a]} software bound`).join(' · ')}</small>}
      </div><button className="turret-stop" onClick={() => void act('motionStop')} disabled={!status?.connected}>Stop movement</button>
        <button onClick={() => void act('motionRelease')} disabled={!status?.connected}>Release motors · Esc</button></div>
    </header>
    <div className={`turret-status ${status?.armed ? 'active' : ''}`} role="status">
      <strong>{status?.armed ? status.moving || status.driving ? 'MOVING' : 'HOLDING POSITION' : 'MOTORS RELEASED'}</strong>
      <span>{status?.message || 'Connect the paired Raspberry Pi to begin.'}</span>
    </div>
    {error && <p className="turret-error" role="alert">{error}</p>}
    <section className="turret-manual-bar" aria-label="Keyboard and travel controls">
      <div><strong>← ↑ ↓ → Arrow-key control</strong><p>Hold an arrow to move. Let go to hold position. Space stops. Esc releases.</p></div>
      <label><input type="checkbox" checked={keysEnabled} onChange={e => {
        setKeysEnabled(e.target.checked); if (!e.target.checked) {endKeyboard(); if (status?.connected) void act('motionStop');}
      }} /> Use arrow keys</label>
      <button disabled={!!busy} onClick={() => void lockKeyboard()}>{locked ? 'Exit keyboard control' : 'Lock camera view'}</button>
      <button className="turret-primary" disabled={!!busy || !status?.armed} onClick={() => void act('motionTeaching', {enabled: !status?.commissioning})}>{status?.commissioning ? 'Use saved limits' : 'Full manual range'}</button>
      {status?.commissioning && <p className="turret-teaching-note">Manual travel limits are off on both axes. Release the arrow before the mechanism hits a stop or pulls a wire. Report the Pan / Tilt values at your usable endpoints.</p>}
      {!status?.armed && <p>Connect and enable movement below. Full manual range and arrow keys are selected by default.</p>}
    </section>
    <div className="turret-layout">
      <div className="turret-camera-card">
        <div className="turret-camera-toolbar"><strong>Pi camera <small>{frame ? `${frame.width} × ${frame.height} · ${fps} fps` : ''}</small></strong><div>
          <button disabled={!!busy || status?.armed || !status?.connected} onClick={() => void act('motionRefocus')}>{busy === 'motionRefocus' ? 'Focusing…' : 'Refocus'}</button>
          <button disabled={!!busy || status?.armed || !status?.connected} onClick={() => void act('motionRotate')}>Rotate view</button>
          <button disabled={!!busy || status?.connecting} onClick={() => void act(status?.connected ? 'motionDisconnect' : 'motionConnect')}>
            {busy === 'motionConnect' || status?.connecting ? 'Connecting…' : status?.connected ? 'Disconnect' : 'Connect Pi'}</button>
        </div></div>
        <p className="turret-note">Focus locks when connected. After changing working distance, release motors and choose Refocus before recalibrating.</p>
        {status?.camera_focus_success === false && <p className="turret-error">Autofocus could not confirm a sharp detail. Aim at the circuit, improve lighting, then release motors and choose Refocus.</p>}
        <div className="turret-view">
          {frame ? <div className="turret-image-wrap" style={{aspectRatio:`${frame.width}/${frame.height}`}}>
            <img src={`data:image/jpeg;base64,${frame.jpeg_base64}`} alt="Live Raspberry Pi turret camera"
              onPointerDown={event => {
                if (!regionMode || locked || !canMark) return;
                setPreparedFramingId(null);
                regionStart.current=coordinates(event); skipClick.current=true;
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={event => {
                const start=regionStart.current; if (!start) return;
                const end=coordinates(event);
                setRegion({x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),width:Math.abs(end.x-start.x),height:Math.abs(end.y-start.y)});
              }}
              onPointerUp={event => {
                const start=regionStart.current, displayed=shown.current;
                if (!start) return;
                const end=coordinates(event);
                const roi={x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),width:Math.abs(end.x-start.x),height:Math.abs(end.y-start.y)};
                setRegion(roi);
                event.currentTarget.releasePointerCapture(event.pointerId); regionStart.current=null; setRegionMode(false);
                if (displayed && roi.width>=.05 && roi.height>=.05) void act('motionPrepareFraming', {roi,sequence:displayed.sequence,generation:displayed.generation});
              }}
              onPointerCancel={() => {regionStart.current=null;setRegionMode(false);}}
              draggable={false} onLoad={() => {
                shown.current = frame;
                const rate = frameRate.current, key = `${frame.generation}:${frame.sequence}`;
                if (key !== rate.key) { rate.count++; rate.key = key; }
                const elapsed = performance.now() - rate.start;
                if (elapsed >= 1000) { setFps(Math.round(rate.count * 1000 / elapsed)); rate.start = performance.now(); rate.count = 0; }
              }}
              onClick={event => {
                if (skipClick.current) {skipClick.current=false;return;}
                const displayed = shown.current;
                if (!displayed || locked || busy || regionMode || status?.moving || status?.driving || status?.phase !== 'idle') return;
                const box = event.currentTarget.getBoundingClientRect();
                const payload = {x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height,
                  sequence: displayed.sequence, generation: displayed.generation};
                if (spotMode) {void act('motionSpotReference', payload);setSpotMode(false);}
                else if (referenceMode) { void act('motionAimReference', {...payload, distance_mm: distance}); setReferenceMode(false); }
                else void act('motionSelect', payload);
              }} />
            {frame.target && <span className="turret-target" style={{left: `${frame.target.x * 100}%`, top: `${frame.target.y * 100}%`}} aria-label="Tracked feature" />}
            {laserSpot && <span className="turret-laser-spot" style={{left: `${laserSpot.x * 100}%`, top: `${laserSpot.y * 100}%`}} aria-label="Detected beam candidate" />}
            {markedRegion && !map?.approved && <span className="turret-circuit-region" aria-label="Selected circuit area" style={{left:`${markedRegion.x*100}%`,top:`${markedRegion.y*100}%`,width:`${markedRegion.width*100}%`,height:`${markedRegion.height*100}%`}} />}
            {map?.components.map(component => component.point && <span className="turret-component-marker" key={component.id} style={{left:`${component.point.x*100}%`,top:`${component.point.y*100}%`}} title={component.label}>{component.number}</span>)}
          </div> : <p>{status?.connected ? 'Waiting for a fresh camera image…' : 'Connect to see the camera over your Ethernet cable.'}</p>}
        </div>
        <p className="turret-caption" aria-label="Laser marker status">{laserSpot ? 'Small crosshair: current red beam candidate. Confirm it matches the beam. Green ring: current target.' : frame ? `${frame.laser_spot_message || 'No clear beam candidate is visible in this image.'} If you can see it, choose Click laser spot.` : 'The crosshair appears only when a red beam candidate is detected in the current camera image.'}</p>
        {(regionMode || spotMode || locked || referenceMode) && <p className="turret-caption">{regionMode ? 'Drag a rectangle around the circuit surface. Include clear board details and exclude the background.' : spotMode ? 'Click the visible red laser spot. The motors remain released.' : locked ? 'Hold ← → to pan, ↑ ↓ to tilt. Release the keys to hold position. Space stops and exits. Esc releases the motors.' : 'Click the known beam landing point to save a reference for this working distance.'}</p>}
        {locked && <label className="turret-locked-fine"><input type="checkbox" checked={fine} onChange={e => setFine(e.target.checked)} /> Fine control</label>}
      </div>
      <aside className="turret-controls">
        <section aria-label="Pointer target map"><h2>Choose the location for this check</h2>
          <p>Mark the visible circuit area, identify visible parts once, review the map, then choose the part named in the current test. This only locates a pointer target; it does not diagnose the circuit.</p>
          <div className="turret-actions"><button disabled={!canMark} onClick={() => {setRegionMode(!regionMode);setSpotMode(false);setReferenceMode(false);}}>{regionMode ? 'Cancel marking' : 'Mark circuit area'}</button>
            <button disabled={!enabled || !framingCurrent} onClick={() => void act('motionReposition',{framing_id:framing!.framing_id})}>Centre circuit in view</button>
            <button disabled={!frame || !markedRegion || markedRegion.width<.05 || markedRegion.height<.05 || !!busy || status?.armed || map?.phase === 'identifying'} onClick={identify}>{map?.phase === 'identifying' ? 'Identifying…' : 'Identify components'}</button></div>
          {framing && <p role="status">{framing.message}</p>}
          {framing?.source_touched_edge && <p className="turret-note">This selection touches the image edge. Centring follows the visible area; mark the full board once it comes into view.</p>}
          <p className="turret-note">Only the selected circuit crop is sent through your signed-in Codex subscription when you choose Identify.</p>
          {map && <><p role="status">{map.message}</p><ol className="turret-component-list">{map.components.map(component => {
            const visited = status?.tour?.visited.includes(component.id) || guidance?.visited.includes(component.id);
            return <li key={component.id} className={visited ? 'visited' : ''}><span>{component.label}{visited ? ' · visited' : ''}</span>
              {map.approved && <button disabled={!enabled} aria-label={`Point to ${component.label}`}
                onClick={() => void act('motionPointComponent', {map_id:map.map_id,component_id:component.id})}>Point here</button>}</li>;
          })}</ol>
            <div className="turret-actions"><button disabled={!!busy || status?.armed || map.phase !== 'review'} onClick={() => void act('motionApproveComponents',{map_id:map.map_id})}>Accept component map</button>
            <button disabled={!!busy} onClick={() => void act('motionClearComponents')}>Clear component map</button></div></>}
          <h3>Laser reference</h3><p>The camera centre and laser landing point are different. Set this reference while stationary.</p>
          <div className="turret-actions"><button disabled={!frame || !!busy || status?.armed} onClick={findSpot}>Use visible red spot</button>
            <button disabled={!frame || !!busy || status?.armed} onClick={() => {setSpotMode(!spotMode);setRegionMode(false);setReferenceMode(false);}}>{spotMode ? 'Cancel spot selection' : 'Click laser spot'}</button></div>
          <p className="turret-note">The small crosshair follows a beam candidate detected in each current image. A saved reference never substitutes for a missing spot.</p>
        </section>
        <section><h2>1. Enable movement</h2>
          <p className="turret-note">Enabling sends Pan {status?.profile.yaw.home ?? '—'} µs / Tilt {status?.profile.pitch.home ?? '—'} µs (saved home). The app cannot read their physical positions; reconnecting does not measure or redefine zero.</p>
          <button className="turret-primary" disabled={!status?.camera_ready || status?.armed || !!busy}
            onClick={() => void act('motionArm', {clear:true, commissioning: setup})}>{status?.armed ? 'Movement enabled' : 'Enable movement'}</button>
        </section>
        <section><h2>2. Move and save home</h2><div className="turret-pad">
          <button className="up" disabled={!enabled} onClick={() => jog('pitch', 1)}>Tilt ↑</button>
          <button className="left" disabled={!enabled} onClick={() => jog('yaw', -1)}>Pan ←</button>
          <button className="home" disabled={!enabled} onClick={() => void act('motionHome')}>Home</button>
          <button className="right" disabled={!enabled} onClick={() => jog('yaw', 1)}>Pan →</button>
          <button className="down" disabled={!enabled} onClick={() => jog('pitch', -1)}>Tilt ↓</button>
        </div><label><input type="checkbox" checked={fine} onChange={e => setFine(e.target.checked)} /> Fine control · smaller steps and slower keyboard movement</label>
          <p className="turret-note">Arrow keys work immediately when movement is enabled. Full manual range bypasses the saved stops; your measured endpoints will define the range for automatic pointing.</p>
          <button disabled={!enabled} onClick={() => void act('motionSave', {what: 'home'})}>Save this position as home</button>
          <p className="turret-note">Stop keeps the holding signal. Release removes it, so the arm may relax. Leaving this page releases control. Switching apps releases manual control; a started automatic guide or tour continues until finished or stopped.</p>
        </section>
        <section><h2>3. Follow a camera point</h2><p>Choose a still, textured detail near the middle. Calibration measures the image response to small movements and finishes at the measured position.</p>
          <div className="turret-actions"><button disabled={!automatic} onClick={() => void act('motionCalibrate')}>{status?.phase === 'calibrating' ? 'Calibrating…' : 'Calibrate movement'}</button>
            <button disabled={!automatic || !status?.calibrated} onClick={() => void act('motionFollow', {aim: false})}>Centre selected point</button></div>
          <p className="turret-note">{status?.commissioning ? 'Teach and save your endpoints, then choose Use saved limits before automatic calibration.' : status?.calibrated ? 'Current local camera calibration is ready.' : 'Movement must be calibrated before automatic alignment.'} Alignment ends once centred or after 30 seconds.</p>
        </section>
      </aside>
    </div>
    <div className="turret-bottom">
      <details><summary>Travel limits and direction</summary>
        <p>Your saved endpoints below define the range for automatic pointing. Travel values are commands, not measured angles. Full manual range bypasses these stops for further endpoint testing. Automatic movement is unavailable during setup.</p>
        <label><input type="checkbox" checked={setup} onChange={e => setSetup(e.target.checked)} disabled={status?.armed} /> Full manual range on enable · bypass saved limits</label>
        <label><input type="checkbox" checked={reverseYaw} onChange={e => setReverseYaw(e.target.checked)} /> Reverse pan button direction</label>
        <label><input type="checkbox" checked={reversePitch} onChange={e => setReversePitch(e.target.checked)} /> Reverse tilt button direction</label>
        {(['yaw', 'pitch'] as const).map(axis => <div className="turret-limit" key={axis}><strong>{axis === 'yaw' ? 'Pan' : 'Tilt'}</strong>
          <span>Command: {status?.commanded_us?.[axis]?.toFixed(0) ?? '—'} · saved {status?.profile[axis].min}–{status?.profile[axis].max} µs</span>
          <button disabled={!enabled || !status?.commissioning} onClick={() => void act('motionSave', {what: 'min', axis})}>Save lower end</button>
          <button disabled={!enabled || !status?.commissioning} onClick={() => void act('motionSave', {what: 'max', axis})}>Save upper end</button></div>)}
      </details>
      <details><summary>Aiming reference</summary>
        <p>A manually saved reference applies only at the recorded working distance with the same rigid mount. It is not shown as a live laser spot or treated as a verified laser calibration.</p>
        <label>Working distance (mm) <input type="number" min="50" max="3000" value={distance} onChange={e => setDistance(Number(e.target.value))} /></label>
        <div className="turret-actions"><button disabled={!frame || status?.moving || !!busy} onClick={() => setReferenceMode(!referenceMode)}>{referenceMode ? 'Cancel reference selection' : 'Set reference in camera view'}</button>
          <button disabled={!automatic || !status?.calibrated || !status?.aim_reference} onClick={() => void act('motionFollow', {aim: true})}>Align to reference</button></div>
        <p className="turret-note">The two-wire laser is externally powered. This page controls movement and cannot switch the laser on or off.</p>
      </details>
    </div>
  </section>;
}
