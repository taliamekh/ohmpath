const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync('apps/desktop/src/renderer/circuit-framing.ts', 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
const context = {exports: {}, Uint8Array, Math, Number};
vm.runInNewContext(compiled, context);
const {suggestCircuitRegion} = context.exports;

function image(width = 360, height = 640, rgb = [178, 169, 150]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = rgb[0]; pixels[i + 1] = rgb[1]; pixels[i + 2] = rgb[2]; pixels[i + 3] = 255;
  }
  return {pixels, width, height};
}

function rectangle(frame, x0, y0, x1, y1, rgb) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const p = (y * frame.width + x) * 4;
    frame.pixels[p] = rgb[0]; frame.pixels[p + 1] = rgb[1]; frame.pixels[p + 2] = rgb[2];
  }
}

function board(frame, x0, y0, x1, y1, light = [229, 228, 218], dark = [95, 96, 89]) {
  rectangle(frame, x0, y0, x1, y1, light);
  for (let y = y0 + 5; y < y1 - 4; y += 8) for (let x = x0 + 5; x < x1 - 4; x += 8) {
    rectangle(frame, x, y, x + 3, y + 3, dark);
  }
}

function contains(region, frame, x0, y0, x1, y1) {
  assert.ok(region, 'expected a framing suggestion');
  assert.ok(region.x * frame.width <= x0);
  assert.ok(region.y * frame.height <= y0);
  assert.ok((region.x + region.width) * frame.width >= x1);
  assert.ok((region.y + region.height) * frame.height >= y1);
}

test('portrait tabletop frames a lower circuit group with useful zoom', () => {
  const frame = image();
  board(frame, 61, 420, 217, 525);
  board(frame, 226, 437, 316, 517, [41, 100, 157], [209, 207, 178]);
  const region = suggestCircuitRegion(frame.pixels, frame.width, frame.height);
  contains(region, frame, 61, 420, 316, 525);
  assert.ok(region.y > 0.5, `unexpected top: ${region.y}`);
  assert.ok(region.height < 0.4, `unexpected crop height: ${region.height}`);
});

test('keeps an adjacent controller across a plain tabletop gap', () => {
  const frame = image();
  board(frame, 36, 391, 173, 502);
  board(frame, 218, 409, 306, 492, [39, 93, 154], [214, 207, 164]);
  const region = suggestCircuitRegion(frame.pixels, frame.width, frame.height);
  contains(region, frame, 36, 391, 306, 502);
});

test('does not depend on blue color for a green or grayscale board', () => {
  for (const [light, dark] of [
    [[33, 112, 61], [192, 204, 177]],
    [[184, 184, 184], [79, 79, 79]],
  ]) {
    const frame = image();
    board(frame, 75, 431, 291, 544, light, dark);
    const region = suggestCircuitRegion(frame.pixels, frame.width, frame.height);
    contains(region, frame, 75, 431, 291, 544);
  }
});

test('rejects blank and very dim scenes', () => {
  const blank = image();
  assert.equal(suggestCircuitRegion(blank.pixels, blank.width, blank.height), null);
  const dim = image(360, 640, [9, 10, 11]);
  assert.equal(suggestCircuitRegion(dim.pixels, dim.width, dim.height), null);
});

test('rejects a lone cable and a scene textured nearly everywhere', () => {
  const cable = image();
  for (let y = 125; y < 530; y++) rectangle(cable, 130 + Math.floor(y / 90), y, 133 + Math.floor(y / 90), y + 1, [32, 32, 32]);
  assert.equal(suggestCircuitRegion(cable.pixels, cable.width, cable.height), null);
  const full = image();
  board(full, 0, 0, full.width, full.height);
  assert.equal(suggestCircuitRegion(full.pixels, full.width, full.height), null);
});

test('rejects frame-wide random noise as uncertain', () => {
  const frame = image();
  let state = 429;
  for (let i = 0; i < frame.pixels.length; i += 4) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    frame.pixels[i] = frame.pixels[i + 1] = frame.pixels[i + 2] = state & 255;
  }
  assert.equal(suggestCircuitRegion(frame.pixels, frame.width, frame.height), null);
});

test('returns no crop for malformed input', () => {
  assert.equal(suggestCircuitRegion(new Uint8ClampedArray(20), 360, 640), null);
  assert.equal(suggestCircuitRegion(new Uint8ClampedArray(20), 0, 0), null);
});
