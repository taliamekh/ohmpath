'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startElevenLabsLinkServer } = require('../../apps/desktop/src/main/elevenlabs-link-page.cjs');

function fakeConnection() {
  const calls = [];
  let status = { connected: false, voices: [], subscription: null, selected_voice_id: null };
  return {
    calls,
    async handle(action, payload) {
      calls.push({ action, payload });
      if (action === 'status') return status;
      if (action === 'connect') {
        status = { connected: true, voices: [{ voice_id: 'voice_12345678', name: '<Test voice>' }],
          subscription: { tier: 'test', overage_status: 'disabled' }, selected_voice_id: null };
      } else if (action === 'selectVoice') status.selected_voice_id = payload.voiceId;
      else if (action === 'disconnect') status = { connected: false, voices: [], subscription: null, selected_voice_id: null };
      return status;
    },
  };
}

async function post(url, body, origin = new URL(url).origin) {
  return fetch(url, { method: 'POST', headers: {
    Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded',
  }, body, redirect: 'manual' });
}

function rawRequest(url, options = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: target.port, path: target.pathname,
      method: options.method || 'GET', headers: options.headers || {} }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

test('temporary link exposes only a local capability page with restrictive headers', async () => {
  const connection = fakeConnection();
  const link = await startElevenLabsLinkServer({ connection });
  try {
    assert.match(link.url, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}$/);
    const response = await fetch(link.url);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /No speech will be generated or previewed/);
    assert.match(response.headers.get('content-security-policy'), /script-src 'none'/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await fetch(link.url + '?x=1')).status, 404);
    assert.equal((await fetch(new URL('/wrong', link.url))).status, 404);
    assert.equal((await rawRequest(link.url, { headers: { Host: 'localhost:' + new URL(link.url).port } })).status, 404);
    assert.deepEqual(connection.calls.map(call => call.action), ['status']);
  } finally { await link.close(); }
});

test('link rejects cross-origin, missing origin, wrong method, oversized and malformed forms', async () => {
  const connection = fakeConnection();
  const link = await startElevenLabsLinkServer({ connection });
  const body = new URLSearchParams({ action: 'connect', apiKey: 'a'.repeat(32) }).toString();
  try {
    assert.equal((await post(link.url, body, 'https://example.com')).status, 403);
    assert.equal((await rawRequest(link.url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })).status, 403);
    assert.equal((await fetch(link.url, { method: 'PUT' })).status, 405);
    assert.equal((await post(link.url, 'x'.repeat(1025))).status, 413);
    assert.equal((await post(link.url, 'action=connect&action=refresh&apiKey=' + 'a'.repeat(32))).status, 400);
    assert.equal((await post(link.url, 'action=generate&apiKey=' + 'a'.repeat(32))).status, 400);
    assert.equal(connection.calls.length, 0);
  } finally { await link.close(); }
});

test('connect and select voice use metadata actions only, never echo key, and finish closes', async () => {
  const connection = fakeConnection();
  const link = await startElevenLabsLinkServer({ connection });
  const key = 'test_key_abcdefghijklmnop';
  const voiceId = 'voice_12345678';
  try {
    const connected = await post(link.url, new URLSearchParams({ action: 'connect', apiKey: key }));
    assert.equal(connected.status, 303);
    assert.equal(connected.headers.get('location'), new URL(link.url).pathname);
    assert.doesNotMatch(await connected.text(), new RegExp(key));
    const html = await (await fetch(link.url)).text();
    assert.match(html, /Connected/);
    assert.match(html, /&lt;Test voice&gt;/);
    assert.match(html, /<option value="" disabled selected>Choose a voice · no preview/);
    assert.doesNotMatch(html, new RegExp(key));
    assert.equal((await post(link.url, new URLSearchParams({ action: 'selectVoice', voiceId }))).status, 303);
    assert.deepEqual(connection.calls.filter(call => call.action !== 'status').map(call => call.action), ['connect', 'selectVoice']);
    assert.equal(connection.calls[0].payload.apiKey, key);
    assert.equal((await post(link.url, 'action=finish')).status, 200);
    await link.closed;
  } finally { await link.close(); }
});

test('idle timeout closes the temporary link', async () => {
  const link = await startElevenLabsLinkServer({ connection: fakeConnection(), idleMs: 100 });
  await link.closed;
  assert.equal((await link.close()), undefined);
});
