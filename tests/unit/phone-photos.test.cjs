const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const vm = require('node:vm');
const { createPhonePhotoBridge } = require('../../apps/desktop/src/main/phone-photos.cjs');

const ADDRESS = '192.168.42.7';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6s2AAAAAASUVORK5CYII=', 'base64');
const photo = (overrides = {}) => ({ mime_type: 'image/png', image_base64: PNG.toString('base64'), question: 'Where is this part?', ...overrides });
const inventory = () => ({
  wifi: [{ family: 'IPv4', address: ADDRESS, internal: false },
    { family: 'IPv4', address: '8.8.8.8', internal: false }],
  loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  virtual: [{ family: 'IPv4', address: '10.0.0.12', internal: false },
    { family: 'IPv4', address: '172.31.2.4', internal: false }],
});

function fixture(onPhoto, options = {}) {
  let remote = '192.168.42.23';
  const bridge = createPhonePhotoBridge({ onPhoto, networkInterfaces: inventory,
    ...options, testAdapter: {
      listen: server => new Promise((accept, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          accept(server.address().port);
        });
      }),
      remoteAddress: () => remote,
      localAddress: () => ADDRESS,
    } });
  return { bridge, setRemote: value => { remote = value; } };
}

function link(status) {
  const url = new URL(status.url);
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  return { port: Number(url.port), token, origin: url.origin };
}

