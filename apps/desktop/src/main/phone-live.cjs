const http = require('node:http');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { trustedTunnelUrl } = require('./phone-live-tunnel.cjs');

const MAX_BODY = 80 * 1024;
const MAX_SDP = 64 * 1024;
const READ_MS = 10_000;
const WAIT_MS = 10 * 60_000;
const LIVE_MS = 120 * 60_000;
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
  let current = null;
  let serial = 0;
  let last = { active: false, session_id: null, state: 'stopped', url: null,
    answer: null, error: null, expires_at: null };

  function snapshot(session) {
    return { active: Boolean(session.origin), session_id: session.id, state: session.state,
      url: session.origin ? `${session.origin}/#token=${session.token}` : null,
      answer: session.answer, error: null,
      expires_at: new Date(session.expiresAt).toISOString() };
  }

  function expired(session) {
    const time = now();
    return time >= session.expiresAt
      || time - session.startedAt > INITIAL_DESKTOP_MS && time - session.lastDesktop > DESKTOP_MS
      || session.state === 'answered' && time - session.lastPhone > PHONE_MS;
  }

  function close(session, state = 'stopped', error = null) {
    if (current !== session) return Promise.resolve();
    current = null;
    last = { active: false, session_id: session.id, state, url: null,
      answer: null, error, expires_at: null };
    session.token = null;
    session.offer = null;
    session.answer = null;
    session.clientId = null;
    clearInterval(session.timer);
    session.controller.abort();
    session.cancelListen?.();
    session.sockets.forEach(socket => socket.destroy());
    const serverClosed = new Promise(resolve => {
      try { session.server.close(() => resolve()); }
      catch { resolve(); }
    });
    let tunnelClosed = Promise.resolve();
    if (session.tunnel) {
      try { tunnelClosed = Promise.resolve(session.tunnel.stop()).catch(() => undefined); }
      catch { /* A failed stop cannot restore a closed listener or token. */ }
    }
    return Promise.all([serverClosed, tunnelClosed]).then(() => undefined);
  }

  function status(sessionId) {
    const session = current;
    if (!session) return sessionId && last.session_id !== sessionId
      ? { ...last, session_id: sessionId, state: 'stopped', error: null } : { ...last };
    if (sessionId && sessionId !== session.id) return { active: false, session_id: sessionId,
      state: 'stopped', url: null, answer: null, error: null, expires_at: null };
    if (expired(session)) { void close(session); return { ...last }; }
    session.lastDesktop = now();
    return snapshot(session);
  }

  async function handle(session, req, res) {
    if (current !== session || !session.token || expired(session)) {
      if (current === session) void close(session);
      return json(res, 410, { error: 'Phone camera session closed.' });
    }
    const host = new URL(session.origin).host;
    if (headerCount(req, 'host') !== 1 || oneHeader(req, 'host') !== host
        || headerCount(req, 'origin') > 1 || oneHeader(req, 'origin') && oneHeader(req, 'origin') !== session.origin
        || oneHeader(req, 'sec-fetch-site') === 'cross-site')
      return json(res, 403, { error: 'Phone camera session unavailable.' });
    const time = now();
    session.requests = session.requests.filter(t => time >= t && time - t < 10_000);
    if (session.requests.length >= 100) return json(res, 429, { error: 'Try again shortly.' });
    session.requests.push(time);
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
    const expected = Buffer.from(session.token);
    if (offered.length !== expected.length || !timingSafeEqual(offered, expected))
      return json(res, 403, { error: 'Phone camera session unavailable.' });
    if (req.method === 'GET') {
      session.lastPhone = time;
      return json(res, 200, { session_id: session.id, offer: session.offer,
        state: session.state, expires_at: new Date(session.expiresAt).toISOString() });
    }
    if (oneHeader(req, 'origin') !== session.origin)
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
    if (current !== session || expired(session)) {
      if (current === session) void close(session);
      return json(res, 410, { error: 'Phone camera session closed.' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || typeof body.client_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.client_id))
      return json(res, 400, { error: 'Invalid phone session.' });
    if (req.url === '/stop') {
      if (Object.keys(body).length !== 1) return json(res, 400, { error: 'Invalid request.' });
      // A paired phone may cancel while permission or its answer is still pending.
      // Once claimed, only that phone can end the session.
      if (session.clientId && session.clientId !== body.client_id) return json(res, 409, { error: 'Phone session is already claimed.' });
      res.once('finish', () => { void close(session); });
      return json(res, 200, { stopped: true });
    }
    if (Object.keys(body).length !== 2 || !validSdp(body.answer, 'answer'))
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
    session.expiresAt = Math.min(session.startedAt + LIVE_MS, session.expiresAt + LIVE_MS);
    return json(res, 200, { accepted: true, session_id: session.id });
  }

  async function start({ offer } = {}) {
    if (!validSdp(offer, 'offer')) throw new TypeError('A video-only WebRTC offer is required.');
    const turn = ++serial;
    if (current) await close(current);
    if (turn !== serial) throw new Error('Phone camera connection was cancelled.');
    const session = { id: randomUUID(), token: randomBytes(32).toString('base64url'),
      offer: { type: 'offer', sdp: offer.sdp }, answer: null, clientId: null,
      state: 'waiting', origin: null, tunnel: null, server: null, sockets: new Set(),
      controller: new AbortController(), timer: null, requests: [],
      startedAt: now(), lastDesktop: now(), lastPhone: now(), expiresAt: now() + WAIT_MS };
    const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
      void handle(session, req, res).catch(() => json(res, 503, { error: 'Phone camera unavailable.' }));
    });
    session.server = server;
    server.maxConnections = 8;
    server.maxHeadersCount = 20;
    server.headersTimeout = 5_000;
    server.requestTimeout = READ_MS;
    server.keepAliveTimeout = 1_000;
    server.on('error', () => {
      if (current === session) void close(session, 'error', 'Phone camera listener closed.');
    });
    server.on('connection', socket => {
      session.sockets.add(socket);
      socket.setTimeout(READ_MS, () => socket.destroy());
      socket.on('close', () => session.sockets.delete(socket));
    });
    current = session;
    try {
      const port = await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          session.cancelListen = null;
          server.off('error', onError);
          if (error) reject(error);
          else resolve(value);
        };
        const onError = () => finish(new Error('Phone camera listener could not open.'));
        session.cancelListen = () => finish(new Error('Phone camera connection was cancelled.'));
        server.once('error', onError);
        server.listen(0, '127.0.0.1', () => {
          finish(null, server.address().port);
        });
      });
      if (current !== session || turn !== serial) throw new Error('Phone camera connection was cancelled.');
      const tunnel = await tunnelFactory(port, { signal: session.controller.signal });
      if (!tunnel || typeof tunnel.stop !== 'function' || !trustedTunnelUrl(tunnel.url)) {
        if (typeof tunnel?.stop === 'function')
          await Promise.resolve().then(() => tunnel.stop()).catch(() => undefined);
        throw new Error('The phone camera tunnel returned an untrusted URL.');
      }
      if (current !== session || turn !== serial) {
        await Promise.resolve().then(() => tunnel.stop()).catch(() => undefined);
        throw new Error('Phone camera connection was cancelled.');
      }
      session.tunnel = tunnel;
      session.origin = trustedTunnelUrl(tunnel.url);
      tunnel.onExit?.(() => { void close(session, 'error', 'The phone camera tunnel closed.'); });
      if (current !== session) throw new Error('The phone camera tunnel closed before it was ready.');
      session.timer = setInterval(() => { if (current === session && expired(session)) void close(session); }, 1_000);
      session.timer.unref?.();
      return snapshot(session);
    } catch (error) {
      const message = /cancelled/i.test(error?.message) ? 'Phone camera connection was cancelled.'
        : /cloudflared/i.test(error?.message) ? 'Could not start cloudflared. Check the installed tunnel tool.'
          : /untrusted URL/i.test(error?.message) ? 'The phone camera tunnel returned an untrusted URL.'
            : /tunnel.*(time|closed)/i.test(error?.message) ? 'The phone camera tunnel did not start. Try again.'
              : 'Could not open the phone camera connection.';
      if (current === session) await close(session, 'error', message);
      throw new Error(message);
    }
  }

  async function stop({ session_id: sessionId } = {}) {
    if (!current || sessionId && sessionId !== current.id) return status(sessionId);
    serial++;
    await close(current);
    return status(sessionId);
  }

  async function shutdown() {
    serial++;
    if (current) await close(current);
    return { ...last };
  }

  return { start, status, stop, shutdown };
}

module.exports = { createPhoneLiveBridge };
