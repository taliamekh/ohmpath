const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { existsSync } = require('node:fs');
const { dirname } = require('node:path');
const { createPhoneLiveBridge } = require('../../apps/desktop/src/main/phone-live.cjs');
const { createPhoneLiveTunnel, trustedTunnelUrl } = require('../../apps/desktop/src/main/phone-live-tunnel.cjs');

const offer = { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' };
const answer = { type: 'answer', sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' };
const origin = 'https://camera.trycloudflare.com';

function fixture(now = Date.now) {
  let port;
  let stopped = 0;
  const bridge = createPhoneLiveBridge({ now, pageFactory: nonce => `<script nonce="${nonce}"></script>`,
    tunnelFactory: async localPort => {
      port = localPort;
      return { url: origin, stop: async () => { stopped++; } };
    } });
  return { bridge, port: () => port, stopped: () => stopped };
}

function request(port, path, { method = 'GET', token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path, method,
      headers: { Host: 'camera.trycloudflare.com', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { Origin: origin, 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        resolve({ code: res.statusCode, data, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('phone cancellation wins against an answer still in flight', async () => {
  const f = fixture();
  try {
    const started = await f.bridge.start({ offer });
    const token = new URL(started.url).hash.slice('#token='.length);
    const response = await request(f.port(), '/stop', { method: 'POST', token,
      body: { client_id: randomUUID() } });
    assert.equal(response.code, 200);
    assert.equal(f.bridge.status(started.session_id).active, false);
    assert.equal(f.stopped(), 1);
  } finally { await f.bridge.shutdown(); }
});

test('authenticated video-only signaling and one idempotent answer claim', async () => {
  const f = fixture();
  try {
    const started = await f.bridge.start({ offer });
    const token = new URL(started.url).hash.slice('#token='.length);
    const page = await request(f.port(), '/');
    assert.equal(page.code, 200);
    assert.match(page.headers['content-security-policy'], /nonce-/);
    assert.equal(page.headers['permissions-policy'], 'camera=(self), microphone=(), geolocation=()');
    assert.equal(await request(f.port(), '/session').then(r => r.code), 403);
    assert.equal(await request(f.port(), '/unknown', { token }).then(r => r.code), 404);
    assert.equal(await request(f.port(), '/session', { token,
      headers: { Host: 'evil.trycloudflare.com' } }).then(r => r.code), 403);
    assert.equal(await request(f.port(), '/session', { token,
      headers: { Origin: 'https://evil.trycloudflare.com' } }).then(r => r.code), 403);
    const session = await request(f.port(), '/session', { token });
    assert.equal(session.code, 200);
    assert.deepEqual(session.data.offer, offer);
    const client_id = randomUUID();
    const claimed = await request(f.port(), '/answer', { method: 'POST', token,
      body: { client_id, answer } });
    assert.equal(claimed.code, 200);
    assert.deepEqual(f.bridge.status(started.session_id).answer, answer);
    assert.equal((await request(f.port(), '/answer', { method: 'POST', token,
      body: { client_id, answer } })).code, 200);
    assert.equal((await request(f.port(), '/answer', { method: 'POST', token,
      body: { client_id: randomUUID(), answer } })).code, 409);
    assert.equal((await request(f.port(), '/stop', { method: 'POST', token,
      body: { client_id: randomUUID() } })).code, 409);
    assert.equal((await request(f.port(), '/session', { token })).data.state, 'answered');
  } finally { await f.bridge.shutdown(); }
  assert.equal(f.stopped(), 1);
});

test('rejects audio, oversized SDP, wrong content type, and stale stop', async () => {
  const f = fixture();
  assert.rejects(f.bridge.start({ offer: { ...offer, sdp: offer.sdp + 'm=audio 9 RTP/AVP 0\r\n' } }));
  try {
    const one = await f.bridge.start({ offer });
    const two = await f.bridge.start({ offer });
    assert.notEqual(one.session_id, two.session_id);
    assert.equal((await f.bridge.stop({ session_id: one.session_id })).active, false);
    assert.equal(f.bridge.status(two.session_id).active, true);
    const token = new URL(two.url).hash.slice('#token='.length);
    assert.equal((await request(f.port(), '/answer', { method: 'POST', token,
      body: { client_id: randomUUID(), answer: { ...answer,
        sdp: answer.sdp + 'm=audio 9 RTP/AVP 0\r\n' } } })).code, 400);
    assert.equal((await request(f.port(), '/answer', { method: 'POST', token,
      body: { client_id: randomUUID(), answer: { ...answer, sdp: 'x'.repeat(65_000) } } })).code, 400);
    assert.equal((await request(f.port(), '/answer', { method: 'POST', token,
      body: { client_id: randomUUID(), answer }, headers: { 'Content-Type': 'text/plain' } })).code, 415);
  } finally { await f.bridge.shutdown(); }
  assert.equal(f.stopped(), 2);
});

test('waiting and answered sessions expire without heartbeat', async () => {
  let clock = 1_000;
  const f = fixture(() => clock);
  let started = await f.bridge.start({ offer });
  clock += 36_000;
  assert.equal(f.bridge.status(started.session_id).state, 'stopped');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.stopped(), 1);
  started = await f.bridge.start({ offer });
  let token = new URL(started.url).hash.slice('#token='.length);
  const client_id = randomUUID();
  assert.equal((await request(f.port(), '/answer', { method: 'POST', token,
    body: { client_id, answer } })).code, 200);
  clock += 16_000;
  assert.equal(f.bridge.status(started.session_id).state, 'stopped');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.stopped(), 2);
  await f.bridge.shutdown();
});

test('cancelled tunnel startup closes listener and late tunnel', async () => {
  let release;
  let stopped = 0;
  const bridge = createPhoneLiveBridge({ tunnelFactory: () => new Promise(resolve => {
    release = () => resolve({ url: origin, stop: async () => { stopped++; } });
  }) });
  const opening = bridge.start({ offer });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await bridge.shutdown();
  release();
  await assert.rejects(opening, /cancelled/);
  assert.equal(stopped, 1);
  assert.equal(bridge.status().active, false);
});

test('stop before the loopback listen callback cancels startup', async () => {
  const f = fixture();
  const opening = f.bridge.start({ offer });
  await f.bridge.stop();
  await assert.rejects(opening, /cancelled/);
  assert.equal(f.port(), undefined);
  assert.equal(f.bridge.status().active, false);
});

test('a newer start replaces an in-flight start without exposing the old tunnel', async () => {
  let releaseFirst;
  let calls = 0;
  let stopped = 0;
  const bridge = createPhoneLiveBridge({ tunnelFactory: () => {
    calls++;
    if (calls === 1) return new Promise(resolve => {
      releaseFirst = () => resolve({ url: origin, stop: async () => { stopped++; } });
    });
    return { url: origin, stop: async () => { stopped++; } };
  } });
  const first = bridge.start({ offer });
  while (!releaseFirst) await new Promise(resolve => setImmediate(resolve));
  const second = await bridge.start({ offer });
  releaseFirst();
  await assert.rejects(first, /cancelled/);
  assert.equal(bridge.status(second.session_id).active, true);
  assert.equal(stopped, 1);
  await bridge.shutdown();
  assert.equal(stopped, 2);
});

test('a tunnel that exits before onExit registration cannot publish a session', async () => {
  let stopped = 0;
  const bridge = createPhoneLiveBridge({ tunnelFactory: async () => ({
    url: origin, stop: () => { stopped++; }, onExit: callback => callback(),
  }) });
  await assert.rejects(bridge.start({ offer }), /tunnel did not start/);
  assert.equal(bridge.status().active, false);
  assert.equal(bridge.status().state, 'error');
  assert.equal(stopped, 1);
});

test('request limits, exact origin, and phone stop close the bridge', async () => {
  const f = fixture();
  const started = await f.bridge.start({ offer });
  const token = new URL(started.url).hash.slice('#token='.length);
  try {
    assert.equal((await request(f.port(), '/answer', { method: 'POST', token,
      body: { client_id: randomUUID(), answer }, headers: { Origin: 'https://other.trycloudflare.com' } })).code, 403);
    assert.equal((await request(f.port(), '/answer', { method: 'POST', token,
      body: { client_id: randomUUID(), answer }, headers: { Authorization: 'Bearer wrong' } })).code, 403);
    assert.equal((await request(f.port(), '/answer', { method: 'POST', token,
      body: { client_id: randomUUID(), answer }, headers: { 'Content-Length': String(80 * 1024 + 1) } })).code, 413);
    const client_id = randomUUID();
    assert.equal((await request(f.port(), '/answer', { method: 'POST', token,
      body: { client_id, answer } })).code, 200);
    assert.equal((await request(f.port(), '/stop', { method: 'POST', token,
      body: { client_id } })).code, 200);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.bridge.status(started.session_id).active, false);
    assert.equal(f.stopped(), 1);
  } finally { await f.bridge.shutdown(); }
});

test('tunnel helper accepts only its HTTPS service and sanitizes a missing executable', async () => {
  assert.equal(trustedTunnelUrl('https://one.trycloudflare.com'), 'https://one.trycloudflare.com');
  assert.equal(trustedTunnelUrl('https://one.trycloudflare.com.evil.test'), null);
  assert.equal(trustedTunnelUrl('http://one.trycloudflare.com'), null);
  const tunnel = createPhoneLiveTunnel({ binaryPath: 'unavailable-cloudflared-test-binary.exe' });
  await assert.rejects(tunnel(12345), /Check the installed tunnel tool/);
});

test('tunnel helper uses isolated config and reports early child exit', async () => {
  let captured;
  const spawnProcess = (binary, args, options) => {
    captured = { binary, args, options };
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.emit('exit'); child.emit('close'); return true; };
    setImmediate(() => {
      child.stderr.emit('data', Buffer.from('https://camera.trycloudflare.com\n'));
      child.emit('exit');
      child.emit('close');
    });
    return child;
  };
  const factory = createPhoneLiveTunnel({ binaryPath: 'reviewed-cloudflared.exe', spawnProcess });
  const connection = await factory(12345);
  let exits = 0;
  connection.onExit(() => { exits++; });
  assert.equal(exits, 1);
  assert.equal(captured.args[captured.args.indexOf('--url') + 1], 'http://127.0.0.1:12345');
  const configPath = captured.args[captured.args.indexOf('--config') + 1];
  assert.equal(captured.options.env.HOME, dirname(configPath));
  assert.equal(captured.options.env.USERPROFILE, dirname(configPath));
  assert.equal(captured.options.env.TUNNEL_TOKEN, undefined);
  await connection.stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(existsSync(dirname(configPath)), false);
});
