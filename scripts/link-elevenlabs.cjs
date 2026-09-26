'use strict';

// Launch with the Electron binary. This process creates no browser window or audio.
const { app, safeStorage } = require('electron');
const { join, isAbsolute } = require('node:path');
const { mkdirSync } = require('node:fs');
const { createElevenLabsConnection } = require('../apps/desktop/src/main/elevenlabs.cjs');
const { startElevenLabsLinkServer } = require('../apps/desktop/src/main/elevenlabs-link-page.cjs');

const args = process.argv.slice(2);
let dataDir;
if (args.length === 2 && args[0] === '--data-dir' && isAbsolute(args[1])) dataDir = args[1];
else if (args.length !== 0) { process.stderr.write('Invalid link options.\n'); process.exit(2); }

app.setName('ohmpath');
try {
  const userData = dataDir ? join(dataDir, 'desktop') : join(app.getPath('appData'), 'ohmpath');
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  app.setPath('userData', userData);
} catch {
  process.stderr.write('The local ElevenLabs link could not start.\n');
  process.exit(1);
}

app.whenReady().then(async () => {
  const filePath = join(app.getPath('userData'), 'private', 'elevenlabs.enc');
  const connection = createElevenLabsConnection({ safeStorage, filePath });
  const link = await startElevenLabsLinkServer({ connection });
  process.stdout.write(`${link.url}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void link.close(); });
  await link.closed;
  app.quit();
}).catch(() => {
  process.stderr.write('The local ElevenLabs link could not start.\n');
  app.quit();
  process.exitCode = 1;
});
