const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync('apps/desktop/src/renderer/overhead-alignment.ts', 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
}}).outputText;
const context = {exports: {}, Math, Number, Uint8Array, Float64Array};
vm.runInNewContext(compiled, context);
const {estimateOverheadTilt} = context.exports;

function board(degrees, blocked = false, width = 320, height = 240, halfWidth = 110, halfHeight = 73) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const angle = degrees * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = (x - width / 2) * cos + (y - height / 2) * sin;
    const v = -(x - width / 2) * sin + (y - height / 2) * cos;
    let value = 75;
    if (Math.abs(u) < halfWidth && Math.abs(v) < halfHeight) {
      value = 155;
      if (Math.abs(u % 30) < 2 || Math.abs(v % 24) < 2) value = 245;
    }
    if (blocked && x > 85 && x < 235) value = 75;
    const offset = (y * width + x) * 4;
    pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = value;
    pixels[offset + 3] = 255;
  }
  return {pixels, width, height};
}

test('straightens a clear board tilted in either direction', () => {
  for (const expected of [-16, 0, 17]) {
    const sample = board(expected);
    const found = estimateOverheadTilt(sample.pixels, sample.width, sample.height);
    assert.notEqual(found, null);
    assert.ok(Math.abs(found - expected) <= 5, `${expected}: ${found}`);
  }
});

test('keeps the raw view when the board angle is unavailable', () => {
  const sample = board(12);
  sample.pixels.fill(80);
  assert.equal(estimateOverheadTilt(sample.pixels, sample.width, sample.height), null);
  assert.equal(estimateOverheadTilt(sample.pixels, 0, sample.height), null);
});

test('finds a smaller board in a portrait overhead frame', () => {
  const sample = board(13, false, 270, 480, 70, 57);
  const found = estimateOverheadTilt(sample.pixels, sample.width, sample.height);
  assert.notEqual(found, null);
  assert.ok(Math.abs(found - 13) <= 5, `portrait board: ${found}`);
});

test('does not rotate toward a lone angled cable', () => {
  const width = 320, height = 240, pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = Math.abs(y - (.3 * x + 45)) < 4 ? 220 : 75;
    const offset = (y * width + x) * 4;
    pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = value;
    pixels[offset + 3] = 255;
  }
  assert.equal(estimateOverheadTilt(pixels, width, height), null);
});
