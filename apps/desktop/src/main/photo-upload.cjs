const { dimensions } = require('./reviewed-image.cjs');

const MAX_UPLOAD_BYTES = 16_000_000;
const MAX_SOURCE_PIXELS = 32_000_000;
const MAX_SOURCE_SIDE = 8192;
const MAX_OUTPUT_BYTES = 2_000_000;
const PREFERRED_SIDE = 2400;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function exifOrientation(segment) {
  if (segment.length < 14 || !segment.subarray(0, 6).equals(Buffer.from('Exif\0\0'))) return 1;
  const tiff = segment.subarray(6);
  const endian = tiff.subarray(0, 2).toString('ascii');
  if (endian !== 'II' && endian !== 'MM') return 1;
  const little = endian === 'II';
  const read16 = offset => offset + 2 <= tiff.length
    ? little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset) : null;
  const read32 = offset => offset + 4 <= tiff.length
    ? little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset) : null;
  if (read16(2) !== 42) return 1;
  const ifd = read32(4);
  if (ifd === null || ifd + 2 > tiff.length) return 1;
  const count = read16(ifd);
  if (count === null || count > 256) return 1;
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > tiff.length) return 1;
    if (read16(entry) === 0x0112 && read16(entry + 2) === 3 && read32(entry + 4) === 1) {
      const orientation = read16(entry + 8);
      return orientation >= 1 && orientation <= 8 ? orientation : 1;
    }
  }
  return 1;
}

// Read only structural headers before handing untrusted pixels to a decoder.
function uploadHeader(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > MAX_UPLOAD_BYTES)
    throw new Error('Choose a PNG or JPEG under 16 MB.');
  let width;
  let height;
  let orientation = 1;
  let format;
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    format = 'png';
    if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13
        || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid PNG image.');
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    format = 'jpeg';
    let offset = 2;
    let sawScan = false;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) throw new Error('Invalid JPEG image.');
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) throw new Error('Invalid JPEG image.');
      const marker = bytes[offset++];
      if (marker === 0xda) { sawScan = true; break; }
      if (marker === 0xd9 || marker === 0xd8 || marker === 0x00) throw new Error('Invalid JPEG image.');
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) throw new Error('Invalid JPEG image.');
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) throw new Error('Invalid JPEG image.');
      if (marker === 0xe1 && orientation === 1)
        orientation = exifOrientation(bytes.subarray(offset + 2, offset + length));
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 7 || width !== undefined) throw new Error('Invalid JPEG image.');
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
      }
      offset += length;
    }
    if (!sawScan) throw new Error('Invalid JPEG image.');
  } else throw new Error('Choose a PNG or JPEG image.');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width > MAX_SOURCE_SIDE || height > MAX_SOURCE_SIDE || width * height > MAX_SOURCE_PIXELS)
    throw new Error('Choose an image no larger than 8192 pixels per side and 32 megapixels.');
  return { width, height, orientation, format };
}

// Remove APP1 before native decoding so EXIF orientation can only be applied
// once. The entropy-coded scan is copied as one untouched suffix.
function jpegWithoutApp1(bytes) {
  const pieces = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset < bytes.length) {
    const start = offset;
    if (bytes[offset++] !== 0xff) throw new Error('Invalid JPEG image.');
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) throw new Error('Invalid JPEG image.');
    const marker = bytes[offset++];
    if (marker === 0xda) {
      pieces.push(bytes.subarray(start));
      return Buffer.concat(pieces);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pieces.push(bytes.subarray(start, offset));
      continue;
    }
    if (offset + 2 > bytes.length) throw new Error('Invalid JPEG image.');
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw new Error('Invalid JPEG image.');
    const end = offset + length;
    if (marker !== 0xe1) pieces.push(bytes.subarray(start, end));
    offset = end;
  }
  throw new Error('Invalid JPEG image.');
}

