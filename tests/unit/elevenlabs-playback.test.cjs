'use strict';

// Only synthetic metadata and synthetic PCM bytes. No Electron audio or provider access.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createElevenLabsConnection } = require('../../apps/desktop/src/main/elevenlabs.cjs');

const KEY = 'syntheticKey_1234567890123456';
const VOICE = 'voice_12345678';
const REQUEST = '10000000-0000-4000-8000-000000000001';
const API = 'https://api.elevenlabs.io';

async function fixture(run, { overage = 0, category = 'premade', rate = .5,
  audio = Buffer.from([0, 0, 255, 127]), stall = false, beforeFetch = async () => {} } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ohmpath-speech-mock-'));
  const calls = [];
  const events = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    await beforeFetch(url, options);
    if (url === `${API}/v1/user/subscription`) return json({ tier: 'starter', character_count: 10,
      character_limit: 1000, max_credit_limit_extension: overage });
    if (url === `${API}/v2/voices?page_size=100`) return json({ voices: [
      { voice_id: VOICE, name: 'Synthetic voice', category: typeof category === 'function' ? category() : category },
    ] });
    if (url === `${API}/v1/models`) return json([{ model_id: 'eleven_flash_v2_5', name: 'Flash',
      can_do_text_to_speech: true, maximum_text_length_per_request: 1000,
      model_rates: { character_cost_multiplier: rate } }]);
    assert.equal(url, `${API}/v1/text-to-speech/${VOICE}/stream?output_format=pcm_24000`);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['xi-api-key'], KEY);
    assert.deepEqual(JSON.parse(options.body), { text: 'Hello.', model_id: 'eleven_flash_v2_5',
      voice_settings: { stability: 0.7, similarity_boost: 0.75, style: 0, use_speaker_boost: false, speed: 0.95 } });
    const reader = stall ? { read: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }) } : { index: 0, async read() {
      return this.index++ ? { done: true } : { done: false, value: audio };
    } };
    return { ok: true, status: 200, headers: { get: name => name === 'content-type' ? 'audio/pcm' : null },
      body: { getReader: () => reader } };
  };
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value).map(byte => byte ^ 0x96),
    decryptString: value => Buffer.from(value).map(byte => byte ^ 0x96).toString('utf8') };
  try {
    const connection = createElevenLabsConnection({ safeStorage,
      filePath: path.join(directory, 'private.enc'), fetchImpl,
      onSpeechEvent: event => events.push(event) });
    await run({ connection, calls, events });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

function json(value) {
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(value) };
}

async function linked(connection) {
  await connection.handle('connect', { apiKey: KEY });
  await connection.handle('selectVoice', { voiceId: VOICE });
}

async function until(condition) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('mock event did not arrive');
}

test('speech is off until explicitly enabled and no generation starts on link or status', async () => {
  await fixture(async ({ connection, calls }) => {
    await linked(connection);
    assert.equal((await connection.handle('status')).generation_enabled, false);
    await assert.rejects(connection.handle('speak', { request_id: REQUEST, text: 'Hello.' }),
      { code: 'unsupported_action' });
    assert.equal(calls.some(call => call.options.method === 'POST'), false);
    await assert.rejects(connection.handle('setGenerationEnabled', { enabled: true, characterBudget: 1001 }),
      { code: 'invalid_budget' });
  });
});

test('scoped cancel during fresh metadata preflight prevents the generation POST', async () => {
  let hold = false;
  let release;
  await fixture(async ({ connection, calls }) => {
    await linked(connection);
    await connection.handle('setGenerationEnabled', { enabled: true, characterBudget: 12 });
    hold = true;
    const pending = connection.handle('speak', { request_id: REQUEST, text: 'Hello.' });
    await until(() => typeof release === 'function');
    await connection.handle('cancelSpeech', { request_id: REQUEST });
    release();
    await assert.rejects(pending, { code: 'speech_cancelled' });
    assert.equal(calls.some(call => call.options.method === 'POST'), false);
  }, { beforeFetch: url => hold && url.endsWith('/v1/user/subscription')
    ? new Promise(resolve => { release = resolve; }) : undefined });
});

test('higher model rates cannot exceed the launch credit budget', async () => {
  await fixture(async ({ connection, calls }) => {
    await linked(connection);
    await connection.handle('setGenerationEnabled', { enabled: true, characterBudget: 8 });
    await assert.rejects(connection.handle('speak', { request_id: REQUEST, text: 'Hello.' }),
      { code: 'session_credit_budget_exhausted' });
    assert.equal(calls.some(call => call.options.method === 'POST'), false);
  }, { rate: 2 });
});

