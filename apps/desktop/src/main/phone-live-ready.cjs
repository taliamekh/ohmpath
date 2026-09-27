const { trustedTunnelUrl } = require('./phone-live-tunnel.cjs');

async function waitForPhoneLivePage(pairingUrl, { signal, timeoutMs = 100000, fetchPage = fetch } = {}) {
  const origin = trustedTunnelUrl(new URL(pairingUrl).origin);
  if (!origin) throw new Error('The phone pairing address is invalid.');
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  while (!combined.aborted) {
    try {
      const response = await fetchPage(origin + '/', { redirect: 'error', cache: 'no-store',
        signal: AbortSignal.any([combined, AbortSignal.timeout(5000)]) });
      const ready = response.status === 200 && response.headers.get('x-ohmpath-camera') === 'pairing-v1';
      await response.body?.cancel();
      if (ready) return;
    } catch { /* New temporary hostnames may take a minute to become reachable. */ }
    if (combined.aborted) break;
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); combined.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, 3000);
      combined.addEventListener('abort', done, { once: true });
    });
  }
  if (signal?.aborted) throw new Error('Phone camera connection was cancelled.');
  throw new Error('The secure phone page is not reachable yet. Check your internet connection and try again.');
}

module.exports = { waitForPhoneLivePage };