function orientBitmap(decoded, nativeImage, orientation, width, height) {
  if (orientation === 1) return decoded;
  const source = decoded.toBitmap();
  if (!Buffer.isBuffer(source) || source.length !== width * height * 4)
    throw new Error('The selected image could not be prepared.');
  const swapped = orientation >= 5;
  const outputWidth = swapped ? height : width;
  const outputHeight = swapped ? width : height;
  const target = Buffer.allocUnsafe(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let dx;
      let dy;
      switch (orientation) {
        case 2: dx = width - 1 - x; dy = y; break;
        case 3: dx = width - 1 - x; dy = height - 1 - y; break;
        case 4: dx = x; dy = height - 1 - y; break;
        case 5: dx = y; dy = x; break;
        case 6: dx = height - 1 - y; dy = x; break;
        case 7: dx = height - 1 - y; dy = width - 1 - x; break;
        case 8: dx = y; dy = width - 1 - x; break;
      }
      source.copy(target, (dy * outputWidth + dx) * 4, (y * width + x) * 4, (y * width + x + 1) * 4);
    }
  }
  const image = nativeImage.createFromBitmap(target, { width: outputWidth, height: outputHeight });
  if (image.isEmpty()) throw new Error('The selected image could not be prepared.');
  return image;
}

function preparePhotoUpload(bytes, nativeImage) {
  const header = uploadHeader(bytes);
  if (!nativeImage || typeof nativeImage.createFromBuffer !== 'function') throw new Error('Image decoding is unavailable.');
  let decoded = nativeImage.createFromBuffer(header.format === 'jpeg' ? jpegWithoutApp1(bytes) : bytes);
  if (!decoded || decoded.isEmpty()) throw new Error('The selected image could not be decoded.');
  let size = decoded.getSize();
  if (size.width !== header.width || size.height !== header.height)
    throw new Error('The image dimensions are inconsistent.');
  const originalWidth = header.orientation >= 5 ? header.height : header.width;
  const originalHeight = header.orientation >= 5 ? header.width : header.height;
  const scale = Math.min(1, PREFERRED_SIDE / Math.max(size.width, size.height),
    Math.sqrt(8_000_000 / (size.width * size.height)));
  const initialWidth = Math.max(1, Math.floor(size.width * scale));
  const initialHeight = Math.max(1, Math.floor(size.height * scale));
  // Scale before any manual EXIF transform to keep its bitmap copy bounded.
  if (initialWidth !== size.width || initialHeight !== size.height) {
    decoded = decoded.resize({ width: initialWidth, height: initialHeight, quality: 'best' });
    if (!decoded || decoded.isEmpty()) throw new Error('The selected image could not be resized.');
    size = decoded.getSize();
    if (size.width !== initialWidth || size.height !== initialHeight)
      throw new Error('The image dimensions are inconsistent.');
  }
  // APP1 was removed before decoding, so this is the sole orientation step.
  if (header.format === 'jpeg' && header.orientation !== 1) {
    decoded = orientBitmap(decoded, nativeImage, header.orientation, size.width, size.height);
    size = decoded.getSize();
  }
  const outputWidth = size.width;
  const outputHeight = size.height;
  const widths = [1, .82, .67, .55, .45, .36].map(factor => Math.max(1, Math.floor(outputWidth * factor)));
  for (const width of widths) {
    const height = Math.max(1, Math.floor(outputHeight * width / outputWidth));
    const candidate = width === size.width && height === size.height
      ? decoded : decoded.resize({ width, height, quality: 'best' });
    if (!candidate || candidate.isEmpty()) throw new Error('The selected image could not be resized.');
    const candidateSize = candidate.getSize();
    if (candidateSize.width !== width || candidateSize.height !== height)
      throw new Error('The image dimensions are inconsistent.');
    const png = candidate.toPNG();
    if (Buffer.isBuffer(png) && png.length <= MAX_OUTPUT_BYTES) {
      dimensions(png);
      return { bytes: png, originalWidth, originalHeight, width, height,
        resized: width !== originalWidth || height !== originalHeight };
    }
    for (const quality of [85, 70, 55, 40]) {
      const jpeg = candidate.toJPEG(quality);
      if (Buffer.isBuffer(jpeg) && jpeg.length <= MAX_OUTPUT_BYTES) {
        dimensions(jpeg);
        return { bytes: jpeg, originalWidth, originalHeight, width, height,
          resized: width !== originalWidth || height !== originalHeight };
      }
    }
  }
  throw new Error('The selected image could not be reduced below 2 MB.');
}

module.exports = { MAX_UPLOAD_BYTES, preparePhotoUpload, uploadHeader };
