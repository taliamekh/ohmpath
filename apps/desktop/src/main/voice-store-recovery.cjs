const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

async function recoverVoiceStore({ sourceDirectory, targetDirectory, safeStorage, executable = process.execPath }) {
  const marker = path.join(targetDirectory, 'private', 'voice-profile-recovery.applied');
  try { await fs.access(marker); return false; } catch {}
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows protected storage is unavailable.');
  const localState = path.join(sourceDirectory, 'Local State');
  const sourceStore = path.join(sourceDirectory, 'private', 'elevenlabs.enc');
  for (const file of [localState, sourceStore]) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) throw new Error('Saved voice profile is invalid.');
  }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ohmpath-voice-recovery-'));
  let worker;
  try {
    // Copy only the encrypted OS key, not the rest of the browser profile.
    const state = JSON.parse(await fs.readFile(localState, 'utf8'));
    await fs.writeFile(path.join(scratch, 'Local State'), JSON.stringify({ os_crypt: state.os_crypt }), { mode: 0o600 });
    const value = await new Promise((accept, reject) => {
      worker = spawn(executable, [path.join(__dirname, 'voice-store-recovery-worker.cjs'), sourceDirectory, scratch],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const timer = setTimeout(() => { worker.kill(); reject(new Error('Voice recovery timed out.')); }, 10000);
      worker.once('message', message => {
        clearTimeout(timer);
        if (typeof message?.value === 'string' && message.value.length <= 512 * 1024) accept(message.value);
        else reject(new Error('Windows could not open the saved voice connection.'));
      });
      worker.once('error', () => { clearTimeout(timer); reject(new Error('Voice recovery could not start.')); });
      worker.once('exit', () => { clearTimeout(timer); reject(new Error('Voice recovery stopped.')); });
    });
    const decoded = JSON.parse(value);
    if (decoded.version !== 1 || !/^[A-Za-z0-9_-]{16,256}$/.test(decoded.apiKey || '')
        || !Array.isArray(decoded.voices) || !Array.isArray(decoded.models) || !decoded.subscription)
      throw new Error('Saved connection format is invalid.');
    const target = path.join(targetDirectory, 'private', 'elevenlabs.enc');
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try { await fs.copyFile(target, `${target}.before-profile-recovery`, require('node:fs').constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Voice backup already exists or could not be saved.'); }
    const encrypted = safeStorage.encryptString(value);
    await fs.writeFile(`${target}.recovery.tmp`, encrypted, { flag: 'wx', mode: 0o600 });
    await fs.rename(`${target}.recovery.tmp`, target);
    await fs.writeFile(marker, 'Recovered the user-authorized voice connection; never restore automatically again.', { flag: 'wx', mode: 0o600 });
    return true;
  } finally {
    if (worker && worker.exitCode === null) {
      const exited = new Promise(resolve => worker.once('exit', resolve));
      worker.kill();
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1000))]);
    }
    // scratch is generated above and is never derived from imported data.
    if (path.dirname(scratch) === os.tmpdir() && path.basename(scratch).startsWith('ohmpath-voice-recovery-'))
      await fs.rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
module.exports = { recoverVoiceStore };
