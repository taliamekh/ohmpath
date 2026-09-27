const { spawn } = require('node:child_process');
const { mkdtemp, writeFile, unlink, rmdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const START_TIMEOUT_MS = 30_000;
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=$|[\s/'"\x1b])/ig;

function trustedTunnelUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/'
        || url.search || url.hash
        || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname)) return null;
    return url.origin;
  } catch { return null; }
}

function createPhoneLiveTunnel({ binaryPath, spawnProcess = spawn } = {}) {
  if (typeof binaryPath !== 'string' || !binaryPath.trim())
    throw new TypeError('A reviewed cloudflared executable path is required.');
  if (typeof spawnProcess !== 'function') throw new TypeError('A process launcher is required.');
  return async function tunnelFactory(localPort, { signal } = {}) {
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535)
      throw new TypeError('A valid local port is required.');
    if (signal?.aborted) throw new Error('Phone camera connection was cancelled.');
    const isolatedHome = await mkdtemp(join(tmpdir(), 'ohmpath-phone-'));
    const configPath = join(isolatedHome, 'config.yml');
    const cleanup = async () => {
      await unlink(configPath).catch(() => undefined);
      await rmdir(isolatedHome).catch(() => undefined);
    };
    try { await writeFile(configPath, '', { flag: 'wx', mode: 0o600 }); }
    catch { await cleanup(); throw new Error('Could not prepare the private phone camera tunnel.'); }
    if (signal?.aborted) {
      await cleanup();
      throw new Error('Phone camera connection was cancelled.');
    }
    // Keep this Quick Tunnel independent of any existing account tunnel or ingress rules.
    const env = { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome,
      XDG_CONFIG_HOME: isolatedHome };
    for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('TUNNEL_')) delete env[key];
    let child;
    try {
      child = spawnProcess(binaryPath, ['--no-autoupdate', 'tunnel', '--config', configPath, '--url',
        `http://127.0.0.1:${localPort}`, '--protocol', 'http2'],
      { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'], env });
    } catch {
      await cleanup();
      throw new Error('Could not start cloudflared. Check the installed tunnel tool.');
    }
    let settled = false;
    let exited = false;
    let tail = '';
    let exitListener = null;
    let exitResolve;
    const exitPromise = new Promise(resolve => { exitResolve = resolve; });
    const markExited = () => {
      if (exited) return;
      exited = true;
      void cleanup().finally(exitResolve);
      if (settled) exitListener?.();
    };
    child.once('close', markExited);
    const stop = async () => {
      if (exited) return exitPromise;
      try { child.kill(); } catch { /* Wait for close or force termination. */ }
      const force = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2_000);
      const closed = await Promise.race([exitPromise.then(() => true), new Promise(resolve => {
        const deadline = setTimeout(() => resolve(false), 5_000);
        exitPromise.then(() => clearTimeout(deadline));
      })]);
      clearTimeout(force);
      if (!closed) throw new Error('The phone camera tunnel could not be closed.');
    };
    const url = await new Promise((resolve, reject) => {
      let failing = false;
      const timer = setTimeout(() => fail('The phone camera tunnel did not start in time.'), START_TIMEOUT_MS);
      timer.unref?.();
      const onAbort = () => fail('Phone camera connection was cancelled.');
      signal?.addEventListener('abort', onAbort, { once: true });
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(value);
      };
      const fail = message => {
        if (failing || settled) return;
        failing = true;
        void stop().catch(() => undefined).then(() => finish(new Error(message)));
      };
      child.stderr.on('data', chunk => {
        if (failing || settled) return;
        tail = (tail + chunk.toString('utf8')).slice(-4096);
        for (const match of tail.matchAll(URL_PATTERN)) {
          const found = trustedTunnelUrl(match[0]);
          if (found) { finish(null, found); return; }
        }
      });
      child.once('error', () => {
        if (settled) exitListener?.();
        else fail('Could not start cloudflared. Check the installed tunnel tool.');
      });
      child.once('exit', () => {
        if (!settled) fail('The phone camera tunnel closed before it was ready.');
      });
    });
    // The URL and stderr remain private to main. No raw child output is exposed.
    return { url, stop, onExit(callback) { exitListener = callback; if (exited) callback(); } };
  };
}

module.exports = { createPhoneLiveTunnel, trustedTunnelUrl };
