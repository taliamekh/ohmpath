'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createElevenLabsConnection } = require('../../apps/desktop/src/main/elevenlabs.cjs');

const KEY = 'testKey_1234567890123456';
const VOICE = 'voice_12345678';
const URLS = [
  'https://api.elevenlabs.io/v1/user/subscription',
  'https://api.elevenlabs.io/v2/voices?page_size=100',
  'https://api.elevenlabs.io/v1/models',
];

function safeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: text => Buffer.from(text, 'utf8').map(byte => byte ^ 0xa5),
    decryptString: bytes => Buffer.from(bytes).map(byte => byte ^ 0xa5).toString('utf8'),
  };
}

function stubFetch(calls, extension = 0) {
  const bodies = [
    { tier: 'free', character_count: 23, character_limit: 1000, max_credit_limit_extension: extension },
    { voices: [{ voice_id: VOICE, name: 'Approved voice', category: 'premade' }] },
    [{ model_id: 'eleven_flash_v2_5', name: 'Flash' }],
  ];
  return async (url, options) => {
    calls.push({ url, options });
    const index = URLS.indexOf(url);
    assert.notEqual(index, -1, 'unexpected provider endpoint');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['xi-api-key'], KEY);
    assert.equal(options.body, undefined);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(bodies[index]) };
  };
}

async function fixture(run, fetchImpl = async () => { throw Error('network call forbidden'); }, storage = safeStorage()) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ohmpath-elevenlabs-test-'));
  const filePath = path.join(directory, 'elevenlabs.enc');
  try {
    const connection = createElevenLabsConnection({ safeStorage: storage, filePath, fetchImpl });
    await run({ connection, filePath });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('status is local and discloses no credential', async () => {
  await fixture(async ({ connection }) => {
    const status = await connection.handle('status');
    assert.equal(status.connected, false);
    assert.equal(status.storage_status, 'disconnected');
    assert.equal(status.generation_enabled, false);
    assert.equal(status.generation_tested, false);
    assert.equal(JSON.stringify(status).includes(KEY), false);
  });
});

test('connect uses only three metadata GETs, encrypts key, and requires explicit voice selection', async () => {
  const calls = [];
  await fixture(async ({ connection, filePath }) => {
    const status = await connection.handle('connect', { apiKey: KEY });
    assert.deepEqual(calls.map(call => call.url), URLS);
    assert.equal(status.connected, true);
    assert.equal(status.selected_voice_id, null);
    assert.equal(status.spending_blocked, false);
    assert.equal(status.subscription.overage_status, 'disabled');
    assert.equal(status.voices[0].voice_id, VOICE);
    assert.equal(JSON.stringify(status).includes(KEY), false);
    assert.equal((await fs.readFile(filePath)).includes(Buffer.from(KEY)), false);
    const selected = await connection.handle('selectVoice', { voiceId: VOICE });
    assert.equal(selected.selected_voice_id, VOICE);
    assert.equal((await connection.handle('status')).selected_voice_id, VOICE);
    const disconnected = await connection.handle('disconnect');
    assert.equal(disconnected.connected, false);
    assert.equal((await connection.handle('status')).connected, false);
  }, stubFetch(calls));
});

test('overage enabled or unknown blocks spending, and arbitrary voices are rejected', async () => {
  for (const extension of [1000, null]) {
    const calls = [];
    await fixture(async ({ connection }) => {
      const status = await connection.handle('connect', { apiKey: KEY });
      assert.equal(status.spending_blocked, true);
      assert.equal(status.subscription.overage_status, extension === null ? 'unknown' : 'enabled');
      await assert.rejects(connection.handle('selectVoice', { voiceId: 'other_12345678' }), { code: 'invalid_voice' });
    }, stubFetch(calls, extension));
  }
});

test('invalid credentials, provider errors, and unsupported generation leak no secrets', async () => {
  const rawError = `provider rejected ${KEY}`;
  await fixture(async ({ connection, filePath }) => {
    for (const [action, payload, code] of [
      ['connect', { apiKey: ` ${KEY}` }, 'invalid_credential'],
      ['generate', { text: 'Hello' }, 'unsupported_action'],
      ['speak', { text: 'Hello' }, 'unsupported_action'],
      ['connect', { apiKey: KEY }, 'provider_unavailable'],
    ]) {
      await assert.rejects(connection.handle(action, payload), error => {
        assert.equal(error.code, code);
        assert.equal(String(error).includes(KEY), false);
        assert.equal(String(error).includes(rawError), false);
        return true;
      });
    }
    await assert.rejects(fs.access(filePath), { code: 'ENOENT' });
  }, async () => { throw Error(rawError); });
});

test('corrupt or unavailable secure storage stays unavailable without network', async () => {
  await fixture(async ({ connection, filePath }) => {
    await fs.writeFile(filePath, 'corrupt encrypted bytes');
    const status = await connection.handle('status');
    assert.equal(status.storage_status, 'unavailable');
    assert.equal(status.connected, false);
  });
  await fixture(async ({ connection }) => {
    const status = await connection.handle('status');
    assert.equal(status.storage_status, 'unavailable');
    await assert.rejects(connection.handle('connect', { apiKey: KEY }), { code: 'secure_storage_unavailable' });
  }, async () => { throw Error('network call forbidden'); }, { isEncryptionAvailable: () => false });
});

test('serialized connect and disconnect cannot resurrect a credential', async () => {
  const calls = [];
  await fixture(async ({ connection }) => {
    const connecting = connection.handle('connect', { apiKey: KEY });
    const disconnecting = connection.handle('disconnect');
    await connecting;
    await disconnecting;
    assert.equal((await connection.handle('status')).connected, false);
  }, stubFetch(calls));
});
