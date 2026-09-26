// Synthetic bitmap verification only: no camera, service, audio, or hardware.
const assert = require('node:assert/strict');
const { app, nativeImage } = require('electron');
const { preparePhotoUpload } = require('../../apps/desktop/src/main/photo-upload.cjs');
const { dimensions } = require('../../apps/desktop/src/main/reviewed-image.cjs');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function withPngComment(png, text) {
  const chunkData = Buffer.concat([Buffer.from('Comment\0'), text]);
  const typed = Buffer.concat([Buffer.from('tEXt'), chunkData]);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(chunkData.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([png.subarray(0, -12), header.subarray(0, 4), typed, crc, png.subarray(-12)]);
}

function withJpegComment(jpeg, text) {
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = 0xfe;
  header.writeUInt16BE(text.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), header, text, jpeg.subarray(2)]);
}

function withExifRotation(jpeg, orientation) {
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
  const header = Buffer.from([0xff, 0xe1, 0, exif.length + 2]);
  return Buffer.concat([jpeg.subarray(0, 2), header, exif, jpeg.subarray(2)]);
}

app.whenReady().then(() => {
  const marker = Buffer.from('OHMPATH_PRIVATE_PHONE_METADATA');
  const small = nativeImage.createFromBitmap(Buffer.from([20, 80, 180, 255]), { width: 1, height: 1 });
  for (const source of [
    withPngComment(small.toPNG(), marker),
    withJpegComment(small.toJPEG(90), marker),
  ]) {
    const result = preparePhotoUpload(source, nativeImage);
    assert.equal(result.bytes.includes(marker), false);
    assert.deepEqual(dimensions(result.bytes), { width: 1, height: 1 });
  }

  const width = 4032;
  const height = 3024;
  const bitmap = Buffer.allocUnsafe(width * height * 4);
  let random = 0x12345678;
  for (let index = 0; index < bitmap.length; index += 4) {
    random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
    bitmap[index] = random & 255;
    bitmap[index + 1] = (random >>> 8) & 255;
    bitmap[index + 2] = (random >>> 16) & 255;
    bitmap[index + 3] = 255;
  }
  const phone = nativeImage.createFromBitmap(bitmap, { width, height });
  const source = phone.toJPEG(90);
  assert.ok(source.length > 2_000_000 && source.length <= 16_000_000,
    `Expected an ordinary large phone photo, got ${source.length} bytes.`);
  const result = preparePhotoUpload(source, nativeImage);
  assert.equal(result.resized, true);
  assert.deepEqual({ width: result.originalWidth, height: result.originalHeight }, { width, height });
  assert.ok(Math.max(result.width, result.height) <= 2400);
  assert.ok(result.width * result.height <= 8_000_000);
  assert.ok(result.bytes.length <= 2_000_000);
  assert.deepEqual(dimensions(result.bytes), { width: result.width, height: result.height });
  assert.equal(nativeImage.createFromBuffer(result.bytes).isEmpty(), false);

  const portraitWidth = 40;
  const portraitHeight = 60;
  const portrait = Buffer.alloc(portraitWidth * portraitHeight * 4);
  const colors = {
    R: [0, 0, 255], G: [0, 255, 0], B: [255, 0, 0], Y: [0, 255, 255],
  };
  for (let y = 0; y < portraitHeight; y += 1) {
    for (let x = 0; x < portraitWidth; x += 1) {
      const offset = (y * portraitWidth + x) * 4;
      const corner = (y < portraitHeight / 2 ? 'RG' : 'BY')[x < portraitWidth / 2 ? 0 : 1];
      const [blue, green, red] = colors[corner];
      portrait[offset] = blue;
      portrait[offset + 1] = green;
      portrait[offset + 2] = red;
      portrait[offset + 3] = 255;
    }
  }
  const portraitJpeg = nativeImage.createFromBitmap(portrait, { width: portraitWidth, height: portraitHeight }).toJPEG(95);
  const expectedCorners = {
    1: ['R', 'G', 'B', 'Y'], 2: ['G', 'R', 'Y', 'B'],
    3: ['Y', 'B', 'G', 'R'], 4: ['B', 'Y', 'R', 'G'],
    5: ['R', 'B', 'G', 'Y'], 6: ['B', 'R', 'Y', 'G'],
    7: ['Y', 'G', 'B', 'R'], 8: ['G', 'Y', 'R', 'B'],
  };
  for (let orientation = 1; orientation <= 8; orientation += 1) {
    const rotated = preparePhotoUpload(withExifRotation(portraitJpeg, orientation), nativeImage);
    const rotatedWidth = orientation >= 5 ? portraitHeight : portraitWidth;
    const rotatedHeight = orientation >= 5 ? portraitWidth : portraitHeight;
    assert.deepEqual(dimensions(rotated.bytes), { width: rotatedWidth, height: rotatedHeight });
    const rotatedBitmap = nativeImage.createFromBuffer(rotated.bytes).toBitmap();
    const sample = (u, v) => {
      const x = Math.floor(rotatedWidth * u);
      const y = Math.floor(rotatedHeight * v);
      const offset = (y * rotatedWidth + x) * 4;
      const actual = Array.from(rotatedBitmap.subarray(offset, offset + 3));
      return Object.entries(colors).find(([, expected]) =>
        actual.every((channel, index) => Math.abs(channel - expected[index]) < 35))?.[0];
    };
    assert.deepEqual([sample(.25, .25), sample(.75, .25), sample(.25, .75), sample(.75, .75)],
      expectedCorners[orientation], `Incorrect EXIF orientation ${orientation}.`);
  }

  console.log(`Photo upload native checks passed: PNG/JPEG metadata stripped, ${source.length}-byte phone photo reduced to ${result.bytes.length} bytes, all 8 EXIF orientations applied.`);
  app.exit(0);
}).catch(error => { console.error(error.stack || error.message); app.exit(1); });
