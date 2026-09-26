'use strict';

const http = require('node:http');
const { randomBytes } = require('node:crypto');

const MAX_BODY_BYTES = 1024;
const DEFAULT_IDLE_MS = 15 * 60 * 1000;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function page({ path, status, notice = '', error = '' }) {
  const connected = status?.connected === true;
  const voices = Array.isArray(status?.voices) ? status.voices : [];
  const selected = status?.selected_voice_id;
  const voiceOptions = voices.map(voice => {
    const id = escapeHtml(voice.voice_id);
    return `<option value="${id}"${voice.voice_id === selected ? ' selected' : ''}>${escapeHtml(voice.name || voice.voice_id)}</option>`;
  }).join('');
  const tier = escapeHtml(status?.subscription?.tier || 'Unknown');
  const overage = escapeHtml(status?.subscription?.overage_status || 'unknown');
  const content = connected ? `
    <p><strong>Connected.</strong> Plan: ${tier}. Overage: ${overage}. Speech generation is disabled and has not been tested.</p>
    <form method="post" action="${path}"><input type="hidden" name="action" value="selectVoice">
      <label for="voice">Voice</label><select id="voice" name="voiceId" required><option value="" disabled${selected ? '' : ' selected'}>Choose a voice · no preview</option>${voiceOptions}</select>
      <button type="submit"${voices.length ? '' : ' disabled'}>Save voice</button>
    </form>
    <form method="post" action="${path}"><input type="hidden" name="action" value="refresh"><button type="submit">Refresh account details</button></form>
    <form method="post" action="${path}"><input type="hidden" name="action" value="disconnect"><button type="submit">Disconnect</button></form>` : `
    <p>Enter an ElevenLabs API key to link this computer. Ohm Path will check account, voice, and model details only. No speech will be generated or previewed.</p>
    <p>The key is encrypted with Windows protection and stored on this computer.</p>
    <form method="post" action="${path}" autocomplete="off">
      <input type="hidden" name="action" value="connect">
      <label for="apiKey">ElevenLabs API key</label>
      <input id="apiKey" name="apiKey" type="password" autocomplete="off" spellcheck="false" required minlength="16" maxlength="256">
      <button type="submit">Connect account</button>
    </form>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link ElevenLabs to Ohm Path</title></head><body>
    <main><h1>Link ElevenLabs to Ohm Path</h1>${notice ? `<p role="status">${escapeHtml(notice)}</p>` : ''}${error ? `<p role="alert">${escapeHtml(error)}</p>` : ''}${content}
    <form method="post" action="${path}"><input type="hidden" name="action" value="finish"><button type="submit">Finish and close this link</button></form>
    <p>This temporary page is available only on this computer and expires after 15 minutes of inactivity. Close the tab when finished.</p></main></body></html>`;
}

function send(response, statusCode, html, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'Pragma': 'no-cache',
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; connect-src 'none'; img-src 'none'; script-src 'none'; style-src 'none'",
    ...extraHeaders,
  });
  response.end(html);
}

function readForm(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('too_large'));
        request.resume();
      } else chunks.push(chunk);
    });
    request.on('end', () => {
      if (size > MAX_BODY_BYTES) return;
      try {
        const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const allowed = new Set(['action', 'apiKey', 'voiceId']);
        if ([...fields.keys()].some(key => !allowed.has(key) || fields.getAll(key).length !== 1)) throw new Error('invalid_form');
        resolve(fields);
      } catch { reject(new Error('invalid_form')); }
    });
    request.on('error', () => reject(new Error('invalid_form')));
    request.on('aborted', () => reject(new Error('invalid_form')));
  });
}

async function startElevenLabsLinkServer({ connection, idleMs = DEFAULT_IDLE_MS } = {}) {
  if (!connection || typeof connection.handle !== 'function') throw new TypeError('A connection is required.');
  if (!Number.isSafeInteger(idleMs) || idleMs < 100) throw new TypeError('Invalid idle timeout.');
  const path = `/${randomBytes(32).toString('hex')}`;
  let idleTimer;
  let closed = false;
  let port;
  let active = false;
  let flash = {};
  let resolveClosed;
  const closedPromise = new Promise(resolve => { resolveClosed = resolve; });
  const server = http.createServer(async (request, response) => {
    const host = `127.0.0.1:${port}`;
    const origin = `http://${host}`;
    const hosts = request.headersDistinct?.host;
    if (closed || request.url !== path || request.headers.host !== host || (hosts && hosts.length !== 1)) {
      send(response, 404, 'Not found');
      return;
    }
    resetIdle();
    if (request.method === 'GET') {
      const message = flash;
      flash = {};
      try { send(response, 200, page({ path, status: await connection.handle('status', {}), ...message })); }
      catch { send(response, 503, page({ path, error: 'Account status is unavailable.' })); }
      return;
    }
    if (request.method !== 'POST') { send(response, 405, 'Method not allowed', { Allow: 'GET, POST' }); return; }
    if (request.headers.origin !== origin) { send(response, 403, 'Forbidden'); return; }
    if (request.headers['content-type'] !== 'application/x-www-form-urlencoded') { send(response, 415, 'Unsupported form'); return; }
    const length = Number(request.headers['content-length']);
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) { send(response, 413, 'Form too large'); return; }
    let fields;
    try { fields = await readForm(request); }
    catch (error) { send(response, error.message === 'too_large' ? 413 : 400, 'Invalid form'); return; }
    const action = fields.get('action');
    if (active) { send(response, 409, 'Another request is in progress'); return; }
    if (action === 'finish' && fields.size === 1) {
      response.once('finish', close);
      send(response, 200, '<!doctype html><html><head><meta charset="utf-8"><title>Ohm Path</title></head><body><p>The temporary link is closed. You may close this tab.</p></body></html>');
      return;
    }
    const valid = (action === 'connect' && fields.size === 2 && fields.has('apiKey'))
      || (action === 'selectVoice' && fields.size === 2 && fields.has('voiceId'))
      || ((action === 'refresh' || action === 'disconnect') && fields.size === 1);
    if (!valid) { send(response, 400, 'Invalid form'); return; }
    active = true;
    try {
      const payload = action === 'connect' ? { apiKey: fields.get('apiKey') }
        : action === 'selectVoice' ? { voiceId: fields.get('voiceId') } : {};
      await connection.handle(action, payload);
      flash = { notice: action === 'connect' ? 'Account linked.' : 'Saved.' };
    } catch {
      flash = { error: 'That action could not be completed. Check the key or connection and try again.' };
    } finally {
      active = false;
      send(response, 303, '', { Location: path });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 1_000;
  server.on('clientError', (_error, socket) => { socket.destroy(); });

  function close() {
    if (closed) return closedPromise;
    closed = true;
    clearTimeout(idleTimer);
    server.close(() => resolveClosed());
    server.closeAllConnections();
    return closedPromise;
  }
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(close, idleMs);
    idleTimer.unref();
  }
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
  } catch { throw new Error('Local link could not start.'); }
  port = server.address().port;
  resetIdle();
  return { url: `http://127.0.0.1:${port}${path}`, close, closed: closedPromise };
}

module.exports = { startElevenLabsLinkServer };
