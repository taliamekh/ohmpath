// Synthetic pixels and metadata only. No files, cameras or model services are opened.
const assert = require('node:assert/strict');
const { app, nativeImage } = require('electron');
const { prepareReviewedImage } = require('../../apps/desktop/src/main/reviewed-image.cjs');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

app.whenReady().then(() => {
  const marker = Buffer.from('OHMPATH_SYNTHETIC_METADATA_TEST');
  const bitmap = nativeImage.createFromBitmap(Buffer.from([20, 80, 180, 255]), { width: 1, height: 1 });
  const png = bitmap.toPNG();
  const text = Buffer.concat([Buffer.from('Comment\0'), marker]);
  const typed = Buffer.concat([Buffer.from('tEXt'), text]);
  const length = Buffer.alloc(4); length.writeUInt32BE(text.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(typed));
  // Place a valid ancillary text chunk before IEND.
  const annotatedPng = Buffer.concat([png.subarray(0, -12), length, typed, checksum, png.subarray(-12)]);
  const jpeg = bitmap.toJPEG(90);
  const commentHeader = Buffer.from([0xff, 0xfe, 0, marker.length + 2]);
  const annotatedJpeg = Buffer.concat([jpeg.subarray(0, 2), commentHeader, marker, jpeg.subarray(2)]);
  for (const input of [annotatedPng, annotatedJpeg]) {
    assert.ok(input.includes(marker));
    const output = Buffer.from(prepareReviewedImage(input, nativeImage), 'base64');
    assert.equal(output.includes(marker), false, 'Original image comments must not be sent');
    const decoded = nativeImage.createFromBuffer(output);
    assert.equal(decoded.isEmpty(), false);
    assert.deepEqual(decoded.getSize(), { width: 1, height: 1 });
  }
  console.log('Native PNG and JPEG pixel re-encoding removed synthetic metadata: 2 passed.');
  app.exit(0);
}).catch(error => { console.error(error.message); app.exit(1); });
