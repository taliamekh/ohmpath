'use strict';

// Main-process credential and metadata adapter. Deliberately has no synthesis API.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const API = 'https://api.elevenlabs.io';
const ENDPOINTS = Object.freeze([
  '/v1/user/subscription',
  '/v2/voices?page_size=100',
  '/v1/models',
]);
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_STORE_BYTES = 512 * 1024;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, max = 120) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '';
}

function safeCount(value) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function sanitizeSubscription(value) {
  if (!isRecord(value)) throw failure('provider_metadata_invalid');
  const extension = safeCount(value.max_credit_limit_extension);
  return {
    tier: cleanText(value.tier, 50),
    character_count: safeCount(value.character_count),
    character_limit: safeCount(value.character_limit),
    max_credit_limit_extension: extension,
    overage_status: extension === 0 ? 'disabled' : extension === null ? 'unknown' : 'enabled',
  };
}

function sanitizeVoices(value) {
  if (!isRecord(value) || !Array.isArray(value.voices)) throw failure('provider_metadata_invalid');
  const seen = new Set();
  return value.voices.slice(0, 100).flatMap(voice => {
    if (!isRecord(voice) || typeof voice.voice_id !== 'string'
        || !/^[A-Za-z0-9_-]{8,128}$/.test(voice.voice_id) || seen.has(voice.voice_id)) return [];
    seen.add(voice.voice_id);
    return [{ voice_id: voice.voice_id, name: cleanText(voice.name), category: cleanText(voice.category, 40) }];
  });
}

function sanitizeModels(value) {
  if (!Array.isArray(value)) throw failure('provider_metadata_invalid');
  return value.slice(0, 100).flatMap(model => isRecord(model) && typeof model.model_id === 'string'
    && /^[A-Za-z0-9_-]{2,128}$/.test(model.model_id) ? [{ model_id: model.model_id, name: cleanText(model.name) }] : []);
}

async function boundedJson(response, controller) {
  if (!response || !response.ok) throw failure(response?.status === 401 || response?.status === 403
    ? 'credential_rejected' : 'provider_unavailable');
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw failure('provider_metadata_invalid');
  let chunks = [];
  let total = 0;
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { controller.abort(); throw failure('provider_metadata_invalid'); }
      chunks.push(Buffer.from(value));
    }
  } else if (response.body && Symbol.asyncIterator in Object(response.body)) {
    for await (const value of response.body) {
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { controller.abort(); throw failure('provider_metadata_invalid'); }
      chunks.push(Buffer.from(value));
    }
  } else {
    // Response stubs can omit a stream; production fetch supplies one.
    const value = await response.text();
    if (Buffer.byteLength(value) > MAX_RESPONSE_BYTES) throw failure('provider_metadata_invalid');
    chunks = [Buffer.from(value)];
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw failure('provider_metadata_invalid'); }
}

