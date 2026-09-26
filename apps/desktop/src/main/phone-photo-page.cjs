// Self-contained phone page. No external assets, camera stream, audio, or model calls.
function phonePhotoPage(nonce) {
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce))
    throw new Error('Invalid page nonce.');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><title>Send a photo · Ohm Path</title>
<style nonce="${nonce}">
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#243b32;background:#f7f0df}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:linear-gradient(165deg,#e7ecd9,#f7f0df 38%,#edddc0)}
main{max-width:620px;margin:auto;padding:28px 18px 48px}.brand{display:flex;align-items:center;gap:12px;margin-bottom:27px;color:#315547;font-weight:750;letter-spacing:.02em}
.mark{display:grid;place-items:center;width:42px;height:42px;border-radius:13px;background:#496c52;color:#fff8e5;font-size:28px;box-shadow:0 3px 0 #72523b}
.card{padding:25px;border:1px solid #b9b796;border-radius:18px;background:#fffaf0;box-shadow:0 12px 35px #4b442b1f}
h1{font-family:Georgia,serif;font-size:clamp(28px,8vw,39px);line-height:1.12;margin:0 0 13px;color:#4b3728}
p{line-height:1.5;color:#56675b;margin:0 0 17px}.hint{font-size:13px;color:#6b7466}.field{display:block;margin:20px 0 7px;font-weight:700}
input[type=file]{display:block;width:100%;padding:15px;border:2px dashed #94a48b;border-radius:12px;background:#f4f6e9;color:#253e32;font-size:15px}
textarea{width:100%;min-height:108px;padding:13px;border:1px solid #a4ae99;border-radius:11px;background:#fffefa;color:#243b32;font:inherit;resize:vertical}
.preview{display:none;margin:18px 0;padding:10px;border-radius:12px;background:#e7eadb}.preview img{display:block;width:100%;max-height:360px;object-fit:contain;border-radius:8px}
.preview small{display:block;margin:8px 4px 2px;color:#647164}button{display:block;width:100%;margin-top:19px;padding:14px 18px;border:0;border-radius:11px;background:#496c52;color:#fffaf0;font:700 16px system-ui;cursor:pointer;box-shadow:0 4px 0 #31503a}
button:disabled{opacity:.5;cursor:not-allowed;box-shadow:none}.status{min-height:23px;margin:15px 0 0;font-size:14px;font-weight:600}.status.error{color:#9a332b}.status.good{color:#326a45}
footer{margin-top:17px;padding:0 5px;color:#6a6e60;font-size:13px;line-height:1.5}
</style></head><body><main><div class="brand"><span class="mark" aria-hidden="true">Ω</span><span>OHM PATH · PHOTO TRANSFER</span></div>
<section class="card"><h1>Bring a photo to your laptop</h1><p>Take or choose one circuit photo or diagram. It stays on this phone until you press Send, then appears for review in Ohm Path.</p>
<label class="field" for="photo">Photo or diagram</label><input id="photo" type="file" accept="image/*" capture="environment">
<div class="preview" id="preview"><img id="preview-image" alt="Selected photo preview"><small id="preview-detail"></small></div>
<label class="field" for="question">Question (optional)</label><textarea id="question" maxlength="4000" placeholder="What would you like to understand?"></textarea>
<button id="send" type="button" disabled>Send to Ohm Path</button><p id="status" class="status" role="status" aria-live="polite"></p></section>
<footer>Use this pairing link only on a network you trust. Sending a photo never starts an AI answer. Review it and press Ask on your laptop when ready. No live camera, microphone, or continuous upload is used here.</footer></main>
<script nonce="${nonce}">
(() => {
  'use strict';
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('token') || '';
  history.replaceState(null, '', location.pathname);
  const input = document.getElementById('photo');
  const preview = document.getElementById('preview');
  const previewImage = document.getElementById('preview-image');
  const previewDetail = document.getElementById('preview-detail');
  const question = document.getElementById('question');
  const send = document.getElementById('send');
  const status = document.getElementById('status');
  let prepared = null;
  let busy = false;
  let selectionGeneration = 0;
  function message(text, kind) { status.textContent = text; status.className = 'status' + (kind ? ' ' + kind : ''); }
  function readDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not prepare that photo.'));
      reader.readAsDataURL(blob);
    });
  }
  async function loadImage(url) {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Choose a photo this browser can open.'));
      image.src = url;
    });
    return image;
  }
  function jpegBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not prepare that photo.')), 'image/jpeg', quality);
    });
  }
  async function prepare(file) {
    if (!file || file.size < 1 || file.size > 16000000) throw new Error('Choose a photo under 16 MB.');
    const sourceUrl = URL.createObjectURL(file);
    try {
      const image = await loadImage(sourceUrl);
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (!width || !height || width > 8192 || height > 8192 || width * height > 32000000)
        throw new Error('Choose a photo no larger than 32 megapixels.');
      const fit = Math.min(1, 2400 / Math.max(width, height));
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('This browser cannot prepare the photo.');
      for (const factor of [1, .82, .67, .55]) {
        canvas.width = Math.max(1, Math.floor(width * fit * factor));
        canvas.height = Math.max(1, Math.floor(height * fit * factor));
        context.fillStyle = '#fffaf0';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        for (const quality of [.86, .72, .58, .42]) {
          const blob = await jpegBlob(canvas, quality);
          if (blob.size <= 2000000) {
            const dataUrl = await readDataUrl(blob);
            return { dataUrl, base64: dataUrl.split(',')[1], width: canvas.width, height: canvas.height };
          }
        }
      }
      throw new Error('The photo could not be reduced below 2 MB.');
    } finally { URL.revokeObjectURL(sourceUrl); }
  }
  if (!token) message('This pairing link is missing its private code. Open a fresh link from the laptop.', 'error');
  input.addEventListener('change', async () => {
    const selection = ++selectionGeneration;
    prepared = null;
    send.disabled = true;
    preview.style.display = 'none';
    if (!input.files || !input.files[0]) return;
    message('Preparing photo on this phone…');
    try {
      const image = await prepare(input.files[0]);
      if (selection !== selectionGeneration) return;
      prepared = image;
      previewImage.src = prepared.dataUrl;
      previewDetail.textContent = prepared.width + ' × ' + prepared.height + ' · prepared locally';
      preview.style.display = 'block';
      send.disabled = !token;
      message('Ready to send. Review the photo first.');
    } catch (error) { if (selection === selectionGeneration) message(error.message || 'Could not prepare that photo.', 'error'); }
  });
  send.addEventListener('click', async () => {
    if (!prepared || !token || busy) return;
    busy = true;
    send.disabled = true;
    input.disabled = true;
    message('Sending to your laptop…');
    try {
      const response = await fetch('/photo', { method: 'POST', credentials: 'omit', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ mime_type: 'image/jpeg', image_base64: prepared.base64, question: question.value.slice(0, 4000) }) });
      if (!response.ok) throw new Error('Could not send. Check that the laptop transfer is still open and try a fresh pairing link.');
      prepared = null;
      input.value = '';
      send.disabled = true;
      message('Sent to Ohm Path. Review and press Ask on your laptop.', 'good');
    } catch (error) {
      message(error.message || 'Could not send this photo.', 'error');
      send.disabled = false;
    } finally { busy = false; input.disabled = false; }
  });
})();
</script></body></html>`;
}

module.exports = { phonePhotoPage };
