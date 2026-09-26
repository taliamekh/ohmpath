const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dimensions, prepareReviewedImage } = require('../../apps/desktop/src/main/reviewed-image.cjs');

function header(width, height) {
  const data = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
  data.writeUInt32BE(13, 8); data.write('IHDR', 12); data.writeUInt32BE(width, 16); data.writeUInt32BE(height, 20);
  return data;
}
test('reviewed images reject oversized declared dimensions before native decoding', () => {
  let called = false;
  assert.throws(() => prepareReviewedImage(header(100000, 100000), { createFromBuffer() { called = true; } }));
  assert.equal(called, false);
  assert.throws(() => dimensions(Buffer.alloc(2000001)));
  assert.throws(() => dimensions(Buffer.from('not a bitmap')));
});
test('reviewed images send only newly encoded pixel output and reject decode mismatch', () => {
  const source = Buffer.concat([header(10, 10), Buffer.from('PRIVATE-EXIF')]);
  const native = { createFromBuffer() { return { isEmpty: () => false, getSize: () => ({ width: 10, height: 10 }), toPNG: () => header(10, 10) }; } };
  const encoded = prepareReviewedImage(source, native);
  assert.deepEqual(Buffer.from(encoded, 'base64'), header(10, 10));
  assert.equal(Buffer.from(encoded, 'base64').includes(Buffer.from('PRIVATE-EXIF')), false);
  const mismatched = { createFromBuffer() { return { isEmpty: () => false, getSize: () => ({ width: 30, height: 10 }) }; } };
  assert.throws(() => prepareReviewedImage(source, mismatched));
});