function call(status, { method = 'GET', path = '/', body, headers = {} } = {}) {
  const { port, token, origin } = link(status);
  const bytes = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((accept, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers: {
      Host: `${ADDRESS}:${port}`, ...(method === 'POST' ? {
        Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      } : {}), ...headers,
      ...(bytes && !Object.keys(headers).some(key => key.toLowerCase() === 'content-length')
        ? { 'Content-Length': bytes.length } : {}),
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => accept({ status: res.statusCode, headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (bytes) req.write(bytes);
    req.end();
  });
}

test('explicit private interface inventory and one-time static pairing page', async t => {
  const { bridge, setRemote } = fixture(() => 'receipt_1');
  t.after(() => bridge.stop());
  assert.deepEqual(bridge.interfaces(), [
    { name: 'wifi', address: ADDRESS }, { name: 'virtual', address: '10.0.0.12' },
    { name: 'virtual', address: '172.31.2.4' },
  ]);
  await assert.rejects(bridge.start({ address: '0.0.0.0' }), /private IPv4/);
  await assert.rejects(bridge.start({ address: '127.0.0.1' }), /private IPv4/);
  await assert.rejects(bridge.start({ address: '8.8.8.8' }), /private IPv4/);
  assert.equal(bridge.status().active, false);
  const status = await bridge.start({ address: ADDRESS });
  assert.equal(status.active, true);
  assert.equal(status.address, ADDRESS);
  assert.equal(status.received_count, 0);
  assert.equal(link(status).token.length > 40, true);
  const page = await call(status);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.match(page.headers['content-security-policy'], /img-src data: blob:/);
  assert.match(page.text, /capture="environment"/);
  assert.match(page.text, /Review and press Ask on your laptop/);
  const inlineScript = page.text.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(inlineScript);
  assert.doesNotThrow(() => new vm.Script(inlineScript));
  assert.equal(page.text.includes(link(status).token), false);
  assert.equal((await call(status, { method: 'GET', path: '/control' })).status, 404);
  assert.equal((await call(status, { method: 'PUT', path: '/photo' })).status, 404);
  setRemote('8.8.8.8');
  assert.equal((await call(status)).status, 403);
});

test('valid upload requires exact host, origin, bearer and bounded image', async t => {
  const received = [];
  const { bridge } = fixture(payload => { received.push(payload); return 'opaque_42'; });
  t.after(() => bridge.stop());
  const status = await bridge.start({ address: ADDRESS });
  const okay = await call(status, { method: 'POST', path: '/photo', body: photo() });
  assert.equal(okay.status, 200);
  assert.deepEqual(JSON.parse(okay.text), { received: true, receipt: 'opaque_42' });
  assert.equal(received.length, 1);
  assert.equal(received[0].bytes.equals(PNG), true);
  assert.equal(received[0].mime_type, 'image/png');
  assert.equal(received[0].question, 'Where is this part?');
  assert.equal(bridge.status().received_count, 1);
  assert.equal((await call(status, { method: 'POST', path: '/photo', body: photo(),
    headers: { Authorization: 'Bearer incorrect' } })).status, 403);
  assert.equal((await call(status, { method: 'POST', path: '/photo', body: photo(),
    headers: { Origin: 'http://elsewhere.invalid' } })).status, 403);
  assert.equal((await call(status, { method: 'POST', path: '/photo', body: photo(),
    headers: { Origin: '' } })).status, 403);
  assert.equal((await call(status, { method: 'POST', path: '/photo', body: photo(),
    headers: { Host: '192.168.42.8:' + link(status).port } })).status, 403);
  assert.equal((await call(status, { method: 'POST', path: '/photo', body: photo(),
    headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal(received.length, 1);
});

test('declared oversized body is rejected before photo processing', async t => {
  let callbacks = 0;
  const { bridge } = fixture(() => { callbacks++; return 'receipt'; });
  t.after(() => bridge.stop());
  const status = await bridge.start({ address: ADDRESS });
  const response = await call(status, { method: 'POST', path: '/photo', body: '{}',
    headers: { 'Content-Length': '3000001' } });
  assert.equal(response.status, 413);
  assert.equal(callbacks, 0);
});

test('bad MIME, base64, pixel bounds, question and body limits never reach callback', async t => {
  let calls = 0;
  const { bridge } = fixture(() => { calls++; return 'okay'; });
  t.after(() => bridge.stop());
  const status = await bridge.start({ address: ADDRESS });
  for (const value of [photo({ mime_type: 'image/jpeg' }), photo({ image_base64: '????' }),
    photo({ question: 'x'.repeat(4001) }), photo({ extra: 'not accepted' }),
    photo({ image_base64: Buffer.alloc(2_000_001).toString('base64') })]) {
    assert.equal((await call(status, { method: 'POST', path: '/photo', body: value })).status, 400);
  }
  const large = Buffer.from(PNG);
  large.writeUInt32BE(4097, 16);
  assert.equal((await call(status, { method: 'POST', path: '/photo', body: photo({ image_base64: large.toString('base64') }) })).status, 400);
  assert.equal((await call(status, { method: 'POST', path: '/photo', body: photo() })).status, 429);
  assert.equal(calls, 0);
});

test('upload concurrency, rate and callback failures are bounded with generic errors', async t => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { bridge } = fixture(() => { entered(); return new Promise(resolve => { release = resolve; }); });
  t.after(() => bridge.stop());
  const status = await bridge.start({ address: ADDRESS });
  const first = call(status, { method: 'POST', path: '/photo', body: photo() });
  await started;
  assert.equal((await call(status, { method: 'POST', path: '/photo', body: photo() })).status, 429);
  release('receipt_1');
  assert.equal((await first).status, 200);
  await bridge.stop();
  const failed = fixture(() => { throw new Error('internal secret path'); });
  t.after(() => failed.bridge.stop());
  const failureStatus = await failed.bridge.start({ address: ADDRESS });
  const response = await call(failureStatus, { method: 'POST', path: '/photo', body: photo() });
  assert.equal(response.status, 503);
  assert.equal(response.text.includes('internal secret'), false);
});

test('stop and expiry invalidate token and pending callback response', async t => {
  let clock = Date.now();
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { bridge } = fixture(() => { entered(); return new Promise(resolve => { release = resolve; }); }, { now: () => clock });
  t.after(() => bridge.stop());
  const status = await bridge.start({ address: ADDRESS });
  const request = call(status, { method: 'POST', path: '/photo', body: photo() });
  await started;
  await bridge.stop();
  release('late_receipt');
  await assert.rejects(request);
  assert.equal(bridge.status().active, false);
  const restarted = await bridge.start({ address: ADDRESS });
  assert.notEqual(link(restarted).token, link(status).token);
  assert.equal((await call(restarted, { method: 'POST', path: '/photo', body: photo(),
    headers: { Authorization: `Bearer ${link(status).token}` } })).status, 403);
  clock += 15 * 60_000 + 1;
  assert.equal(bridge.status().active, false);
});

test('expiry during callback closes the upload without a late success', async t => {
  let clock = Date.now();
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { bridge } = fixture(() => { entered(); return new Promise(resolve => { release = resolve; }); }, { now: () => clock });
  t.after(() => bridge.stop());
  const status = await bridge.start({ address: ADDRESS });
  const request = call(status, { method: 'POST', path: '/photo', body: photo() });
  await started;
  clock += 15 * 60_000 + 1;
  assert.equal(bridge.status().active, false);
  release('late_receipt');
  await assert.rejects(request);
  assert.equal(bridge.status().received_count, 0);
});

test('a stalled partial upload is closed without reaching the callback', async t => {
  let calls = 0;
  const { bridge } = fixture(() => { calls++; return 'receipt'; });
  t.after(() => bridge.stop());
  const status = await bridge.start({ address: ADDRESS });
  const { port, token, origin } = link(status);
  const response = await new Promise((accept, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let text = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Slow upload was not closed.')); }, 13_000);
    socket.on('connect', () => socket.write(`POST /photo HTTP/1.1\r\nHost: ${ADDRESS}:${port}\r\nOrigin: ${origin}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`));
    socket.on('data', chunk => { text += chunk.toString('utf8'); });
    socket.on('end', () => { clearTimeout(timer); accept(text); });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
  });
  assert.match(response, /408 Request Timeout/);
  assert.equal(calls, 0);
});
