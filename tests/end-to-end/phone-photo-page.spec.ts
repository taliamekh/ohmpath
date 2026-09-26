import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer, request as httpRequest } from 'node:http';
import { resolve, join } from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// Electron runs the actual phone page returned by the production bridge. Both
// servers bind 127.0.0.1 only. The proxy rewrites Host/Origin to the bridge's
// declared private interface solely for this test; no LAN or real phone is used.
const ADDRESS = '192.168.42.7';
const PEER = '192.168.42.23';
const electronMain = String.raw`
const { app, BrowserWindow, session } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', process.env.OHMPATH_REPLAY_DATA_DIR);
app.whenReady().then(async () => {
  const pageUrl = process.env.OHMPATH_PHONE_TEST_URL;
  const allowed = new URL(pageUrl).origin + '/';
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !details.url.startsWith(allowed)
      && !details.url.startsWith('blob:') && !details.url.startsWith('data:') }));
  const window = new BrowserWindow({ width: 430, height: 900, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.on('closed', () => app.quit());
  await window.loadURL(pageUrl);
}).catch(error => { console.error('Offline phone page failed:', error); app.quit(); });
app.on('window-all-closed', () => app.quit());
`;

test('phone page decodes a selected PNG, previews locally, and sends a bounded JPEG only on click', async () => {
  const requireElectron = createRequire(resolve('package.json'));
  const { createPhonePhotoBridge } = requireElectron(resolve('apps/desktop/src/main/phone-photos.cjs'));
  const { uploadHeader } = requireElectron(resolve('apps/desktop/src/main/photo-upload.cjs'));
  const received: Array<{ bytes: Buffer; mime_type: string; question: string }> = [];
  const paths: string[] = [];
  const bridge = createPhonePhotoBridge({
    onPhoto: (photo: { bytes: Buffer; mime_type: string; question: string }) => {
      received.push(photo);
      return 'offline_receipt_' + received.length;
    },
    networkInterfaces: () => ({ wifi: [{ family: 'IPv4', address: ADDRESS, internal: false }] }),
    testAdapter: {
      listen: (server: import('node:http').Server) => new Promise<number>((accept, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          accept((server.address() as { port: number }).port);
        });
      }),
      remoteAddress: () => PEER,
      localAddress: () => ADDRESS,
    },
  });
  let browser: import('@playwright/test').Browser | undefined;
  let desktop: ReturnType<typeof spawn> | undefined;
  let proxy: ReturnType<typeof createServer> | undefined;
  try {
    const status = await bridge.start({ address: ADDRESS });
    const privateUrl = new URL(status.url);
    const privateOrigin = privateUrl.origin;
    proxy = createServer((req, res) => {
      if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
      paths.push(`${req.method} ${req.url}`);
      const upstream = httpRequest({ hostname: '127.0.0.1', port: Number(privateUrl.port),
        path: req.url, method: req.method, headers: {
          ...req.headers,
          host: `${ADDRESS}:${privateUrl.port}`,
          ...(req.method === 'POST' ? { origin: privateOrigin } : {}),
        } }, response => {
        res.writeHead(response.statusCode || 502, response.headers);
        response.pipe(res);
      });
      upstream.on('error', () => { if (!res.writableEnded) res.writeHead(502).end(); });
      req.pipe(upstream);
    });
    const proxyPort = await new Promise<number>((accept, reject) => {
      proxy!.once('error', reject);
      proxy!.listen(0, '127.0.0.1', () => {
        proxy!.off('error', reject);
        accept((proxy!.address() as { port: number }).port);
      });
    });
    const pageUrl = `http://127.0.0.1:${proxyPort}/${privateUrl.hash}`;
    const directory = await mkdtemp(join(tmpdir(), 'ohmpath-phone-page-'));
    const mainPath = join(directory, 'phone-page-main.cjs');
    await writeFile(mainPath, electronMain, 'utf8');
    desktop = spawn(requireElectron('electron'), [mainPath, '--remote-debugging-port=0'], {
      env: { ...process.env, OHMPATH_REPLAY_DATA_DIR: directory, OHMPATH_PHONE_TEST_URL: pageUrl },
      windowsHide: true,
    });
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Offline phone page did not open.')), 15000);
      desktop!.stderr.on('data', chunk => {
        const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      desktop!.once('error', error => { clearTimeout(timer); reject(error); });
      desktop!.once('exit', code => { clearTimeout(timer); reject(new Error(`Offline phone page exited early (${code}).`)); });
    });
    browser = await chromium.connectOverCDP(endpoint, { timeout: 12000 });
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 12000 });
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await expect(page.getByRole('heading', { name: 'Bring a photo to your laptop' })).toBeVisible();
    expect(new URL(page.url()).hash).toBe(''); // Pairing token is removed from browser history.
    expect(paths).toEqual(['GET /']);
    expect(received).toHaveLength(0);
    await expect(page.getByRole('button', { name: 'Send to Ohm Path' })).toBeDisabled();

    await page.evaluate(() => {
      const originalCreate = URL.createObjectURL.bind(URL);
      const originalRevoke = URL.revokeObjectURL.bind(URL);
      (window as any).__objectUrls = { created: 0, revoked: 0 };
      URL.createObjectURL = blob => {
        (window as any).__objectUrls.created += 1;
        return originalCreate(blob);
      };
      URL.revokeObjectURL = url => {
        (window as any).__objectUrls.revoked += 1;
        originalRevoke(url);
      };
    });
    const source = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 3000; canvas.height = 1000;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#a28564'; context.fillRect(0, 0, 3000, 1000);
      context.fillStyle = '#263c32'; context.fillRect(250, 200, 2300, 600);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.locator('#photo').setInputFiles({ name: 'synthetic-circuit.png',
      mimeType: 'image/png', buffer: Buffer.from(source, 'base64') });
    await expect(page.locator('#preview')).toBeVisible();
    await expect(page.locator('#preview-image')).toHaveJSProperty('naturalWidth', 2400);
    await expect(page.locator('#preview-detail')).toContainText('2400 × 800');
    await expect(page.getByRole('button', { name: 'Send to Ohm Path' })).toBeEnabled();
    expect(await page.evaluate(() => (window as any).__objectUrls)).toEqual({ created: 1, revoked: 1 });
    expect(paths).toEqual(['GET /']); // Selection and local preview do not upload.
    expect(received).toHaveLength(0);

    await page.locator('#question').fill('Where is the return path?');
    await page.getByRole('button', { name: 'Send to Ohm Path' }).click();
    await expect(page.locator('#status')).toContainText('Review and press Ask on your laptop.');
    expect(paths).toEqual(['GET /', 'POST /photo']);
    expect(received).toHaveLength(1);
    expect(received[0].mime_type).toBe('image/jpeg');
    expect(received[0].question).toBe('Where is the return path?');
    expect(received[0].bytes.length).toBeLessThanOrEqual(2_000_000);
    expect(received[0].bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const dimensions = uploadHeader(received[0].bytes);
    expect(dimensions).toMatchObject({ format: 'jpeg', width: 2400, height: 800 });
    await expect(page.getByRole('button', { name: 'Send to Ohm Path' })).toBeDisabled();
    expect(errors).toEqual([]); // Includes CSP failures from blob image decoding.
    await page.close();
    await expect.poll(() => desktop!.exitCode, { timeout: 8000 }).toBe(0);
  } finally {
    if (desktop?.exitCode === null) desktop.kill();
    if (browser) await browser.close().catch(() => undefined);
    if (proxy?.listening) await new Promise<void>(done => proxy!.close(() => done()));
    await bridge.stop();
  }
});
