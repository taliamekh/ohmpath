const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PiVideoClient } = require('../../apps/desktop/src/main/pi-video.cjs');

const token = 'test-video-token-'.repeat(3);
const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
const health = { service: 'ohmpath-pi-video', mode: 'camera', physical_control: 'disabled' };
const frameHeader = '--ohmpath-video-frame\r\nContent-Type: image/jpeg\r\nContent-Length: 6\r\n\r\n';

async function waitFor(predicate, timeoutMs = 1500) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for Pi video state.');
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new PiVideoClient();
  try { await run(client, server.address().port); }
  finally {
    client.disconnect();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('Pi camera bridge authenticates, replaces frames and drops disconnected data', async () => {
  let requested = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + token);
    requested++;
    if (req.url === '/v1/health') {
      res.end(JSON.stringify(health));
    } else {
      res.writeHead(200, {'Content-Type':'multipart/x-mixed-replace; boundary=ohmpath-video-frame'});
      res.write('--ohmpath-video-frame\r\nContent-Type: image/jpeg\r\nContent-Length: 6\r\n\r\n');
      res.write(jpeg.subarray(0, 2));
      setTimeout(() => { res.write(jpeg.subarray(2)); res.write('\r\n'); }, 10);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new PiVideoClient();
  try {
    assert.equal((await client.connect(server.address().port, token)).connected, true);
    for (let n = 0; n < 100 && !client.latest(); n++) await new Promise(r => setTimeout(r, 10));
    assert.equal(client.latest().jpeg_base64, jpeg.toString('base64'));
    assert.deepEqual(client.status(), { connected: true, state: 'streaming', fresh_frame: true,
      source: 'Raspberry Pi camera via an existing local tunnel' });
    assert.equal(requested, 2);
    client.disconnect();
    assert.equal(client.latest(), null);
    assert.equal(client.status().state, 'disconnected');
  } finally {
    client.disconnect();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('Pi camera bridge refuses a different local service and invalid credentials', async () => {
  const client = new PiVideoClient();
  await assert.rejects(client.connect(8766, 'short'));
  await assert.rejects(client.connect(-1, 'x'.repeat(32)));
  const server = http.createServer((req, res) => res.end(JSON.stringify({ service: 'different-service' })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(client.connect(server.address().port, 'x'.repeat(32)), /Could not connect/);
    assert.equal(client.connected, false);
    assert.equal(client.status().state, 'failed');
    assert.equal(client.latest(), null);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('Pi camera bridge exposes a stalled stream without a token or stale frame', async () => {
  await withServer((req, res) => {
    if (req.url === '/v1/health') return res.end(JSON.stringify(health));
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=ohmpath-video-frame' });
    res.flushHeaders();
  }, async (client, port) => {
    await client.connect(port, token);
    assert.equal(client.status().state, 'waiting');
    client.lastData = Date.now() - 6000;
    await waitFor(() => client.status().state === 'stalled');
    assert.equal(client.status().connected, false);
    assert.equal(client.status().fresh_frame, false);
    assert.match(client.status().reason, /No Pi camera frame/);
    assert.equal(JSON.stringify(client.status()).includes(token), false);
  });
});

test('Pi camera bridge reports unexpected stream end and invalid frames', async () => {
  for (const invalidFrame of [false, true]) {
    await withServer((req, res) => {
      if (req.url === '/v1/health') return res.end(JSON.stringify(health));
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=ohmpath-video-frame' });
      res.flushHeaders();
      setTimeout(() => {
        if (invalidFrame) res.end(Buffer.concat([Buffer.from(frameHeader), Buffer.from([0, 1, 2, 3, 4, 5]), Buffer.from('\r\n')]));
        else res.end();
      }, 30);
    }, async (client, port) => {
      await client.connect(port, token);
      await waitFor(() => client.status().state === 'failed');
      assert.equal(client.status().connected, false);
      assert.equal(client.latest(), null);
      assert.match(client.status().reason, invalidFrame ? /invalid frame/ : /stream stopped/);
    });
  }
});

test('Pi camera bridge ignores a previous stream after reconnect', async () => {
  let streams = 0;
  await withServer((req, res) => {
    if (req.url === '/v1/health') return res.end(JSON.stringify(health));
    streams++;
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=ohmpath-video-frame' });
    res.flushHeaders();
    if (streams === 1) setTimeout(() => { try { res.end(); } catch { /* Already aborted. */ } }, 60);
    else res.write(Buffer.concat([Buffer.from(frameHeader), jpeg, Buffer.from('\r\n')]));
  }, async (client, port) => {
    await client.connect(port, token);
    await client.connect(port, token);
    await waitFor(() => client.status().state === 'streaming');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(client.status().state, 'streaming');
    assert.equal(client.latest().jpeg_base64, jpeg.toString('base64'));
  });
});
