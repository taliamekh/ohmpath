const test = require('node:test');
const assert = require('node:assert/strict');
const { createPhotoImages } = require('../../apps/desktop/src/main/photo-images.cjs');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a31kAAAAASUVORK5CYII=', 'base64');
const decoder = { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => png }) };

test('only selected, still retained images can be sent to photo help', () => {
  const store = createPhotoImages(decoder);
  const image = store.add(png, 'test\nimage.png');
  assert.equal(image.name, 'testimage.png');
  assert.deepEqual(Object.keys(store.selected([image.image_id])[0]).sort(), ['image_base64', 'image_id', 'mime_type']);
  assert.throws(() => store.selected([image.image_id, image.image_id]));
  assert.throws(() => store.selected([]));
  store.release(image.image_id);
  assert.throws(() => store.selected([image.image_id]), /no longer available/);
});

test('snapshot validation bounds memory, time, media type and selected image count', () => {
  const store = createPhotoImages(decoder);
  const capture = { data_url: `data:image/png;base64,${png.toString('base64')}`, source: 'overview', captured_at: Date.now() };
  assert.throws(() => store.capture({ ...capture, captured_at: Date.now() - 11000 }), /fresh/);
  assert.throws(() => store.capture({ ...capture, captured_at: Infinity }), /fresh/);
  assert.throws(() => store.capture({ ...capture, source: 'unrecognized' }), /fresh/);
  assert.throws(() => store.capture({ ...capture, data_url: 'file:///private.png' }), /PNG or JPEG/);
  assert.throws(() => store.capture({ ...capture, data_url: 'x'.repeat(2700001) }), /too large/);
  const selected = Array.from({ length: 8 }, () => store.capture(capture));
  assert.throws(() => store.selected(selected.slice(0, 4).map(item => item.image_id)), /one to three/);
  assert.throws(() => store.capture(capture), /Remove/);
  store.clear();
  assert.throws(() => store.selected([selected[0].image_id]), /no longer/);
});

test('uploads retain only the first sanitized encoding without re-encoding it', () => {
  let encodes = 0;
  const native = { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }),
    toPNG() { encodes += 1; return png; } }) };
  const store = createPhotoImages(native);
  const image = store.addUpload(png, 'circuit.png');
  assert.equal(encodes, 1);
  assert.equal(image.resized, false);
  assert.equal(image.original_width, 1);
  assert.equal(store.selected([image.image_id])[0].image_base64, png.toString('base64'));
});
