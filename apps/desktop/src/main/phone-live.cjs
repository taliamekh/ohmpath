const http = require('node:http');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { trustedTunnelUrl } = require('./phone-live-tunnel.cjs');

const MAX_BODY = 80 * 1024;
const MAX_SDP = 64 * 1024;
const READ_MS = 10_000;
const DESKTOP_MS = 20_000;
const INITIAL_DESKTOP_MS = 35_000;
const PHONE_MS = 15_000;

function oneHeader(req, name) {
  let result = null;
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name) { result = req.rawHeaders[i + 1]; count++; }
  }
  return count === 1 ? result : null;
}

function headerCount(req, name) {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2)
    if (req.rawHeaders[i].toLowerCase() === name) count++;
  return count;
}

function validSdp(value, type) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 2 || value.type !== type
      || typeof value.sdp !== 'string' || value.sdp.length < 20 || value.sdp.length > MAX_SDP
      || !/^v=0\r?\n/.test(value.sdp) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.sdp)) return false;
  const media = value.sdp.match(/^m=([^\s\r\n]+)/gm) || [];
  return media.length > 0 && media.every(line => line === 'm=video');
}

function json(res, code, data, extra = {}) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin',
    'Connection': 'close', ...extra });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let finished = false;
    const timer = setTimeout(() => finish(new Error('timeout')), READ_MS);
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', aborted);
      req.off('aborted', aborted);
      if (error) { req.pause(); reject(error); }
      else resolve(value);
    };
    const data = chunk => {
      size += chunk.length;
      if (size > MAX_BODY) finish(new Error('large'));
      else chunks.push(chunk);
    };
    const end = () => {
      try { finish(null, JSON.parse(Buffer.concat(chunks, size).toString('utf8'))); }
      catch { finish(new Error('invalid')); }
    };
    const aborted = () => finish(new Error('aborted'));
    req.on('data', data); req.once('end', end);
    req.once('error', aborted); req.once('aborted', aborted);
  });
}

