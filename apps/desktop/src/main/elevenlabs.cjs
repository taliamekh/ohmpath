'use strict';

// Main-process credential, metadata, and explicitly gated speech adapter.
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
const SPEECH_MODEL = 'eleven_flash_v2_5';
const SPEECH_FORMAT = 'pcm_24000';
const MAX_SPEECH_CHARACTERS = 1000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const AUDIO_EVENT_BYTES = 48 * 1024;
const MIN_AUDIO_EVENT_BYTES = 4096;
const SPEECH_TIMEOUT_MS = 90000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    && /^[A-Za-z0-9_-]{2,128}$/.test(model.model_id) ? [{
      model_id: model.model_id, name: cleanText(model.name),
      can_do_text_to_speech: model.can_do_text_to_speech === true,
      maximum_text_length_per_request: safeCount(model.maximum_text_length_per_request),
      character_cost_multiplier: (() => {
        const rate = model.model_rates?.character_cost_multiplier ?? model.character_cost_multiplier;
        return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 && rate <= 100 ? rate : null;
      })(),
    }] : []);
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

function createElevenLabsConnection({ safeStorage, filePath, fetchImpl = global.fetch, onSpeechEvent = () => {} }) {
  if (!path.isAbsolute(filePath || '')) throw new TypeError('An absolute credential path is required.');
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  if (typeof onSpeechEvent !== 'function') throw new TypeError('A speech event callback is required.');
  let queue = Promise.resolve();
  let generationEnabled = false;
  let sessionCharacterBudget = null;
  let reservedCharacters = 0;
  let reservedCredits = 0;
  const usedSpeechIds = new Set();
  let lastError = null;
  let activeSpeech = null;
  const pendingSpeechIds = new Set();
  let cancellationEpoch = 0;

  function emit(event) {
    try { onSpeechEvent(event); } catch { /* Renderer delivery cannot change the spending gate. */ }
  }

  function cancelActive(requestId) {
    if (requestId && activeSpeech?.request_id !== requestId && !pendingSpeechIds.has(requestId)) return false;
    cancellationEpoch += 1;
    if (!activeSpeech) return false;
    if (requestId && activeSpeech.request_id !== requestId) return true;
    const speech = activeSpeech;
    activeSpeech = null;
    speech.controller.abort();
    emit({ type: 'cancelled', request_id: speech.request_id });
    return true;
  }

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
      metadata_checked_at: null, spending_blocked: true,
      remaining_session_characters: sessionCharacterBudget === null ? 0
        : Math.max(0, sessionCharacterBudget - reservedCharacters),
      reserved_session_credits: reservedCredits,
      remaining_session_credits: sessionCharacterBudget === null ? 0 : Math.max(0, sessionCharacterBudget - reservedCredits),
      provider_remaining_credits: null,
      speaking_request_id: activeSpeech?.request_id || null, last_error: lastError };
    if (result.kind !== 'connected') return base;
    const value = result.value;
    return { ...base, connected: true, storage_status: 'ready',
      selected_voice_id: value.selectedVoiceId || null, subscription: value.subscription,
      voices: value.voices, models: value.models.map(({ model_id, name }) => ({ model_id, name })),
      metadata_checked_at: value.metadataCheckedAt,
      generation_enabled: generationEnabled,
      provider_remaining_credits: value.subscription.character_count === null
        || value.subscription.character_limit === null ? null
        : Math.max(0, value.subscription.character_limit - value.subscription.character_count),
      spending_blocked: value.subscription.overage_status !== 'disabled' };
  }

  async function streamSpeech(speech, apiKey, voiceId, text) {
    const timer = setTimeout(() => speech.controller.abort(), SPEECH_TIMEOUT_MS);
    try {
      const url = `${API}/v1/text-to-speech/${voiceId}/stream?output_format=${SPEECH_FORMAT}`;
      const response = await fetchImpl(url, {
        method: 'POST', redirect: 'error', signal: speech.controller.signal,
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/pcm' },
        body: JSON.stringify({ text, model_id: SPEECH_MODEL,
          voice_settings: { stability: 0.7, similarity_boost: 0.75, style: 0, use_speaker_boost: false, speed: 0.95 } }),
      });
      if (activeSpeech !== speech) return;
      if (response?.redirected || (response?.url && response.url !== url)) throw failure('speech_provider_unavailable');
      if (!response?.ok) throw failure(response?.status === 401 || response?.status === 403
        ? 'credential_rejected' : 'speech_provider_unavailable');
      const contentType = String(response.headers?.get?.('content-type') || '').split(';', 1)[0].trim().toLowerCase();
      if (!['audio/pcm', 'audio/raw', 'audio/x-raw', 'application/octet-stream'].includes(contentType))
        throw failure('speech_format_invalid');
      const declared = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) throw failure('speech_too_large');
      if (!response.body || typeof response.body.getReader !== 'function') throw failure('speech_stream_invalid');
      emit({ type: 'start', request_id: speech.request_id, sample_rate: 24000, format: 'pcm_s16le' });
      const reader = response.body.getReader();
      let total = 0;
      let pending = Buffer.alloc(0);
      while (true) {
        const { done, value } = await reader.read();
        if (activeSpeech !== speech) return;
        if (done) break;
        if (!(value instanceof Uint8Array)) throw failure('speech_stream_invalid');
        total += value.byteLength;
        if (total > MAX_AUDIO_BYTES) throw failure('speech_too_large');
        pending = Buffer.concat([pending, Buffer.from(value)]);
        while (pending.length >= MIN_AUDIO_EVENT_BYTES) {
          const size = Math.min(AUDIO_EVENT_BYTES, pending.length - (pending.length % 2));
          emit({ type: 'chunk', request_id: speech.request_id,
            sample_rate: 24000, pcm_base64: pending.subarray(0, size).toString('base64') });
          pending = pending.subarray(size);
          if (activeSpeech !== speech) return;
        }
      }
      if (pending.length % 2 || total === 0) throw failure('speech_stream_invalid');
      if (pending.length) emit({ type: 'chunk', request_id: speech.request_id,
        sample_rate: 24000, pcm_base64: pending.toString('base64') });
      activeSpeech = null;
      emit({ type: 'end', request_id: speech.request_id });
    } catch (error) {
      if (activeSpeech !== speech) return;
      activeSpeech = null;
      const safeCodes = new Set(['credential_rejected', 'speech_provider_unavailable', 'speech_format_invalid',
        'speech_too_large', 'speech_stream_invalid']);
      lastError = safeCodes.has(error?.code) ? error.code
        : speech.controller.signal.aborted ? 'speech_timeout' : 'speech_provider_unavailable';
      emit({ type: 'error', request_id: speech.request_id, error: lastError });
    } finally { clearTimeout(timer); }
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

  async function dispatch(action, payload, expectedEpoch) {
    if (!isRecord(payload)) throw failure('invalid_request');
    if (action === 'status') return view(await readStore());
    if (action === 'setGenerationEnabled') {
      if (typeof payload.enabled !== 'boolean') throw failure('invalid_request');
      if (!payload.enabled) {
        generationEnabled = false;
        return view(await readStore());
      }
      if (expectedEpoch !== cancellationEpoch) throw failure('speech_cancelled');
      if (!Number.isSafeInteger(payload.characterBudget) || payload.characterBudget < 1
          || payload.characterBudget > MAX_SPEECH_CHARACTERS) throw failure('invalid_budget');
      const current = await readStore();
      if (expectedEpoch !== cancellationEpoch) throw failure('speech_cancelled');
      if (current.kind !== 'connected') throw failure('connection_unavailable');
      if (current.value.subscription.overage_status !== 'disabled') throw failure('spending_blocked');
      sessionCharacterBudget = sessionCharacterBudget === null ? payload.characterBudget
        : Math.min(sessionCharacterBudget, payload.characterBudget);
      generationEnabled = true;
      lastError = null;
      return view(current);
    }
    if (action === 'speak') {
      if (!generationEnabled) throw failure('unsupported_action');
      const epoch = expectedEpoch;
      if (epoch !== cancellationEpoch) throw failure('speech_cancelled');
      const requestId = payload.request_id;
      const text = payload.text;
      if (typeof requestId !== 'string' || !UUID.test(requestId)
          || typeof text !== 'string' || !text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
          || text.length > MAX_SPEECH_CHARACTERS) throw failure('invalid_speech_request');
      if (usedSpeechIds.has(requestId)) throw failure('speech_request_already_used');
      if (activeSpeech) throw failure('speech_busy');
      const current = await readStore();
      if (epoch !== cancellationEpoch || !generationEnabled) throw failure('speech_cancelled');
      if (current.kind !== 'connected') throw failure('connection_unavailable');
      const metadata = await getMetadata(current.value.apiKey);
      if (epoch !== cancellationEpoch || !generationEnabled) throw failure('speech_cancelled');
      if (metadata.subscription.overage_status !== 'disabled') throw failure('spending_blocked');
      const voice = metadata.voices.find(item => item.voice_id === current.value.selectedVoiceId);
      if (!voice || voice.category !== 'premade') throw failure('voice_not_eligible');
      const model = metadata.models.find(item => item.model_id === SPEECH_MODEL);
      if (!model || !model.can_do_text_to_speech
          || model.maximum_text_length_per_request === null
          || model.maximum_text_length_per_request < text.length
          || model.character_cost_multiplier === null) throw failure('speech_model_unavailable');
      const creditReservation = Math.ceil(text.length * Math.max(1, model.character_cost_multiplier));
      const count = metadata.subscription.character_count;
      const limit = metadata.subscription.character_limit;
      if (count === null || limit === null || limit - count - reservedCredits < creditReservation)
        throw failure('allowance_insufficient');
      if (sessionCharacterBudget === null || reservedCharacters + text.length > sessionCharacterBudget)
        throw failure('session_budget_exhausted');
      if (reservedCredits + creditReservation > sessionCharacterBudget) throw failure('session_credit_budget_exhausted');
      const updated = { ...current.value, ...metadata, selectedVoiceId: voice.voice_id };
      await writeStore(updated);
      if (epoch !== cancellationEpoch || !generationEnabled) throw failure('speech_cancelled');
      reservedCharacters += text.length;
      reservedCredits += creditReservation;
      usedSpeechIds.add(requestId);
      lastError = null;
      const speech = { request_id: requestId, controller: new AbortController() };
      activeSpeech = speech;
      void streamSpeech(speech, current.value.apiKey, voice.voice_id, text);
      return { accepted: true, request_id: requestId, reserved_credits: creditReservation,
        remaining_session_characters: Math.max(0, sessionCharacterBudget - reservedCharacters) };
    }
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
      if (action === 'cancelSpeech') {
        if (!isRecord(payload) || (payload.request_id !== undefined
            && (typeof payload.request_id !== 'string' || !UUID.test(payload.request_id))))
          return Promise.reject(failure('invalid_request'));
        cancelActive(payload.request_id);
        return readStore().then(view);
      }
      if (action === 'setGenerationEnabled' && isRecord(payload) && payload.enabled === false) {
        generationEnabled = false;
        cancelActive();
      }
      if (action === 'disconnect' || action === 'connect' || action === 'selectVoice') {
        generationEnabled = false;
        cancelActive();
      }
      const expectedEpoch = cancellationEpoch;
      if (action === 'speak' && isRecord(payload) && typeof payload.request_id === 'string'
          && UUID.test(payload.request_id)) pendingSpeechIds.add(payload.request_id);
      const operation = queue.then(() => dispatch(action, payload, expectedEpoch));
      queue = operation.catch(() => {});
      return operation.finally(() => {
        if (action === 'speak') pendingSpeechIds.delete(payload?.request_id);
      });
    },
  };
}

module.exports = { createElevenLabsConnection };
