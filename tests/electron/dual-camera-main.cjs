// Reuse the offline photo/Pi replay with Pi snapshot import enabled only here.
// This wrapper does not modify the shared fixture or contact a device/service.
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const Module = require('node:module');

const fixturePath = resolve(__dirname, 'photo-help-replay-main.cjs');
let source = readFileSync(fixturePath, 'utf8');
function replaceOnce(before, after) {
  if (source.split(before).length !== 2) throw new Error('Shared replay fixture changed; review the dual-camera adapter.');
  source = source.replace(before, after);
}
replaceOnce("payload.source !== 'overview'", "!['overview', 'pi'].includes(payload.source)");
replaceOnce("image_id: imageIds[2], name: 'Overview snapshot'",
  "image_id: payload.source === 'pi' ? '10000000-0000-4000-8000-000000000004' : imageIds[2], name: payload.source === 'pi' ? 'Pi snapshot' : 'Overview snapshot'");

const replay = new Module(fixturePath, module);
replay.filename = fixturePath;
replay.paths = Module._nodeModulePaths(__dirname);
replay._compile(source, fixturePath);
