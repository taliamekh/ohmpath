// Isolated encryption context. Secrets travel only over the parent's private IPC.
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createElevenLabsConnection } = require('./elevenlabs.cjs');
const source = process.argv[2];
const scratch = process.argv[3];
app.disableHardwareAcceleration();
app.setPath('userData', scratch);
app.whenReady().then(async () => {
  if (!process.send) throw new Error('Private channel required');
  const filePath = path.join(source, 'private', 'elevenlabs.enc');
  const connection = createElevenLabsConnection({ safeStorage, filePath,
    fetchImpl: () => { throw new Error('Network disabled during recovery'); } });
  const status = await connection.handle('status', {});
  if (!status.connected) throw new Error('Saved connection unavailable');
  const value = safeStorage.decryptString(fs.readFileSync(filePath));
  process.send({ value }, () => app.quit());
}).catch(() => {
  if (process.send) process.send({ error: true }, () => app.quit());
  else app.quit();
});
