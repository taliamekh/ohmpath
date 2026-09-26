const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareClipboardPhoto } = require('../../apps/desktop/src/main/photo-clipboard.cjs');
const { dimensions } = require('../../apps/desktop/src/main/reviewed-image.cjs');

function png(width, height, length = 33) {
  const bytes = Buffer.alloc(length);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpeg(width, height) {
  const sof = Buffer.from([0xff, 0xc0, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0]);
  const scan = Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0xff, 0xd9]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, scan]);
}

function image(width, height, overrides = {}) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    resize: ({ width: nextWidth, height: nextHeight }) => image(nextWidth, nextHeight),
    toBitmap: () => Buffer.alloc(width * height * 4),
    toPNG: () => png(width, height),
    toJPEG: () => jpeg(width, height),
    ...overrides,
  };
}

test('clipboard is read only on explicit call, exactly once, and only as an image', () => {
  const calls = [];
  const clipboard = {
    readImage() { calls.push('readImage'); return image(12, 8, { toPNG() { throw new Error('Do not forward source encoding.'); } }); },
    readText() { throw new Error('Clipboard text must stay unread.'); },
    read() { throw new Error('Clipboard files must stay unread.'); },
    clear() { throw new Error('Clipboard must remain unchanged.'); },
    writeImage() { throw new Error('Clipboard must remain unchanged.'); },
  };
  const native = { createFromBitmap: (_bitmap, shape) => image(shape.width, shape.height) };
  assert.deepEqual(calls, []);
  const result = prepareClipboardPhoto(clipboard, native);
  assert.deepEqual(calls, ['readImage']);
  assert.deepEqual({ width: result.width, height: result.height, resized: result.resized },
    { width: 12, height: 8, resized: false });
  assert.deepEqual(dimensions(result.bytes), { width: 12, height: 8 });
});

test('empty and oversized native images fail before copying or encoding pixels', () => {
  let encodes = 0;
  const forbidden = (width, height) => image(width, height, {
    resize() { throw new Error('Resize must not run.'); },
    toBitmap() { encodes++; throw new Error('Pixel copy must not run.'); },
    toPNG() { encodes++; throw new Error('Encode must not run.'); },
  });
  const native = { createFromBitmap() { encodes++; throw new Error('Native encode must not run.'); } };
  for (const source of [null, { isEmpty: () => true }, forbidden(8193, 1), forbidden(8192, 8192)]) {
    const clipboard = { readImage: () => source };
    assert.throws(() => prepareClipboardPhoto(clipboard, native), /image|Paste/);
  }
  assert.equal(encodes, 0);
});

test('large clipboard bitmap is resized before copying pixels and keeps original dimensions', () => {
  let resizedTo;
  let copiedShape;
  const source = image(4000, 3000, {
    resize({ width, height }) { resizedTo = { width, height }; return image(width, height); },
    toBitmap() { throw new Error('Full-size bitmap must not be copied.'); },
  });
  const native = { createFromBitmap(bitmap, shape) {
    copiedShape = shape;
    assert.equal(bitmap.length, shape.width * shape.height * 4);
    return image(shape.width, shape.height);
  } };
  const result = prepareClipboardPhoto({ readImage: () => source }, native);
  assert.deepEqual(resizedTo, { width: 2400, height: 1800 });
  assert.deepEqual(copiedShape, resizedTo);
  assert.deepEqual({ originalWidth: result.originalWidth, originalHeight: result.originalHeight,
    width: result.width, height: result.height, resized: result.resized },
  { originalWidth: 4000, originalHeight: 3000, width: 2400, height: 1800, resized: true });
  assert.ok(result.bytes.length <= 2_000_000);
});

test('large PNG uses the reviewed upload reducer without forwarding clipboard encoding', () => {
  let jpegQuality;
  let decoded = 0;
  const clean = image(100, 50, {
    toPNG: () => png(100, 50, 2_000_001),
    toJPEG(quality) { jpegQuality = quality; return jpeg(100, 50); },
  });
  const native = {
    createFromBitmap: () => clean,
    createFromBuffer() { decoded++; return image(100, 50); },
  };
  const result = prepareClipboardPhoto({ readImage: () => image(100, 50) }, native);
  assert.equal(jpegQuality, 85);
  assert.equal(decoded, 1);
  assert.deepEqual(dimensions(result.bytes), { width: 100, height: 50 });
  assert.equal(result.bytes.length <= 2_000_000, true);
  assert.deepEqual({ originalWidth: result.originalWidth, originalHeight: result.originalHeight },
    { originalWidth: 100, originalHeight: 50 });
});
