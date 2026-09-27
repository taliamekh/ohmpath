'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const REQUEST = '10000000-0000-4000-8000-000000000001';
const SECOND = '20000000-0000-4000-8000-000000000002';

function playerFixture({ suspended = false } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../apps/desktop/src/renderer/SpeechPlayback.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const timers = new Map();
  let nextTimer = 0;
  const contexts = [];
  class FakeAudioContext {
    constructor() {
      this.state = suspended ? 'suspended' : 'running';
      this.currentTime = 0;
      this.destination = {};
      this.sources = [];
      contexts.push(this);
    }
    resume() { return suspended ? new Promise(() => {}) : Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createBuffer(_channels, length, rate) {
      return { duration: length / rate, getChannelData: () => new Float32Array(length) };
    }
    createBufferSource() {
      const context = this;
      return { buffer: null, onended: null, connect() {}, disconnect() {},
        start(at) { this.at = at; context.sources.push(this); }, stop() {} };
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, AudioContext: FakeAudioContext,
    window: { setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
      clearTimeout(id) { timers.delete(id); } },
    atob: value => Buffer.from(value, 'base64').toString('binary'), Uint8Array, Set, Math, Error });
  const states = [];
  const player = new module.exports.SpeechPlayback((...args) => states.push(args));
  return { player, states, contexts, timers,
    fire(delay) { const entry = [...timers].find(([, value]) => value.delay === delay);
      assert.ok(entry, `timer ${delay} exists`); timers.delete(entry[0]); entry[1].callback(); } };
}

test('short stream drains before started timer and still reports terminal completion', async () => {
  const { player, contexts, states, timers } = playerFixture();
  await player.arm(REQUEST);
  await player.receive({ type: 'chunk', request_id: REQUEST, sample_rate: 24000,
    pcm_base64: Buffer.from([0, 0]).toString('base64') });
  await player.receive({ type: 'end', request_id: REQUEST });
  const source = contexts[0].sources[0];
  source.onended();
  assert.equal(player.requestId, null);
  assert.deepEqual(states.map(([state]) => state), ['ended']);
  assert.equal(timers.size, 0);
  player.dispose();
});

test('audio unlock timeout reports error, ignores late chunks, and permits a new request', async () => {
  const { player, states, fire } = playerFixture({ suspended: true });
  const unlocking = player.arm(REQUEST);
  const chunk = { type: 'chunk', request_id: REQUEST, sample_rate: 24000,
    pcm_base64: Buffer.from([0, 0]).toString('base64') };
  const waiting = player.receive(chunk);
  fire(5000);
  await assert.rejects(unlocking, { message: 'playback_unavailable' });
  await waiting;
  assert.equal(player.requestId, null);
  assert.deepEqual(states.map(([state, id, detail]) => [state, id, detail]),
    [['error', REQUEST, 'playback_unavailable']]);
  const nextUnlock = player.arm(SECOND);
  assert.equal(player.requestId, SECOND);
  player.stop(SECOND);
  fire(5000);
  await assert.rejects(nextUnlock, { message: 'playback_unavailable' });
  assert.equal(states.length, 1, 'a cancelled unlock cannot report an error for the next request');
  player.dispose();
});
