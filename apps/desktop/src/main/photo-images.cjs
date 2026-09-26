const { randomUUID } = require('node:crypto');
const { dimensions, prepareReviewedImage } = require('./reviewed-image.cjs');
const { preparePhotoUpload } = require('./photo-upload.cjs');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// Reviewed pixels live only in the main process. Renderers pass opaque image IDs
// when asking a question; they cannot substitute paths or arbitrary payloads.
function createPhotoImages(nativeImage) {
  const images = new Map();
  function addPixels(pixels, name) {
    if (images.size >= 8) throw new Error('Remove a selected image before adding another.');
    const { width, height } = dimensions(pixels);
    const image_base64 = pixels.toString('base64');
    const mime_type = pixels[0] === 137 ? 'image/png' : 'image/jpeg';
    const image_id = randomUUID();
    const safeName = String(name).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120);
    images.set(image_id, { image_id, mime_type, image_base64 });
    return { image_id, data_url: `data:${mime_type};base64,${image_base64}`, name: safeName, width, height };
  }
  function add(bytes, name) {
    if (images.size >= 8) throw new Error('Remove a selected image before adding another.');
    return addPixels(Buffer.from(prepareReviewedImage(bytes, nativeImage), 'base64'), name);
  }
  return {
    add,
    addUpload(bytes, name) {
      if (images.size >= 8) throw new Error('Remove a selected image before adding another.');
      const prepared = preparePhotoUpload(bytes, nativeImage);
      // Store these freshly encoded pixels directly. A second JPEG encode could
      // increase the size again or unnecessarily lose detail.
      return { ...addPixels(prepared.bytes, name), original_width: prepared.originalWidth,
        original_height: prepared.originalHeight, resized: prepared.resized };
    },
    capture(payload) {
      if (!['overview', 'pi'].includes(payload.source) || !Number.isFinite(payload.captured_at)
          || Math.abs(Date.now() - payload.captured_at) > 10000) throw new Error('Take a fresh snapshot from the camera view.');
      if (typeof payload.data_url !== 'string' || payload.data_url.length > 2700000) throw new Error('The snapshot is too large.');
      const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(payload.data_url);
      if (!match || match[2].length % 4 !== 0) throw new Error('The snapshot must be a PNG or JPEG.');
      return add(Buffer.from(match[2], 'base64'), payload.source === 'pi' ? 'Close-up snapshot' : 'Overview snapshot');
    },
    release(id) {
      if (!UUID.test(id)) throw new Error('Invalid image ID.');
      images.delete(id);
      return { released: true };
    },
    selected(ids) {
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 3 || new Set(ids).size !== ids.length)
        throw new Error('Choose one to three different images.');
      return ids.map(id => {
        if (typeof id !== 'string' || !UUID.test(id) || !images.has(id)) throw new Error('That image is no longer available. Choose it again.');
        return { ...images.get(id) };
      });
    },
    clear() { images.clear(); },
  };
}
module.exports = { createPhotoImages, UUID };