function createPhoneLiveBridge({ tunnelFactory, pageFactory = () => '<!doctype html><title>Ohm Path phone camera</title>', now = Date.now } = {}) {
  if (typeof tunnelFactory !== 'function' || typeof pageFactory !== 'function' || typeof now !== 'function')
    throw new TypeError('A tunnel factory, page factory, and clock are required.');
  let portal = null;
  let current = null;
  let serial = 0;
  let last = { state: 'stopped', error: null };

  function link(p = portal) {
    return p?.origin && p.token ? `${p.origin}/#token=${p.token}` : null;
  }

  function snapshot(sessionId) {
    const url = link();
    const base = { link_available: Boolean(url), url, error: portal ? null : last.error };
    if (sessionId && current?.id !== sessionId)
      return { ...base, active: false, session_id: sessionId, state: 'stopped',
        answer: null, expires_at: null };
    if (!current) return { ...base, active: false, session_id: '',
      state: portal ? 'idle' : last.state, answer: null, expires_at: null };
    return { ...base, active: true, session_id: current.id, state: current.state,
      answer: current.answer, expires_at: null };
  }

  function expired(session) {
    const time = now();
    return time - session.startedAt > INITIAL_DESKTOP_MS && time - session.lastDesktop > DESKTOP_MS
      || session.state === 'answered' && time - session.lastPhone > PHONE_MS;
  }

  function endSession(session = current) {
    if (!session || current !== session) return;
    current = null;
    session.offer = null;
    session.answer = null;
    session.clientId = null;
  }

  function closePortal(p, state = 'stopped', error = null) {
    if (portal !== p) return Promise.resolve();
    portal = null;
    serial++;
    endSession();
    last = { state, error };
    p.token = null;
    p.origin = null;
    clearInterval(p.timer);
    p.controller.abort();
    p.cancelListen?.();
    p.sockets.forEach(socket => socket.destroy());
    const serverClosed = new Promise(resolve => {
      try { p.server.close(() => resolve()); }
      catch { resolve(); }
    });
    let tunnelClosed = Promise.resolve();
    if (p.tunnel) {
      try { tunnelClosed = Promise.resolve(p.tunnel.stop()).catch(() => undefined); }
      catch { /* A failed stop cannot restore a closed listener or token. */ }
    }
    return Promise.all([serverClosed, tunnelClosed]).then(() => undefined);
  }

  function status(sessionId) {
    if (current && expired(current)) endSession();
    if (current && (!sessionId || sessionId === current.id)) current.lastDesktop = now();
    return snapshot(sessionId);
  }

  async function handle(p, req, res) {
    if (portal !== p || !p.token || !p.origin)
      return json(res, 410, { error: 'Phone camera link closed.' });
    if (current && expired(current)) endSession();
    const host = new URL(p.origin).host;
    if (headerCount(req, 'host') !== 1 || oneHeader(req, 'host') !== host
        || headerCount(req, 'origin') > 1 || oneHeader(req, 'origin') && oneHeader(req, 'origin') !== p.origin
        || oneHeader(req, 'sec-fetch-site') === 'cross-site')
      return json(res, 403, { error: 'Phone camera session unavailable.' });
    const time = now();
    p.requests = p.requests.filter(t => time >= t && time - t < 10_000);
    if (p.requests.length >= 100) return json(res, 429, { error: 'Try again shortly.' });
    p.requests.push(time);
    if (req.method === 'GET' && req.url === '/') {
      const nonce = randomBytes(18).toString('base64url');
      const body = pageFactory(nonce);
      if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_BODY)
        return json(res, 503, { error: 'Phone camera page unavailable.' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
        'X-OhmPath-Camera': 'pairing-v1',
        'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin',
        'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        'Connection': 'close' });
      return res.end(body);
    }
    if (!(req.method === 'GET' && req.url === '/session'
        || req.method === 'POST' && ['/answer', '/stop'].includes(req.url)))
      return json(res, 404, { error: 'Not found.' });
    const auth = oneHeader(req, 'authorization');
    const candidate = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const offered = Buffer.from(candidate);
    const expected = Buffer.from(p.token);
    if (offered.length !== expected.length || !timingSafeEqual(offered, expected))
      return json(res, 403, { error: 'Phone camera session unavailable.' });
    if (req.method === 'GET') {
      if (!current) return json(res, 200, { active: false, state: 'idle', session_id: '' });
      current.lastPhone = time;
      return json(res, 200, { active: true, session_id: current.id, offer: current.offer,
        state: current.state, expires_at: null });
    }
    if (oneHeader(req, 'origin') !== p.origin)
      return json(res, 403, { error: 'Phone camera session unavailable.' });
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(oneHeader(req, 'content-type') || ''))
      return json(res, 415, { error: 'Expected JSON.' });
    const length = oneHeader(req, 'content-length');
    const encoding = oneHeader(req, 'transfer-encoding');
    if (headerCount(req, 'content-length') > 1 || headerCount(req, 'transfer-encoding') > 1
        || length !== null && encoding !== null || encoding !== null && encoding.toLowerCase() !== 'chunked')
      return json(res, 400, { error: 'Invalid request.' });
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY))
      return json(res, 413, { error: 'Request is too large.' });
    let body;
    try { body = await readJson(req); }
    catch (error) { return json(res, error.message === 'large' ? 413 : error.message === 'timeout' ? 408 : 400,
      { error: 'Could not read request.' }); }
    if (portal !== p || !p.token) return json(res, 410, { error: 'Phone camera link closed.' });
    if (current && expired(current)) endSession();
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || typeof body.session_id !== 'string'
        || typeof body.client_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.client_id))
      return json(res, 400, { error: 'Invalid phone session.' });
    const session = current;
    if (!session || body.session_id !== session.id)
      return json(res, 409, { error: 'Phone camera session changed.' });
    if (req.url === '/stop') {
      if (Object.keys(body).length !== 2) return json(res, 400, { error: 'Invalid request.' });
      // A paired phone may cancel while permission or its answer is still pending.
      // Once claimed, only that phone can end the session.
      if (session.clientId && session.clientId !== body.client_id) return json(res, 409, { error: 'Phone session is already claimed.' });
      res.once('finish', () => endSession(session));
      return json(res, 200, { stopped: true });
    }
    if (Object.keys(body).length !== 3 || !validSdp(body.answer, 'answer'))
      return json(res, 400, { error: 'A video-only answer is required.' });
    if (session.clientId) {
      if (session.clientId === body.client_id && session.answer.sdp === body.answer.sdp)
        return json(res, 200, { accepted: true, session_id: session.id });
      return json(res, 409, { error: 'Phone session is already claimed.' });
    }
    session.clientId = body.client_id;
    session.answer = { type: 'answer', sdp: body.answer.sdp };
    session.state = 'answered';
    session.lastPhone = now();
    return json(res, 200, { accepted: true, session_id: session.id });
  }

  function createPortal() {
    const p = { token: randomBytes(32).toString('base64url'), origin: null,
      tunnel: null, server: null, sockets: new Set(), controller: new AbortController(),
      cancelListen: null, timer: null, requests: [], ready: null };
    const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
      void handle(p, req, res).catch(() => json(res, 503, { error: 'Phone camera unavailable.' }));
    });
    p.server = server;
    server.maxConnections = 8;
    server.maxHeadersCount = 20;
    server.headersTimeout = 5_000;
    server.requestTimeout = READ_MS;
    server.keepAliveTimeout = 1_000;
    server.on('error', () => {
      if (portal === p) void closePortal(p, 'error', 'Phone camera listener closed.');
    });
    server.on('connection', socket => {
      p.sockets.add(socket);
      socket.setTimeout(READ_MS, () => socket.destroy());
      socket.on('close', () => p.sockets.delete(socket));
    });
    portal = p;
    p.ready = (async () => {
      try {
        const port = await new Promise((resolve, reject) => {
          let settled = false;
          const finish = (error, value) => {
            if (settled) return;
            settled = true;
            p.cancelListen = null;
            server.off('error', onError);
            if (error) reject(error);
            else resolve(value);
          };
          const onError = () => finish(new Error('Phone camera listener could not open.'));
          p.cancelListen = () => finish(new Error('Phone camera connection was cancelled.'));
          server.once('error', onError);
          server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address) finish(new Error('Phone camera listener could not open.'));
            else finish(null, address.port);
          });
        });
        if (portal !== p) throw new Error('Phone camera connection was cancelled.');
        const tunnel = await tunnelFactory(port, { signal: p.controller.signal });
        if (!tunnel || typeof tunnel.stop !== 'function' || !trustedTunnelUrl(tunnel.url)) {
          if (typeof tunnel?.stop === 'function')
            await Promise.resolve().then(() => tunnel.stop()).catch(() => undefined);
          throw new Error('The phone camera tunnel returned an untrusted URL.');
        }
        if (portal !== p) {
          await Promise.resolve().then(() => tunnel.stop()).catch(() => undefined);
          throw new Error('Phone camera connection was cancelled.');
        }
        p.tunnel = tunnel;
        p.origin = trustedTunnelUrl(tunnel.url);
        tunnel.onExit?.(() => { void closePortal(p, 'error', 'The phone camera tunnel closed.'); });
        if (portal !== p) throw new Error('The phone camera tunnel closed before it was ready.');
        p.timer = setInterval(() => { if (portal === p && current && expired(current)) endSession(); }, 1_000);
        p.timer.unref?.();
        last = { state: 'idle', error: null };
      } catch (error) {
        const message = /cancelled/i.test(error?.message) ? 'Phone camera connection was cancelled.'
          : /cloudflared/i.test(error?.message) ? 'Could not start cloudflared. Check the installed tunnel tool.'
            : /untrusted URL/i.test(error?.message) ? 'The phone camera tunnel returned an untrusted URL.'
              : /tunnel.*(time|closed)/i.test(error?.message) ? 'The phone camera tunnel did not start. Try again.'
                : 'Could not open the phone camera connection.';
        if (portal === p) await closePortal(p, 'error', message);
        throw new Error(message);
      }
    })();
    return p;
  }

  async function start({ offer } = {}) {
    if (!validSdp(offer, 'offer')) throw new TypeError('A video-only WebRTC offer is required.');
    const turn = ++serial;
    const p = portal || createPortal();
    await p.ready;
    if (portal !== p || turn !== serial) throw new Error('Phone camera connection was cancelled.');
    endSession();
    const time = now();
    current = { id: randomUUID(), offer: { type: 'offer', sdp: offer.sdp },
      answer: null, clientId: null, state: 'waiting', startedAt: time,
      lastDesktop: time, lastPhone: time };
    return snapshot();
  }

  async function open() {
    const p = portal || createPortal();
    await p.ready;
    if (portal !== p) throw new Error('Phone camera connection was cancelled.');
    return snapshot();
  }

  async function stop({ session_id: sessionId } = {}) {
    if (sessionId && current?.id !== sessionId) return snapshot(sessionId);
    serial++;
    endSession();
    if (portal && !portal.origin) await closePortal(portal);
    return snapshot();
  }

  async function shutdown() {
    serial++;
    if (portal) await closePortal(portal);
    return snapshot();
  }

  return { open, start, status, stop, shutdown };
}

module.exports = { createPhoneLiveBridge };
