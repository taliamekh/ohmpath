const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForPhoneLivePage } = require('../../apps/desktop/src/main/phone-live-ready.cjs');

test('readiness checks only the public page and does not send pairing tokens', async () => {
  let cancelled = false;
  await waitForPhoneLivePage('https://fixture.trycloudflare.com/#token=private', { fetchPage: async (url, options) => {
    assert.equal(url, 'https://fixture.trycloudflare.com/');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers, undefined);
    return { status: 200, headers: new Headers({ 'x-ohmpath-camera': 'pairing-v1' }), body: { cancel: async () => { cancelled = true; } } };
  } });
  assert.equal(cancelled, true);
});

test('readiness cancels promptly and rejects foreign hosts', async () => {
  const controller = new AbortController();
  const operation = waitForPhoneLivePage('https://fixture.trycloudflare.com/', { signal: controller.signal, fetchPage: async () => {
    controller.abort();
    throw new Error('synthetic DNS delay');
  } });
  await assert.rejects(operation, /cancelled/);
  await assert.rejects(waitForPhoneLivePage('https://example.com'), /invalid/);
});

test('a generic or challenge page does not count as a ready phone page', async () => {
  await assert.rejects(waitForPhoneLivePage('https://fixture.trycloudflare.com/', { timeoutMs: 20, fetchPage: async () => ({
    status: 200, headers: new Headers(), body: { cancel: async () => {} },
  }) }), /not reachable/);
});