test('a possibly charged request identity cannot generate a second time', async () => {
  await fixture(async ({ connection, calls, events }) => {
    await linked(connection);
    await connection.handle('setGenerationEnabled', { enabled: true, characterBudget: 20 });
    await connection.handle('speak', { request_id: REQUEST, text: 'Hello.' });
    await until(() => events.some(event => event.type === 'end'));
    await assert.rejects(connection.handle('speak', { request_id: REQUEST, text: 'Hello.' }),
      { code: 'speech_request_already_used' });
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  });
});

test('synthetic fast PCM stream drains through a bounded player window and stop clears sources', async () => {
  const sourcePath = path.join(__dirname, '../../apps/desktop/src/renderer/SpeechPlayback.ts');
  const sourceText = fsSync.readFileSync(sourcePath, 'utf8');
  const compiled = ts.transpileModule(sourceText, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const fakeContexts = [];
  class FakeAudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; this.sources = []; this.maxActive = 0; fakeContexts.push(this); }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createBuffer(_channels, length, rate) {
      const samples = new Float32Array(length);
      return { duration: length / rate, getChannelData: () => samples };
    }
    createBufferSource() {
      const context = this;
      return {
        buffer: null, onended: null, ended: false, stopped: false,
        connect() {}, disconnect() {},
        start(at) {
          this.at = at;
          context.sources.push(this);
          context.maxActive = Math.max(context.maxActive,
            context.sources.filter(item => !item.ended && !item.stopped).length);
        },
        stop() { this.stopped = true; },
      };
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, AudioContext: FakeAudioContext,
    window: { setTimeout, clearTimeout }, atob: value => Buffer.from(value, 'base64').toString('binary'),
    Uint8Array, Float32Array, Set, Math, Error });
  const states = [];
  const player = new module.exports.SpeechPlayback((state, id) => states.push([state, id]));
  player.arm(REQUEST);
  await player.receive({ type: 'start', request_id: REQUEST, sample_rate: 24000, format: 'pcm_s16le' });
  const chunk = { type: 'chunk', request_id: REQUEST, sample_rate: 24000,
    pcm_base64: Buffer.alloc(4096).toString('base64') };
  for (let index = 0; index < 100; index += 1) await player.receive(chunk);
  const context = fakeContexts[0];
  assert.ok(player.pending.length > 0, 'fast delivery waits in a bounded receive queue');
  assert.ok(context.maxActive <= 8, 'only eight buffers are scheduled at once');
  await player.receive({ type: 'end', request_id: REQUEST });
  await new Promise(resolve => setTimeout(resolve, 20));
  for (let index = 0; index < 120 && player.requestId; index += 1) {
    const next = context.sources.filter(item => !item.ended && !item.stopped)
      .sort((a, b) => a.at + a.buffer.duration - b.at - b.buffer.duration)[0];
    assert.ok(next, 'the playback queue continues scheduling until drained');
    context.currentTime = next.at + next.buffer.duration;
    next.ended = true;
    next.onended();
  }
  assert.equal(player.requestId, null);
  assert.deepEqual(states.map(item => item[0]), ['started', 'ended']);

  const second = '20000000-0000-4000-8000-000000000002';
  player.arm(second);
  const secondChunk = { ...chunk, request_id: second };
  for (let index = 0; index < 100; index += 1) await player.receive(secondChunk);
  const scheduled = context.sources.filter(item => !item.ended && !item.stopped);
  player.stop(second);
  assert.equal(scheduled.every(item => item.stopped), true);
  assert.equal(player.pending.length, 0);
  await player.receive(secondChunk);
  assert.equal(player.requestId, null);
  player.dispose();
});

test('explicit speech reserves conservative credits and emits bounded PCM events', async () => {
  await fixture(async ({ connection, calls, events }) => {
    await linked(connection);
    const enabled = await connection.handle('setGenerationEnabled', { enabled: true, characterBudget: 12 });
    assert.equal(enabled.remaining_session_characters, 12);
    const accepted = await connection.handle('speak', { request_id: REQUEST, text: 'Hello.' });
    assert.deepEqual(accepted, { accepted: true, request_id: REQUEST, reserved_credits: 6,
      remaining_session_characters: 6 });
    await until(() => events.some(event => event.type === 'end'));
    assert.deepEqual(events.map(event => event.type), ['start', 'chunk', 'end']);
    assert.equal(events[1].pcm_base64, Buffer.from([0, 0, 255, 127]).toString('base64'));
    assert.equal(events[1].sample_rate, 24000);
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
    const status = await connection.handle('status');
    assert.equal(status.reserved_session_credits, 6);
    assert.equal(status.remaining_session_characters, 6);
    assert.equal(status.speaking_request_id, null);
    assert.equal(JSON.stringify(status).includes(KEY), false);
  });
});