function createElevenLabsConnection({ safeStorage, filePath, fetchImpl = global.fetch }) {
  if (!path.isAbsolute(filePath || '')) throw new TypeError('An absolute credential path is required.');
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  let queue = Promise.resolve();

  function encryptionAvailable() {
    try { return Boolean(safeStorage?.isEncryptionAvailable?.()); }
    catch { return false; }
  }

  async function readStore() {
    if (!encryptionAvailable()) return { kind: 'unavailable' };
    try {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE_BYTES) return { kind: 'unavailable' };
      const encrypted = await fs.readFile(filePath);
      const decoded = JSON.parse(safeStorage.decryptString(encrypted));
      if (decoded.version !== 1 || typeof decoded.apiKey !== 'string'
          || !/^[A-Za-z0-9_-]{16,256}$/.test(decoded.apiKey)
          || !isRecord(decoded.subscription) || !Array.isArray(decoded.voices)
          || !Array.isArray(decoded.models)) return { kind: 'unavailable' };
      const value = {
        version: 1, apiKey: decoded.apiKey,
        subscription: sanitizeSubscription(decoded.subscription),
        voices: sanitizeVoices({ voices: decoded.voices }),
        models: sanitizeModels(decoded.models),
        metadataCheckedAt: typeof decoded.metadataCheckedAt === 'string' && !Number.isNaN(Date.parse(decoded.metadataCheckedAt))
          ? new Date(decoded.metadataCheckedAt).toISOString() : null,
        selectedVoiceId: decoded.selectedVoiceId,
      };
      if (!value.voices.some(voice => voice.voice_id === value.selectedVoiceId)) value.selectedVoiceId = null;
      if (JSON.stringify({ ...value, apiKey: undefined }).includes(value.apiKey)) return { kind: 'unavailable' };
      return { kind: 'connected', value };
    } catch (error) {
      if (error?.code === 'ENOENT') return { kind: 'disconnected' };
      return { kind: 'unavailable' };
    }
  }

  async function writeStore(value) {
    if (!encryptionAvailable()) throw failure('secure_storage_unavailable');
    let encrypted;
    try { encrypted = safeStorage.encryptString(JSON.stringify(value)); }
    catch { throw failure('secure_storage_unavailable'); }
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || encrypted.length > MAX_STORE_BYTES)
      throw failure('secure_storage_unavailable');
    const directory = path.dirname(filePath);
    const temporary = path.join(directory, `.${path.basename(filePath)}.${randomBytes(8).toString('hex')}.tmp`);
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, filePath);
    } catch {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw failure('secure_storage_unavailable');
    }
  }

  function view(result) {
    const base = { connected: false, storage_status: result.kind, generation_enabled: false,
      generation_tested: false, selected_voice_id: null, subscription: null, voices: [], models: [],
      metadata_checked_at: null, spending_blocked: true };
    if (result.kind !== 'connected') return base;
    const value = result.value;
    return { ...base, connected: true, storage_status: 'ready',
      selected_voice_id: value.selectedVoiceId || null, subscription: value.subscription,
      voices: value.voices, models: value.models, metadata_checked_at: value.metadataCheckedAt,
      spending_blocked: value.subscription.overage_status !== 'disabled' };
  }

  async function getMetadata(apiKey) {
    const results = [];
    for (const endpoint of ENDPOINTS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetchImpl(API + endpoint, {
          method: 'GET', headers: { 'xi-api-key': apiKey, Accept: 'application/json' },
          redirect: 'error', signal: controller.signal,
        });
        results.push(await boundedJson(response, controller));
      } catch (error) {
        if (error?.code === 'credential_rejected' || error?.code === 'provider_metadata_invalid') throw error;
        throw failure('provider_unavailable');
      } finally { clearTimeout(timer); }
    }
    const metadata = { subscription: sanitizeSubscription(results[0]), voices: sanitizeVoices(results[1]),
      models: sanitizeModels(results[2]), metadataCheckedAt: new Date().toISOString() };
    if (JSON.stringify(metadata).includes(apiKey)) throw failure('provider_metadata_invalid');
    return metadata;
  }

  async function dispatch(action, payload) {
    if (!isRecord(payload)) throw failure('invalid_request');
    if (action === 'status') return view(await readStore());
    if (action === 'connect') {
      const apiKey = payload.apiKey;
      if (typeof apiKey !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(apiKey)) throw failure('invalid_credential');
      if (!encryptionAvailable()) throw failure('secure_storage_unavailable');
      const metadata = await getMetadata(apiKey);
      const value = { version: 1, apiKey, ...metadata, selectedVoiceId: null };
      await writeStore(value);
      return view({ kind: 'connected', value });
    }
    if (action === 'refresh') {
      const current = await readStore();
      if (current.kind !== 'connected') throw failure('connection_unavailable');
      const metadata = await getMetadata(current.value.apiKey);
      const selectedVoiceId = metadata.voices.some(voice => voice.voice_id === current.value.selectedVoiceId)
        ? current.value.selectedVoiceId : null;
      const value = { version: 1, apiKey: current.value.apiKey, ...metadata, selectedVoiceId };
      await writeStore(value);
      return view({ kind: 'connected', value });
    }
    if (action === 'selectVoice') {
      if (typeof payload.voiceId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(payload.voiceId))
        throw failure('invalid_voice');
      const current = await readStore();
      if (current.kind !== 'connected') throw failure('connection_unavailable');
      if (!current.value.voices.some(voice => voice.voice_id === payload.voiceId)) throw failure('invalid_voice');
      const value = { ...current.value, selectedVoiceId: payload.voiceId };
      await writeStore(value);
      return view({ kind: 'connected', value });
    }
    if (action === 'disconnect') {
      try { await fs.rm(filePath, { force: true }); }
      catch { throw failure('secure_storage_unavailable'); }
      return view({ kind: 'disconnected' });
    }
    throw failure('unsupported_action');
  }

  return {
    handle(action, payload = {}) {
      const operation = queue.then(() => dispatch(action, payload));
      queue = operation.catch(() => {});
      return operation;
    },
  };
}

module.exports = { createElevenLabsConnection };
