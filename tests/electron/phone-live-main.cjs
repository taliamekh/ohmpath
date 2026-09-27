// Production renderer + phone page + signaling bridge; only the HTTPS tunnel is
// replaced with a loopback proxy. Browser media comes from synthetic canvas in the test.
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const Module = require('node:module');
const fixturePath = resolve(__dirname, 'photo-help-replay-main.cjs');
let source = readFileSync(fixturePath, 'utf8');
function replaceOnce(before, after) {
  if (source.split(before).length !== 2) throw new Error('Shared replay changed; review the phone live adapter.');
  source = source.replace(before, after);
}
replaceOnce('function handle(action, payload = {}) {', String.raw`
const { createPhoneLiveBridge } = require('../../apps/desktop/src/main/phone-live.cjs');
const { phoneLivePage } = require('../../apps/desktop/src/main/phone-live-page.cjs');
const http = require('node:http');
const QRCode = require('qrcode');
let phoneProxyPort;
let phoneTestWindow;
let phoneSession;
const phoneAudit = { requests: [], tunnelStops: 0 };
const phoneBridge = createPhoneLiveBridge({ pageFactory: phoneLivePage,
  tunnelFactory: async port => {
    const proxy = http.createServer((req, res) => {
      phoneAudit.requests.push(req.method + ' ' + req.url);
      const upstream = http.request({ hostname: '127.0.0.1', port, path: req.url,
        method: req.method, headers: { ...req.headers, host: 'fixture.trycloudflare.com',
          ...(req.headers.origin ? { origin: 'https://fixture.trycloudflare.com' } : {}) } }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      upstream.on('error', () => { if (!res.writableEnded) res.writeHead(502).end(); });
      req.pipe(upstream);
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    phoneProxyPort = proxy.address().port;
    return { url: 'https://fixture.trycloudflare.com', stop() {
      phoneAudit.tunnelStops++;
      proxy.closeAllConnections();
      return new Promise(resolve => proxy.close(resolve));
    } };
  }
});
app.on('before-quit', () => { void phoneBridge.shutdown(); });
function handle(action, payload = {}) {
  if (action === 'phoneLiveStart') return phoneBridge.start(payload).then(async status => {
    phoneSession = status;
    return { ...status, qr_data_url: await QRCode.toDataURL(status.url) };
  });
  if (action === 'phoneLiveStatus') return phoneBridge.status(payload.session_id);
  if (action === 'phoneLiveStop') return phoneBridge.stop(payload).then(() => phoneBridge.status(payload.session_id));
  if (action === 'testPhoneOpen') {
    const phonePartition = session.fromPartition('phone-live-fixture');
    phonePartition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    phonePartition.setPermissionCheckHandler(() => false);
    phonePartition.webRequest.onBeforeRequest((details, callback) => callback({ cancel:
      !details.url.startsWith('http://127.0.0.1:' + phoneProxyPort + '/') && !details.url.startsWith('blob:') }));
    phoneTestWindow = new BrowserWindow({ width: 430, height: 900, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'phone-live-fixture' } });
    return phoneTestWindow.loadURL('http://127.0.0.1:' + phoneProxyPort + '/' + new URL(phoneSession.url).hash).then(() => ({ opened: true }));
  }
  if (action === 'testPhoneAudit') return { ...phoneAudit, active: phoneBridge.status().active };
`);
replaceOnce('audit.captures.push({ source: payload.source, captured_at: payload.captured_at, length: payload.data_url.length });', `
    const size = require('electron').nativeImage.createFromDataURL(payload.data_url).getSize();
    audit.captures.push({ source: payload.source, captured_at: payload.captured_at, length: payload.data_url.length, ...size });`);
const replay = new Module(fixturePath, module);
replay.filename = fixturePath;
replay.paths = Module._nodeModulePaths(__dirname);
replay._compile(source, fixturePath);
