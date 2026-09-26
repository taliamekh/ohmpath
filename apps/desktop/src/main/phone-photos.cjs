const http = require('node:http');
const os = require('node:os');
const net = require('node:net');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { uploadHeader } = require('./photo-upload.cjs');
const { phonePhotoPage } = require('./phone-photo-page.cjs');

const MAX_BODY_BYTES = 3_000_000;
const MAX_IMAGE_BYTES = 2_000_000;
const MAX_REQUESTS_PER_MINUTE = 60;
const MAX_UPLOADS_PER_MINUTE = 6;
const EXPIRY_MS = 15 * 60_000;
const REQUEST_MS = 10_000;

function privateIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const parts = address.split('.').map(Number);
  return parts[0] === 10 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31
    || parts[0] === 192 && parts[1] === 168;
}

function header(req, name) {
  let value = null;
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === name) {
      value = req.rawHeaders[index + 1];
      count += 1;
    }
  }
  return count === 1 ? value : null;
}

function headerCount(req, name) {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2)
    if (req.rawHeaders[index].toLowerCase() === name) count += 1;
  return count;
}

function send(res, status, value, type = 'application/json; charset=utf-8') {
  if (res.destroyed || res.writableEnded) return;
  const body = type.startsWith('application/json') ? JSON.stringify(value) : value;
  res.writeHead(status, {
    'Content-Type': type, 'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Connection': 'close',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const timer = setTimeout(() => finish(new Error('timeout')), REQUEST_MS);
    function finish(error, bytes) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      if (error) { req.pause(); reject(error); }
      else resolve(bytes);
    }
    function onData(chunk) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return finish(new Error('large'));
      chunks.push(chunk);
    }
    function onEnd() { finish(null, Buffer.concat(chunks, size)); }
    function onError() { finish(new Error('aborted')); }
    function onAborted() { finish(new Error('aborted')); }
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
}

function parsePhoto(bytes) {
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('invalid'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).some(key => !['mime_type', 'image_base64', 'question'].includes(key)))
    throw new Error('invalid');
  if (!['image/png', 'image/jpeg'].includes(data.mime_type)
      || typeof data.image_base64 !== 'string'
      || data.image_base64.length < 16 || data.image_base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
      || data.image_base64.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.image_base64)
      || data.question !== undefined && (typeof data.question !== 'string' || data.question.length > 4000))
    throw new Error('invalid');
  const image = Buffer.from(data.image_base64, 'base64');
  if (image.length < 16 || image.length > MAX_IMAGE_BYTES || image.toString('base64') !== data.image_base64)
    throw new Error('invalid');
  let shape;
  try { shape = uploadHeader(image); }
  catch { throw new Error('invalid'); }
  if (shape.format !== data.mime_type.slice(6) || shape.width > 4096 || shape.height > 4096
      || shape.width * shape.height > 8_000_000) throw new Error('invalid');
  return { bytes: image, mime_type: data.mime_type, question: data.question || '' };
}

