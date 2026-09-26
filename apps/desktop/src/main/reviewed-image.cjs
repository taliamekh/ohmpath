// Header bounds are checked before decoding any user-selected bitmap.
const MAX_BYTES = 2000000;
function dimensions(data) {
  if (!Buffer.isBuffer(data) || data.length < 16 || data.length > MAX_BYTES) throw new Error('Choose a PNG or JPEG under 2 MB.');
  let width, height;
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (data.length < 33 || data.readUInt32BE(8) !== 13 || data.subarray(12, 16).toString() !== 'IHDR') throw new Error('Invalid PNG image.');
    width = data.readUInt32BE(16); height = data.readUInt32BE(20);
  } else if (data[0] === 255 && data[1] === 216) {
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 255) break;
      while (offset < data.length && data[offset] === 255) offset++;
      const marker = data[offset++];
      if (marker === 1 || (marker >= 208 && marker <= 217)) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([192, 193, 194, 195].includes(marker) && length >= 7) {
        height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 8000000)
    throw new Error('Choose a PNG or JPEG no larger than 4096 pixels per side and 8 megapixels.');
  return { width, height };
}

function prepareReviewedImage(data, nativeImage) {
  const shape = dimensions(data);
  const decoded = nativeImage.createFromBuffer(data);
  if (decoded.isEmpty()) throw new Error('The selected image could not be decoded.');
  const size = decoded.getSize();
  if (size.width !== shape.width || size.height !== shape.height) throw new Error('The image dimensions are inconsistent.');
  // Re-encode pixels to avoid forwarding original EXIF or other file metadata.
  let pixels = decoded.toPNG();
  if (pixels.length > MAX_BYTES) pixels = decoded.toJPEG(85);
  dimensions(pixels);
  return pixels.toString('base64');
}
module.exports = { dimensions, prepareReviewedImage };
