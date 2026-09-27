const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { speechInstallationEnvironment } = require('../../apps/desktop/src/main/speech-installation.cjs');
const root = join('project', 'ohmpath');
const baseEnv = { LOCALAPPDATA: 'ordinary-local', USERPROFILE: 'ordinary-user' };
const localPrefix = join(root, 'runtime', 'speech-install');

test('complete project-local speech pair is used when ordinary installation is invisible', () => {
  const result = speechInstallationEnvironment(baseEnv, root, path => path.startsWith(localPrefix));
  assert.equal(result.OHMPATH_WHISPER, join(localPrefix, 'tools', 'whisper-b5130', 'Release', 'whisper-server.exe'));
  assert.equal(result.OHMPATH_SPEECH_MODEL, join(localPrefix, 'models', 'ggml-small.en.bin'));
});
test('ordinary complete installation remains first choice', () => {
  assert.deepEqual(speechInstallationEnvironment(baseEnv, root, () => true), {});
});
test('explicit override is not replaced even when missing', () => {
  for (const key of ['OHMPATH_WHISPER', 'OHMPATH_SPEECH_MODEL'])
    assert.deepEqual(speechInstallationEnvironment({ ...baseEnv, [key]: 'missing-explicit' }, root, () => true), {});
});
test('partial fallback pair is never mixed with ordinary files', () => {
  assert.deepEqual(speechInstallationEnvironment(baseEnv, root, path => path.startsWith(localPrefix) && path.endsWith('.exe')), {});
  assert.deepEqual(speechInstallationEnvironment(baseEnv, root, () => false), {});
});
