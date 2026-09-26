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
replaceOnce('audit.captures.push({ source: payload.source, captured_at: payload.captured_at, length: payload.data_url.length });', `
    const captureImage = require('electron').nativeImage.createFromDataURL(payload.data_url);
    const captureSize = captureImage.getSize();
    if (captureSize.width !== 640 || captureSize.height !== 360) throw new Error('Unexpected replay snapshot dimensions.');
    const bitmap = captureImage.toBitmap();
    const offset = (Math.floor(captureSize.height / 2) * captureSize.width + Math.floor(captureSize.width / 2)) * 4;
    if (bitmap.length < offset + 4) throw new Error('Could not decode replay snapshot pixels.');
    // Electron's Windows bitmap bytes are BGRA. Record only this one RGB pixel.
    audit.snapshotPixels ??= [];
    audit.snapshotPixels.push({ source: payload.source, r: bitmap[offset + 2], g: bitmap[offset + 1], b: bitmap[offset] });
    audit.captures.push({ source: payload.source, captured_at: payload.captured_at, length: payload.data_url.length });`);

const replay = new Module(fixturePath, module);
replay.filename = fixturePath;
replay.paths = Module._nodeModulePaths(__dirname);
replay._compile(source, fixturePath);
