// Synthetic clipboard object only. Never imports or reads Electron's real clipboard.
const assert = require('node:assert/strict');
const { app, nativeImage } = require('electron');
const { prepareClipboardPhoto } = require('../../apps/desktop/src/main/photo-clipboard.cjs');
const { dimensions } = require('../../apps/desktop/src/main/reviewed-image.cjs');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function withPngComment(png, marker) {
  const data = Buffer.concat([Buffer.from('Comment\0'), marker]);
  const typed = Buffer.concat([Buffer.from('tEXt'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typed));
  return Buffer.concat([png.subarray(0, -12), length, typed, checksum, png.subarray(-12)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const marker = Buffer.from('PRIVATE_SYNTHETIC_CLIPBOARD_METADATA');
  const small = nativeImage.createFromBitmap(Buffer.from([20, 80, 180, 255]), { width: 1, height: 1 });
  const annotated = nativeImage.createFromBuffer(withPngComment(small.toPNG(), marker));
  assert.equal(annotated.isEmpty(), false);
  let reads = 0;
  const clipboard = { readImage() { reads++; return annotated; },
    readText() { throw new Error('Text must stay unread.'); },
    clear() { throw new Error('Clipboard must stay unchanged.'); } };
  const output = prepareClipboardPhoto(clipboard, nativeImage);
  assert.equal(reads, 1);
  assert.deepEqual(dimensions(output.bytes), { width: 1, height: 1 });
  assert.equal(output.bytes.includes(marker), false);
  assert.equal(nativeImage.createFromBuffer(output.bytes).isEmpty(), false);

  const width = 4032, height = 3024;
  const bitmap = Buffer.alloc(width * height * 4, 255);
  const phone = nativeImage.createFromBitmap(bitmap, { width, height });
  const large = prepareClipboardPhoto({ readImage: () => phone }, nativeImage);
  assert.equal(large.originalWidth, width);
  assert.equal(large.originalHeight, height);
  assert.equal(large.resized, true);
  assert.ok(Math.max(large.width, large.height) <= 2400);
  assert.ok(large.width * large.height <= 8_000_000);
  assert.ok(large.bytes.length <= 2_000_000);
  assert.deepEqual(dimensions(large.bytes), { width: large.width, height: large.height });
  assert.equal(nativeImage.createFromBuffer(large.bytes).isEmpty(), false);

  assert.throws(() => prepareClipboardPhoto({ readImage: () => nativeImage.createEmpty() }, nativeImage), /usable image/);
  console.log(`Synthetic clipboard checks passed: metadata stripped, ${width}×${height} resized to ${large.width}×${large.height}.`);
  app.exit(0);
}).catch(error => { console.error(error.stack || error.message); app.exit(1); });
