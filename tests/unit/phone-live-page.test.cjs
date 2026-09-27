'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { phoneLivePage } = require('../../apps/desktop/src/main/phone-live-page.cjs');

const TOKEN = Buffer.alloc(32, 0xa5).toString('base64url');
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
function pageFixture({ camera, fetchImpl, Peer } = {}) {
  Peer ||= class {};
  const html = phoneLivePage('nonce_1234567890123456');
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const elements = new Map();
  function element(id) {
    const listeners = new Map();
    return { id, disabled: false, textContent: '', className: '', value: '1080', srcObject: null,
      classList: { add() {}, remove() {} },
      addEventListener(name, callback) { listeners.set(name, callback); },
      click() { listeners.get('click')?.(); },
      play: () => Promise.resolve(),
    };
  }
  for (const id of ['start', 'stop', 'quality', 'status', 'detail', 'view', 'preview']) elements.set(id, element(id));
  const listeners = new Map();
  const timeouts = new Map();
  let timerId = 0;
  const historyCalls = [];
  const fetchCalls = [];
  const context = {
    location: { hash: '#token=' + TOKEN, pathname: '/', search: '' },
    history: { replaceState: (...args) => historyCalls.push(args) },
    document: { visibilityState: 'visible', getElementById: id => elements.get(id),
      addEventListener: (name, callback) => listeners.set(name, callback) },
    window: { isSecureContext: true, RTCPeerConnection: Peer, addEventListener: (name, callback) => listeners.set(name, callback) },
    navigator: { mediaDevices: { getUserMedia: camera || (() => Promise.reject(new Error('no camera'))) } },
    RTCPeerConnection: Peer,
    crypto: { randomUUID: () => 'client-1' },
    URLSearchParams,
    AbortController,
    setTimeout(callback, delay) { const id = ++timerId; timeouts.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    fetch: (...args) => { fetchCalls.push(args); return fetchImpl(...args); },
  };
  vm.runInNewContext(script, context);
  return { html, elements, historyCalls, fetchCalls, listeners, timeouts };
}

test('page validates nonce and keeps pairing secret out of markup and address bar', () => {
  assert.throws(() => phoneLivePage('<unsafe>'), /nonce/);
  const fixture = pageFixture({ fetchImpl: () => { throw new Error('unexpected request'); } });
  assert.equal(fixture.html.includes(TOKEN), false);
  assert.equal(fixture.historyCalls[0][2], '/');
  assert.equal(fixture.fetchCalls.length, 0);
  assert.equal(fixture.elements.get('start').disabled, false);
  assert.match(fixture.html, /Start rear camera/);
  assert.match(fixture.html, /No recording or AI analysis starts here/);
});

test('Stop while permission is pending closes a late camera without claiming session', async () => {
  const pending = deferred();
  let stopped = 0;
  const track = { stop() { stopped++; }, addEventListener() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] };
  const fixture = pageFixture({ camera: () => pending.promise,
    fetchImpl: async path => {
      if (path === '/stop') return { ok: true, json: async () => ({ stopped: true }) };
      assert.equal(path, '/session');
      return { ok: true, json: async () => ({ session_id: 'session-1', state: 'waiting',
        offer: { type: 'offer', sdp: 'offer-sdp' } }) };
    } });
  fixture.elements.get('start').click();
  await flush();
  fixture.elements.get('stop').click();
  pending.resolve(stream);
  await flush();
  assert.equal(stopped, 1);
  assert.equal(fixture.fetchCalls.some(([path]) => path === '/answer'), false);
  assert.equal(fixture.fetchCalls.some(([path]) => path === '/stop'), true);
  assert.equal(fixture.elements.get('preview').srcObject, null);
});

test('answer sends only the selected video track and Stop releases local capture', async () => {
  const tracks = [];
  const track = { stop() { this.stopped = true; }, addEventListener() {},
    getSettings: () => ({ width: 1280, height: 720 }) };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] };
  let pc;
  class Peer {
    constructor(config) { this.config = config; this.iceGatheringState = 'complete'; this.connectionState = 'connecting'; pc = this; }
    addEventListener(name, callback) { if (name === 'connectionstatechange') this.onstate = callback; }
    async setRemoteDescription(value) { this.offer = value; }
    addTrack(...args) { tracks.push(args); }
    async createAnswer() { return { type: 'answer', sdp: 'answer-sdp' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    close() { this.closed = true; }
  }
  const fixture = pageFixture({ camera: async () => stream, Peer,
    fetchImpl: async path => ({ ok: true, json: async () => path === '/session'
      ? { session_id: 'session-1', state: 'waiting', offer: { type: 'offer', sdp: 'offer-sdp' } }
      : { accepted: true } }) });
  fixture.elements.get('quality').value = '720';
  fixture.elements.get('start').click();
  await flush();
  assert.equal(pc.config.iceServers.length, 0);
  assert.equal(pc.offer.type, 'offer');
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0][0], track);
  const answer = fixture.fetchCalls.find(([path]) => path === '/answer');
  assert.ok(answer);
  assert.equal(answer[1].headers.Authorization, 'Bearer ' + TOKEN);
  assert.deepEqual(JSON.parse(answer[1].body), { client_id: 'client-1', answer: { type: 'answer', sdp: 'answer-sdp' } });
  pc.connectionState = 'connected';
  pc.onstate();
  assert.match(fixture.elements.get('detail').textContent, /1280 × 720/);
  fixture.elements.get('stop').click();
  assert.equal(track.stopped, true);
  assert.equal(pc.closed, true);
  assert.equal(fixture.elements.get('preview').srcObject, null);
  assert.ok(fixture.fetchCalls.some(([path]) => path === '/stop'));
});

test('a closed desktop session ends capture on the next poll', async () => {
  const track = { stop() { this.stopped = true; }, addEventListener() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] };
  let reads = 0;
  let pc;
  class Peer {
    constructor() { this.iceGatheringState = 'complete'; this.connectionState = 'connecting'; pc = this; }
    addEventListener() {}
    async setRemoteDescription() {}
    addTrack() {}
    async createAnswer() { return { type: 'answer', sdp: 'answer-sdp' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    close() { this.closed = true; }
  }
  const fixture = pageFixture({ camera: async () => stream, Peer, fetchImpl: async path => ({
    ok: true, json: async () => path === '/session' ? {
      session_id: 'session-1', state: ++reads === 1 ? 'waiting' : 'stopped',
      offer: { type: 'offer', sdp: 'offer-sdp' },
    } : { accepted: true },
  }) });
  fixture.elements.get('start').click();
  await flush();
  const poll = [...fixture.timeouts.values()].find(timer => timer.delay === 2000);
  assert.ok(poll);
  poll.callback();
  await flush();
  assert.equal(track.stopped, true);
  assert.equal(pc.closed, true);
  assert.match(fixture.elements.get('status').textContent, /laptop ended this session/);
});