test('account-owned Voice Design voices are eligible for explicit speech', async () => {
  await fixture(async ({ connection, calls, events }) => {
    await linked(connection);
    await connection.handle('setGenerationEnabled', { enabled: true, characterBudget: 12 });
    const accepted = await connection.handle('speak', { request_id: REQUEST, text: 'Hello.' });
    assert.equal(accepted.accepted, true);
    await until(() => events.some(event => event.type === 'end'));
    const status = await connection.handle('status');
    assert.equal(status.voices[0].category, 'generated');
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  }, { category: 'generated' });
});

test('account-local custom voice clones are eligible for explicit speech', async () => {
  await fixture(async ({ connection, calls, events }) => {
    await linked(connection);
    await connection.handle('setGenerationEnabled', { enabled: true, characterBudget: 12 });
    const accepted = await connection.handle('speak', { request_id: REQUEST, text: 'Hello.' });
    assert.equal(accepted.accepted, true);
    await until(() => events.some(event => event.type === 'end'));
    const status = await connection.handle('status');
    assert.equal(status.voices[0].category, 'cloned');
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  }, { category: 'cloned' });
});

test('professional, shared and unknown categories fail fresh preflight before synthesis', async () => {
  for (const blockedCategory of ['professional', 'shared', 'unrecognized']) {
    let currentCategory = 'premade';
    await fixture(async ({ connection, calls }) => {
      await linked(connection);
      await connection.handle('setGenerationEnabled', { enabled: true, characterBudget: 20 });
      currentCategory = blockedCategory;
      await assert.rejects(connection.handle('speak', { request_id: REQUEST, text: 'Hello.' }),
        { code: 'voice_not_eligible' });
      assert.equal(calls.some(call => call.options.method === 'POST'), false);
    }, { category: () => currentCategory });
  }
});

test('voices outside premade, generated and cloned are omitted from usable settings metadata', async () => {
  await fixture(async ({ connection, calls }) => {
    await connection.handle('connect', { apiKey: KEY });
    const status = await connection.handle('status');
    assert.deepEqual(status.voices, []);
    await assert.rejects(connection.handle('selectVoice', { voiceId: VOICE }), { code: 'invalid_voice' });
    assert.equal(calls.some(call => call.options.method === 'POST'), false);
  }, { category: 'shared' });
});

test('unknown spending remains blocked independently of generated voice eligibility', async () => {
  await fixture(async ({ connection, calls }) => {
    await linked(connection);
    await assert.rejects(connection.handle('setGenerationEnabled', { enabled: true, characterBudget: 20 }),
      { code: 'spending_blocked' });
    assert.equal(calls.some(call => call.options.method === 'POST'), false);
  }, { category: 'generated', overage: null });
});

test('cancel and disable interrupt a stalled stream without refunding uncertain spend', async () => {
  await fixture(async ({ connection, events, calls }) => {
    await linked(connection);
    await connection.handle('setGenerationEnabled', { enabled: true, characterBudget: 12 });
    await connection.handle('speak', { request_id: REQUEST, text: 'Hello.' });
    await until(() => events.some(event => event.type === 'start'));
    const disabled = await connection.handle('setGenerationEnabled', { enabled: false });
    assert.equal(disabled.generation_enabled, false);
    assert.equal(disabled.remaining_session_characters, 6);
    assert.equal(disabled.reserved_session_credits, 6);
    assert.deepEqual(events.map(event => event.type), ['start', 'cancelled']);
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  }, { stall: true });
});

test('request-scoped cancellation ignores a stale ID and stops the matching stream', async () => {
  await fixture(async ({ connection, events }) => {
    await linked(connection);
    await connection.handle('setGenerationEnabled', { enabled: true, characterBudget: 12 });
    await connection.handle('speak', { request_id: REQUEST, text: 'Hello.' });
    await until(() => events.some(event => event.type === 'start'));
    await connection.handle('cancelSpeech', { request_id: '20000000-0000-4000-8000-000000000002' });
    assert.equal((await connection.handle('status')).speaking_request_id, REQUEST);
    await connection.handle('cancelSpeech', { request_id: REQUEST });
    assert.equal((await connection.handle('status')).speaking_request_id, null);
    assert.deepEqual(events.map(event => event.type), ['start', 'cancelled']);
  }, { stall: true });
});
