'use strict';

// Served over the app-lifetime HTTPS pairing link. The capability stays in the URL fragment.
function phoneLivePage(nonce) {
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce))
    throw new Error('Invalid page nonce.');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light"><title>Live phone camera · Ohm Path</title>
<style nonce="${nonce}">
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#213d32;background:#f4eddd}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;background:radial-gradient(circle at top left,#e3ecd9 0,transparent 45%),linear-gradient(160deg,#f7f0df,#e7dfc9)}
main{max-width:680px;margin:auto;padding:24px 18px calc(32px + env(safe-area-inset-bottom))}.brand{display:flex;align-items:center;gap:11px;margin-bottom:20px;color:#355745;font-weight:800;letter-spacing:.06em;font-size:13px}.mark{display:grid;place-items:center;width:42px;height:42px;border-radius:13px;background:#486b51;color:#fff9e7;font-size:28px;box-shadow:0 3px 0 #795840}
.card{padding:clamp(20px,5vw,30px);border:1px solid #b9b797;border-radius:20px;background:#fffbf2;box-shadow:0 16px 35px #4b442b1c}h1{font:700 clamp(29px,8vw,41px)/1.12 Georgia,serif;color:#48382a;margin:0 0 11px}p{line-height:1.5;margin:0 0 15px;color:#52675b}.small{font-size:13px}.view{position:relative;overflow:hidden;border-radius:15px;background:#1a2a24;aspect-ratio:16/9;margin:20px 0 14px;display:grid;place-items:center;color:#e5eedf}.view video{width:100%;height:100%;object-fit:contain;display:none}.view.live video{display:block}.view.live .placeholder{display:none}.placeholder{text-align:center;padding:20px;font-size:14px;line-height:1.5}
label{display:block;font-size:14px;font-weight:700;margin:15px 0 7px}select{width:100%;padding:12px;border:1px solid #98aa93;border-radius:10px;background:#fffefa;color:#213d32;font:inherit}button{width:100%;padding:14px 18px;border:0;border-radius:11px;font:700 16px system-ui;cursor:pointer}.start{background:#486b51;color:#fffaf0;box-shadow:0 4px 0 #2d4d38}.stop{background:#eee2cd;color:#643f35;border:1px solid #b99483;margin-top:11px}button:disabled{opacity:.52;cursor:not-allowed;box-shadow:none}.status{min-height:44px;margin:16px 0 0;padding:12px 14px;border-radius:10px;background:#edf1e4;color:#345342;font-weight:650;font-size:14px}.status.error{background:#f8eae1;color:#8d3b30}.detail{font-size:13px;color:#677366;min-height:18px;margin:8px 2px 0}footer{margin:17px 5px 0;color:#647064;font-size:13px;line-height:1.5}
</style></head><body><main><div class="brand"><span class="mark" aria-hidden="true">Ω</span><span>OHM PATH · LIVE CAMERA</span></div>
<section class="card"><h1>Show your bench live</h1><p>Keep your phone and laptop on the same Wi-Fi. Cloudflare carries the pairing information; video travels directly between the devices when their network allows it.</p>
<div id="view" class="view"><video id="preview" autoplay muted playsinline aria-label="Your phone camera preview"></video><span class="placeholder">Your camera stays off until you tap Start.</span></div>
<label for="quality">Video quality</label><select id="quality"><option value="1080">Full detail · 1080p</option><option value="720">Steadier connection · 720p</option></select>
<button id="start" class="start" type="button">Start rear camera</button><button id="stop" class="stop" type="button" disabled>Stop camera</button>
<p id="status" class="status" role="status" aria-live="polite">Tap Start after connecting the phone camera on your laptop.</p><p id="detail" class="detail"></p></section>
<footer>No recording or AI analysis starts here. Choose a snapshot and Ask on the laptop when you want help. If focus is soft, move the phone back or add light. Keep this page open during a brief laptop refresh to reconnect automatically. Locking the phone stops capture; a full laptop app restart needs a new QR link.</footer></main>
<script nonce="${nonce}">
(() => {
  'use strict';
  const tokenFromLink = new URLSearchParams(location.hash.slice(1)).get('token') || '';
  history.replaceState(null, '', location.pathname + location.search);
  const storageKey = 'ohmpath-phone-live-token';
  let storedToken = '';
  try { storedToken = sessionStorage.getItem(storageKey) || ''; } catch { /* Private storage may be unavailable. */ }
  const token = tokenFromLink || storedToken;
  if (/^[A-Za-z0-9_-]{43}$/.test(tokenFromLink)) {
    try { sessionStorage.setItem(storageKey, tokenFromLink); } catch { /* This tab still keeps the token in memory. */ }
  }
  const startButton = document.getElementById('start');
  const stopButton = document.getElementById('stop');
  const quality = document.getElementById('quality');
  const status = document.getElementById('status');
  const detail = document.getElementById('detail');
  const view = document.getElementById('view');
  const preview = document.getElementById('preview');
  let generation = 0;
  let phase = 'idle';
  let stream = null;
  let peer = null;
  let wakeLock = null;
  let clientId = null;
  let sessionId = null;
  let answerAttempted = false;
  let pollTimer = null;
  let disconnectTimer = null;
  let connectTimer = null;
  let misses = 0;
  let canResume = false;
  const requests = new Set();
  function message(value, error) { status.textContent = value; status.className = 'status' + (error ? ' error' : ''); }
  function current(id) { return id === generation && phase !== 'idle'; }
  function clearTimers() {
    clearTimeout(pollTimer); clearTimeout(disconnectTimer); clearTimeout(connectTimer);
    pollTimer = disconnectTimer = connectTimer = null;
  }
  async function releaseRemote(stoppedSession, stoppedClient) {
    if (!stoppedSession || !stoppedClient || !token) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch('/stop', { method: 'POST', credentials: 'omit', cache: 'no-store', keepalive: true,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ session_id: stoppedSession, client_id: stoppedClient }) });
        if (response.ok || response.status !== 409) return;
      } catch { /* A transient network failure can race an answer in flight. */ }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  function stop(reason, error = false) {
    if (phase === 'idle') return;
    ++generation;
    phase = 'idle';
    clearTimers();
    for (const controller of requests) controller.abort();
    requests.clear();
    if (stream) { for (const track of stream.getTracks()) track.stop(); stream = null; }
    if (peer) { peer.close(); peer = null; }
    preview.srcObject = null;
    view.classList.remove('live');
    if (wakeLock) { void wakeLock.release().catch(() => undefined); wakeLock = null; }
    const stoppedSession = sessionId, stoppedClient = clientId;
    if (answerAttempted) void releaseRemote(stoppedSession, stoppedClient);
    answerAttempted = false;
    sessionId = null;
    clientId = null;
    misses = 0;
    startButton.disabled = !/^[A-Za-z0-9_-]{43}$/.test(token);
    stopButton.disabled = true;
    quality.disabled = false;
    detail.textContent = '';
    message(reason || 'Camera stopped. Tap Start again; this same pairing page will reconnect automatically.', error);
  }
  async function request(path, options = {}, timeout = 6000) {
    const controller = new AbortController();
    requests.add(controller);
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(path, { credentials: 'omit', cache: 'no-store',
        ...options, headers: { Authorization: 'Bearer ' + token, ...(options.headers || {}) }, signal: controller.signal });
      if (!response.ok) throw new Error('session_unavailable');
      return await response.json();
    } finally { clearTimeout(timer); requests.delete(controller); }
  }
  function constraints() {
    const tall = quality.value === '720' ? 720 : 1080;
    return { audio: false, video: { facingMode: { ideal: 'environment' },
      width: { ideal: Math.round(tall * 16 / 9) }, height: { ideal: tall },
      frameRate: { ideal: 30, max: 30 } } };
  }
  async function gathered(pc, id) {
    if (pc.iceGatheringState === 'complete') return;
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', changed); resolve(); };
      const changed = () => { if (pc.iceGatheringState === 'complete' || !current(id)) done(); };
      const timer = setTimeout(done, 5000);
      pc.addEventListener('icegatheringstatechange', changed);
    });
  }
  function connectionState(id) {
    if (!current(id) || !peer) return;
    const state = peer.connectionState;
    if (state === 'connected') {
      clearTimeout(connectTimer); connectTimer = null;
      clearTimeout(disconnectTimer); disconnectTimer = null;
      phase = 'streaming';
      canResume = true;
      const settings = stream?.getVideoTracks()[0]?.getSettings?.() || {};
      detail.textContent = settings.width && settings.height ? settings.width + ' × ' + settings.height + ' · live preview' : 'Live preview';
      message('Live on your laptop. Keep this page open.');
    } else if (state === 'failed' || state === 'closed') {
      phase = 'reconnecting';
      message('Laptop video interrupted. Waiting briefly for it to reconnect…');
      if (!disconnectTimer) disconnectTimer = setTimeout(() => stop('The laptop did not reconnect. Start again after pairing there.', true), 30000);
    } else if (state === 'disconnected' && !disconnectTimer) {
      phase = 'reconnecting';
      message('Laptop video interrupted. Waiting briefly for it to reconnect…');
      disconnectTimer = setTimeout(() => stop('The laptop did not reconnect. Start again after pairing there.', true), 30000);
    } else if (state === 'connecting' && disconnectTimer) {
      clearTimeout(disconnectTimer); disconnectTimer = null;
    }
  }
  function schedulePoll(id) { if (current(id)) pollTimer = setTimeout(() => void poll(id), 2000); }
  async function sessionForStart(id) {
    let data = await request('/session');
    if (!current(id) || !canResume || data?.active !== false || data.state !== 'idle') return data;
    message('Waiting for your laptop to prepare the next connection…');
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (!current(id)) return null;
      data = await request('/session');
      if (data?.active !== false || data.state !== 'idle') return data;
    }
    return data;
  }
  function reconnect() {
    if (!stream || stream.getVideoTracks().length !== 1 || stream.getVideoTracks()[0].readyState !== 'live') {
      stop('The phone camera stopped. Tap Start again after pairing on the laptop.', true); return;
    }
    clearTimers();
    const previous = peer;
    peer = null;
    previous?.close();
    answerAttempted = false;
    sessionId = null;
    clientId = null;
    phase = 'reconnecting';
    message('Laptop reconnected. Restoring your live camera…');
    void start(true);
  }
  async function poll(id) {
    if (!current(id)) return;
    try {
      const data = await sessionForStart(id);
      if (!current(id)) return;
      if (data.active === true && data.session_id !== sessionId && data.state === 'waiting'
          && data.offer?.type === 'offer') { reconnect(); return; }
      if (data.active !== true || data.session_id !== sessionId || data.state !== 'answered') {
        stop('The laptop ended this session. Connect there, then tap Start here again.'); return;
      }
      misses = 0;
    } catch (error) {
      if (!current(id)) return;
      if (error.message === 'session_unavailable') { stop('The laptop ended this session. Connect there, then tap Start here again.'); return; }
      if (++misses >= 3) { stop('Could not reach the laptop. Check the connection, then try Start again.', true); return; }
    }
    schedulePoll(id);
  }
  async function postAnswer(answer, id, answerSession, answerClient) {
    answerAttempted = true;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await request('/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: answerSession, client_id: answerClient, answer }) }, 6000);
        if (!current(id)) { void releaseRemote(answerSession, answerClient); return; }
        return;
      } catch (error) {
        if (!current(id)) return;
        if (error.message === 'session_unavailable') throw error;
        if (attempt === 2) throw error;
      }
    }
  }
  async function start(reuseCamera = false) {
    if ((phase !== 'idle' && !(reuseCamera && phase === 'reconnecting')) || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    phase = 'starting';
    const id = ++generation;
    clientId = crypto.randomUUID();
    startButton.disabled = true;
    stopButton.disabled = false;
    quality.disabled = true;
    message('Checking your laptop pairing…');
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
        throw new Error('This browser needs a secure connection with camera and video support.');
      const data = await request('/session');
      if (!current(id)) return;
      if (data?.active === false && data.state === 'idle') {
        stop('On your laptop, press Connect phone camera. Then tap Start here again.'); return;
      }
      if (!data || data.active !== true || typeof data.session_id !== 'string' || !data.offer || data.offer.type !== 'offer'
          || typeof data.offer.sdp !== 'string' || data.state !== 'waiting')
        throw new Error('This camera session is unavailable. Connect on your laptop, then tap Start here again.');
      sessionId = data.session_id;
      if (!reuseCamera) {
        message('Allow your rear camera when the browser asks.');
        const acquired = await navigator.mediaDevices.getUserMedia(constraints());
        if (!current(id)) { acquired.getTracks().forEach(track => track.stop()); return; }
        stream = acquired;
      }
      const tracks = stream.getVideoTracks();
      if (tracks.length !== 1 || stream.getAudioTracks().length) throw new Error('Could not start a video-only camera.');
      if (!reuseCamera) tracks[0].addEventListener('ended', () => { if (phase !== 'idle') stop('The camera stopped. Connect on your laptop, then tap Start here again.', true); });
      const capabilities = tracks[0].getCapabilities?.();
      if (capabilities?.focusMode?.includes('continuous')) {
        try { await tracks[0].applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); }
        catch { /* Automatic focus is optional. */ }
      }
      if (!current(id)) return;
      preview.srcObject = stream;
      view.classList.add('live');
      void preview.play().catch(() => undefined);
      message('Connecting the video to your laptop…');
      if (!wakeLock && navigator.wakeLock?.request) {
        try { wakeLock = await navigator.wakeLock.request('screen'); }
        catch { /* Wake lock is best effort. */ }
        if (!current(id)) { if (wakeLock) void wakeLock.release().catch(() => undefined); wakeLock = null; return; }
      }
      peer = new RTCPeerConnection({ iceServers: [] });
      const pc = peer;
      pc.addEventListener('connectionstatechange', () => connectionState(id));
      await pc.setRemoteDescription(data.offer);
      if (!current(id)) return;
      const sender = pc.addTrack(tracks[0], stream);
      const answer = await pc.createAnswer();
      if (!current(id)) return;
      await pc.setLocalDescription(answer);
      // Circuit labels benefit from retained pixels more than a high frame rate.
      // WebRTC still adapts bitrate; unsupported preferences are non-fatal.
      try {
        const parameters = sender.getParameters();
        parameters.degradationPreference = 'maintain-resolution';
        if (parameters.encodings?.length) parameters.encodings[0].maxBitrate = quality.value === '720' ? 3000000 : 6000000;
        await sender.setParameters(parameters);
      } catch { /* Safari versions may not expose encoding preferences. */ }
      await gathered(pc, id);
      if (!current(id)) return;
      await postAnswer({ type: 'answer', sdp: pc.localDescription.sdp }, id, sessionId, clientId);
      if (!current(id)) return;
      phase = 'connecting';
      connectTimer = setTimeout(() => stop('Video could not connect. Check both devices are on the same Wi-Fi, then pair again.', true), 25000);
      schedulePoll(id);
      connectionState(id);
    } catch (error) {
      if (!current(id)) return;
      const denied = error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError';
      const missing = error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError';
      stop(denied ? 'Camera access was denied. Allow it in browser settings, then tap Start again.'
        : missing ? 'No usable camera was found. Check your camera permissions, then try Start again.'
        : error?.message?.startsWith('This ') ? error.message
        : 'Could not start the camera. Check the laptop and Wi-Fi, then try Start again.', true);
    }
  }
  startButton.addEventListener('click', () => void start());
  stopButton.addEventListener('click', () => stop('Camera stopped. Tap Start again; this same pairing page will reconnect automatically.'));
  window.addEventListener('pagehide', () => stop('Camera stopped. Tap Start again after reconnecting on your laptop.'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && phase !== 'idle') stop('Camera stopped when the page was hidden. Connect on your laptop, then tap Start here again.');
  });
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    startButton.disabled = true;
    message('This pairing link is missing its private code. Open a fresh link on your laptop.', true);
  }
})();
</script></body></html>`;
}

module.exports = { phoneLivePage };
