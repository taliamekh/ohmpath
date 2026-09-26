const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PiVideoClient } = require('../../apps/desktop/src/main/pi-video.cjs');

test('Pi camera bridge authenticates, replaces frames and drops disconnected data', async () => {
  const token = 'test-video-token-'.repeat(3);
  const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
  let requested = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + token);
    requested++;
    if (req.url === '/v1/health') {
      res.end(JSON.stringify({service: 'ohmpath-pi-video', mode: 'camera', physical_control: 'disabled'}));
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
    assert.equal(requested, 2);
    client.disconnect();
    assert.equal(client.latest(), null);
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
    assert.equal(client.latest(), null);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