function createPhonePhotoBridge({ onPhoto, networkInterfaces = os.networkInterfaces, now = Date.now, testAdapter } = {}) {
  if (typeof onPhoto !== 'function' || typeof networkInterfaces !== 'function' || typeof now !== 'function')
    throw new TypeError('A photo callback and interface inventory are required.');
  let active = null;
  let pendingStart = null;
  let generation = 0;

  function interfaces() {
    const inventory = networkInterfaces();
    const found = [];
    for (const [name, entries] of Object.entries(inventory || {})) {
      for (const entry of entries || []) {
        if ((entry.family === 'IPv4' || entry.family === 4) && entry.internal === false
            && privateIPv4(entry.address) && !found.some(item => item.address === entry.address))
          found.push({ name, address: entry.address });
      }
    }
    return found;
  }

  function expired(state) {
    return now() >= state.expiresAt;
  }

  function status() {
    if (active && expired(active)) {
      active.token = null;
      void stop().catch(() => undefined);
    }
    if (!active || !active.token) return { active: false, url: null, expires_at: null,
      address: null, received_count: 0 };
    return { active: true, url: `http://${active.address}:${active.port}/#token=${active.token}`,
      expires_at: new Date(active.expiresAt).toISOString(), address: active.address,
      received_count: active.receivedCount };
  }

  async function handle(req, res) {
    const state = active;
    if (!state || !state.token || expired(state)) {
      if (state && expired(state)) { state.token = null; void stop().catch(() => undefined); }
      return send(res, 410, { error: 'Transfer closed.' });
    }
    const remote = testAdapter?.remoteAddress?.(req) ?? req.socket.remoteAddress;
    const local = testAdapter?.localAddress?.(req) ?? req.socket.localAddress;
    const host = `${state.address}:${state.port}`;
    const origin = `http://${host}`;
    if (!privateIPv4(remote) || local !== state.address || header(req, 'host') !== host)
      return send(res, 403, { error: 'Transfer unavailable.' });
    const requestOrigin = header(req, 'origin');
    if (requestOrigin && requestOrigin !== origin) return send(res, 403, { error: 'Transfer unavailable.' });
    const current = now();
    state.requests = state.requests.filter(time => current - time < 60_000 && current >= time);
    if (state.requests.length >= MAX_REQUESTS_PER_MINUTE) return send(res, 429, { error: 'Try again later.' });
    state.requests.push(current);
    if (req.method === 'GET' && req.url === '/') {
      const nonce = randomBytes(18).toString('base64url');
      const page = phonePhotoPage(nonce);
      res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data: blob:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`);
      return send(res, 200, page, 'text/html; charset=utf-8');
    }
    if (req.method !== 'POST' || req.url !== '/photo') return send(res, 404, { error: 'Not found.' });
    const authorization = header(req, 'authorization');
    const candidate = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice(7) : '';
    const expected = Buffer.from(state.token);
    const offered = Buffer.from(candidate);
    if (offered.length !== expected.length || !timingSafeEqual(offered, expected)
        || requestOrigin !== origin) return send(res, 403, { error: 'Transfer unavailable.' });
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(header(req, 'content-type') || ''))
      return send(res, 415, { error: 'Unsupported upload.' });
    const contentLength = header(req, 'content-length');
    const transferEncoding = header(req, 'transfer-encoding');
    if (headerCount(req, 'content-length') > 1 || headerCount(req, 'transfer-encoding') > 1
        || contentLength !== null && transferEncoding !== null
        || transferEncoding !== null && transferEncoding.toLowerCase() !== 'chunked')
      return send(res, 400, { error: 'Invalid upload.' });
    if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES))
      return send(res, 413, { error: 'Photo is too large.' });
    state.uploads = state.uploads.filter(time => current - time < 60_000 && current >= time);
    if (state.uploads.length >= MAX_UPLOADS_PER_MINUTE || state.uploadBusy)
      return send(res, 429, { error: 'Try again later.' });
    state.uploads.push(current);
    state.uploadBusy = true;
    const controller = new AbortController();
    state.controllers.add(controller);
    try {
      let body;
      try { body = await readBody(req); }
      catch (error) {
        return send(res, error.message === 'large' ? 413 : 408, { error: 'Upload could not be read.' });
      }
      if (active !== state || !state.token || expired(state)) return send(res, 410, { error: 'Transfer closed.' });
      let photo;
      try { photo = parsePhoto(body); }
      catch { return send(res, 400, { error: 'Choose a valid PNG or JPEG photo.' }); }
      let timeout;
      let receipt;
      try {
        receipt = await Promise.race([
          Promise.resolve().then(() => {
            if (active !== state || !state.token || expired(state) || controller.signal.aborted)
              throw new Error('closed');
            return onPhoto({ ...photo, signal: controller.signal });
          }),
          new Promise((_, reject) => { timeout = setTimeout(() => {
            controller.abort(); reject(new Error('timeout'));
          }, REQUEST_MS); }),
        ]);
      } catch { return send(res, 503, { error: 'The laptop could not receive this photo.' }); }
      finally { clearTimeout(timeout); }
      if (active !== state || !state.token || expired(state) || controller.signal.aborted)
        return send(res, 410, { error: 'Transfer closed.' });
      const opaque = typeof receipt === 'string' ? receipt : receipt?.receipt;
      if (typeof opaque !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(opaque))
        return send(res, 503, { error: 'The laptop could not receive this photo.' });
      state.receivedCount += 1;
      return send(res, 200, { received: true, receipt: opaque });
    } finally {
      controller.abort();
      state.controllers.delete(controller);
      state.uploadBusy = false;
    }
  }

  async function start({ address } = {}) {
    if (active || pendingStart) throw new Error('Phone photo transfer is already open.');
    if (typeof address !== 'string' || !interfaces().some(item => item.address === address))
      throw new Error('Choose an available private IPv4 network address.');
    const selectedGeneration = ++generation;
    const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
      void handle(req, res).catch(() => send(res, 500, { error: 'Transfer unavailable.' }));
    });
    const sockets = new Set();
    server.on('connection', socket => {
      sockets.add(socket);
      socket.setTimeout(REQUEST_MS, () => socket.destroy());
      const absolute = setTimeout(() => socket.destroy(), 25_000);
      socket.on('close', () => { clearTimeout(absolute); sockets.delete(socket); });
    });
    server.maxConnections = 8;
    server.maxHeadersCount = 20;
    server.headersTimeout = 5000;
    server.requestTimeout = REQUEST_MS;
    server.keepAliveTimeout = 1000;
    const begin = (async () => {
      try {
        const port = await (testAdapter?.listen
          ? testAdapter.listen(server, address)
          : new Promise((resolvePort, reject) => {
            server.once('error', reject);
            server.listen(0, address, () => {
              server.off('error', reject);
              resolvePort(server.address().port);
            });
          }));
        if (!Number.isInteger(port) || port < 1 || port > 65535 || generation !== selectedGeneration) {
          if (server.listening) await new Promise(done => server.close(done));
          throw new Error('Phone photo transfer could not open.');
        }
        const token = randomBytes(32).toString('base64url');
        const state = { server, sockets, address, port, token, expiresAt: now() + EXPIRY_MS,
          receivedCount: 0, requests: [], uploads: [], uploadBusy: false, controllers: new Set(), timer: null };
        active = state;
        state.timer = setTimeout(() => { state.token = null; void stop().catch(() => undefined); }, EXPIRY_MS);
        return status();
      } catch (error) {
        if (server.listening) await new Promise(done => server.close(done));
        throw error;
      }
    })();
    pendingStart = begin;
    try { return await begin; }
    finally { if (pendingStart === begin) pendingStart = null; }
  }

  async function stop() {
    generation += 1;
    if (pendingStart) await pendingStart.catch(() => undefined);
    const state = active;
    if (!state) return status();
    active = null;
    state.token = null;
    clearTimeout(state.timer);
    state.controllers.forEach(controller => controller.abort());
    state.sockets.forEach(socket => socket.destroy());
    await new Promise(resolveDone => state.server.close(() => resolveDone()));
    return status();
  }

  return { interfaces, start, status, stop };
}

module.exports = { createPhonePhotoBridge };
