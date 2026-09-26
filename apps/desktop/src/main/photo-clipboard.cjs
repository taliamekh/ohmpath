const { MAX_UPLOAD_BYTES, preparePhotoUpload } = require('./photo-upload.cjs');
const { dimensions } = require('./reviewed-image.cjs');

const MAX_SOURCE_SIDE = 8192;
const MAX_SOURCE_PIXELS = 32_000_000;
const MAX_OUTPUT_SIDE = 2400;
const MAX_OUTPUT_PIXELS = 8_000_000;
const MAX_OUTPUT_BYTES = 2_000_000;

function validSize(size) {
  return size && Number.isInteger(size.width) && Number.isInteger(size.height)
    && size.width > 0 && size.height > 0
    && size.width <= MAX_SOURCE_SIDE && size.height <= MAX_SOURCE_SIDE
    && size.width * size.height <= MAX_SOURCE_PIXELS;
}

// Called only by the explicit Paste image action. Never inspects clipboard text
// or files and never mutates the user's clipboard.
function prepareClipboardPhoto(clipboard, nativeImage) {
  if (!clipboard || typeof clipboard.readImage !== 'function'
      || !nativeImage || typeof nativeImage.createFromBitmap !== 'function')
    throw new Error('Image paste is unavailable.');
  const source = clipboard.readImage();
  if (!source || typeof source.isEmpty !== 'function' || source.isEmpty()
      || typeof source.getSize !== 'function')
    throw new Error('The clipboard does not contain a usable image.');
  const original = source.getSize();
  if (!validSize(original))
    throw new Error('Paste an image no larger than 8192 pixels per side and 32 megapixels.');

  const scale = Math.min(1, MAX_OUTPUT_SIDE / Math.max(original.width, original.height),
    Math.sqrt(MAX_OUTPUT_PIXELS / (original.width * original.height)));
  const width = Math.max(1, Math.floor(original.width * scale));
  const height = Math.max(1, Math.floor(original.height * scale));
  const resized = width === original.width && height === original.height ? source
    : source.resize({ width, height, quality: 'best' });
  if (!resized || resized.isEmpty() || typeof resized.getSize !== 'function'
      || resized.getSize().width !== width || resized.getSize().height !== height)
    throw new Error('The clipboard image could not be resized.');

  // Construct a fresh native image from bounded pixels, so a clipboard image's
  // original encoded representation and metadata cannot be forwarded.
  const bitmap = resized.toBitmap();
  if (!Buffer.isBuffer(bitmap) || bitmap.length !== width * height * 4)
    throw new Error('The clipboard image could not be prepared.');
  const clean = nativeImage.createFromBitmap(bitmap, { width, height });
  if (!clean || clean.isEmpty() || clean.getSize().width !== width || clean.getSize().height !== height)
    throw new Error('The clipboard image could not be prepared.');

  const png = clean.toPNG();
  if (Buffer.isBuffer(png) && png.length <= MAX_OUTPUT_BYTES) {
    const shape = dimensions(png);
    if (shape.width !== width || shape.height !== height) throw new Error('The clipboard image dimensions are inconsistent.');
    return { bytes: png, originalWidth: original.width, originalHeight: original.height,
      width, height, resized: width !== original.width || height !== original.height };
  }

  for (const quality of [85, 70, 55, 40]) {
    const jpeg = clean.toJPEG(quality);
    if (!Buffer.isBuffer(jpeg) || jpeg.length > MAX_UPLOAD_BYTES) continue;
    const result = preparePhotoUpload(jpeg, nativeImage);
    return { ...result, originalWidth: original.width, originalHeight: original.height,
      resized: result.width !== original.width || result.height !== original.height };
  }
  throw new Error('The clipboard image could not be reduced below 2 MB.');
}

module.exports = { prepareClipboardPhoto };
