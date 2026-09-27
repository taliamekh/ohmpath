const { join } = require('node:path');
const fs = require('node:fs');

// A complete project-local installation is a development launch fallback for
// tools installed through a packaged shell whose AppData is virtualized.
// Never override explicit configuration or combine incomplete installations.
function speechInstallationEnvironment(env, root, isFile = path => {
  try { return fs.statSync(path).isFile(); } catch { return false; }
}) {
  if (env.OHMPATH_WHISPER || env.OHMPATH_SPEECH_MODEL) return {};
  const assets = base => ({
    OHMPATH_WHISPER: join(base, 'tools', 'whisper-b5130', 'Release', 'whisper-server.exe'),
    OHMPATH_SPEECH_MODEL: join(base, 'models', 'ggml-small.en.bin'),
  });
  const complete = pair => Object.values(pair).every(isFile);
  if (env.LOCALAPPDATA && complete(assets(join(env.LOCALAPPDATA, 'OhmPath')))) return {};
  if (env.USERPROFILE && complete(assets(join(env.USERPROFILE, 'AppData', 'Local', 'OhmPath')))) return {};
  const local = assets(join(root, 'runtime', 'speech-install'));
  return complete(local) ? local : {};
}

module.exports = { speechInstallationEnvironment };
