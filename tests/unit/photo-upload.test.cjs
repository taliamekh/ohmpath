const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MAX_UPLOAD_BYTES, preparePhotoUpload, uploadHeader } = require('../../apps/desktop/src/main/photo-upload.cjs');

function png(width, height, length = 33) {
  const bytes = Buffer.alloc(length);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpeg(width, height, orientation = 1) {
  const exif = Buffer.alloc(32);
  exif.write('Exif\0\0', 0, 'binary');
  exif.write('II', 6);
  exif.writeUInt16LE(42, 8);
  exif.writeUInt32LE(8, 10);
  exif.writeUInt16LE(1, 14);
  exif.writeUInt16LE(0x0112, 16);
  exif.writeUInt16LE(3, 18);
  exif.writeUInt32LE(1, 20);
  exif.writeUInt16LE(orientation, 24);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, exif.length + 2]), exif]);
  const sof = Buffer.from([0xff, 0xc0, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0]);
  const scan = Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0xff, 0xd9]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, scan]);
}

function mockImage(width, height, pngLength = 33) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    resize({ width: nextWidth, height: nextHeight }) { return mockImage(nextWidth, nextHeight, pngLength); },
    toPNG: () => png(width, height, pngLength),
    toJPEG: () => jpeg(width, height),
  };
}

test('headers reject oversized or malformed input before native decoding', () => {
  assert.equal(MAX_UPLOAD_BYTES, 16_000_000);
  let decoded = false;
  const native = { createFromBuffer() { decoded = true; return mockImage(1, 1); } };
  for (const source of [
    Buffer.alloc(MAX_UPLOAD_BYTES + 1), png(8193, 1), png(8192, 8192),
    png(0, 100), Buffer.from('not an image'), jpeg(8193, 1),
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]),
  ]) assert.throws(() => preparePhotoUpload(source, native));
  assert.equal(decoded, false);
});

test('prepared pixels are newly encoded, resized, and bounded', () => {
  const source = png(4000, 3000, 100);
  Buffer.from('PRIVATE-METADATA').copy(source, 60);
  let requestedSize;
  const native = { createFromBuffer() {
    return { ...mockImage(4000, 3000), resize({ width, height }) {
      requestedSize = { width, height };
      return mockImage(width, height);
    } };
  } };
  const result = preparePhotoUpload(source, native);
  assert.deepEqual(requestedSize, { width: 2400, height: 1800 });
  assert.deepEqual({ width: result.width, height: result.height }, requestedSize);
  assert.equal(result.originalWidth, 4000);
  assert.equal(result.originalHeight, 3000);
  assert.equal(result.resized, true);
  assert.equal(result.bytes.length <= 2_000_000, true);
  assert.equal(result.bytes.includes(Buffer.from('PRIVATE-METADATA')), false);
});

test('decoded dimensions must match headers', () => {
  assert.throws(() => preparePhotoUpload(png(100, 50), {
    createFromBuffer: () => mockImage(101, 50),
  }), /inconsistent/);
  assert.deepEqual(uploadHeader(jpeg(100, 50, 6)),
    { width: 100, height: 50, orientation: 6, format: 'jpeg' });
});

test('unrotated EXIF JPEG pixels are rotated before encoding', () => {
  const source = jpeg(2, 3, 6);
  const bitmap = Buffer.alloc(2 * 3 * 4);
  for (let pixel = 0; pixel < 6; pixel += 1) bitmap[pixel * 4] = pixel + 1;
  let oriented;
  let decodeInput;
  const native = {
    createFromBuffer(bytes) {
      decodeInput = bytes;
      return { ...mockImage(2, 3), toBitmap: () => bitmap };
    },
    createFromBitmap(bytes, shape) {
      oriented = { bytes: Buffer.from(bytes), shape };
      return mockImage(shape.width, shape.height);
    },
  };
  const result = preparePhotoUpload(source, native);
  assert.equal(decodeInput.includes(Buffer.from('Exif\0\0')), false,
    'Native decoding must not see the EXIF orientation marker.');
  assert.deepEqual(uploadHeader(decodeInput), { width: 2, height: 3, orientation: 1, format: 'jpeg' });
  assert.deepEqual(oriented.shape, { width: 3, height: 2 });
  assert.deepEqual(Array.from({ length: 6 }, (_, index) => oriented.bytes[index * 4]),
    [5, 3, 1, 6, 4, 2]);
  assert.deepEqual({ width: result.width, height: result.height,
    originalWidth: result.originalWidth, originalHeight: result.originalHeight },
  { width: 3, height: 2, originalWidth: 3, originalHeight: 2 });
});

test('preparation has a fixed reduction limit', () => {
  let encodes = 0;
  const huge = (width, height) => ({
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    resize: ({ width: nextWidth, height: nextHeight }) => huge(nextWidth, nextHeight),
    toPNG() { encodes += 1; return Buffer.alloc(2_000_001); },
    toJPEG() { encodes += 1; return Buffer.alloc(2_000_001); },
  });
  assert.throws(() => preparePhotoUpload(png(2400, 1800), {
    createFromBuffer: () => huge(2400, 1800),
  }));
  assert.equal(encodes, 30);
});
