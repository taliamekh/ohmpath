const MAX_FRAME_BYTES = 5 * 1024 * 1024;
const MAX_BUFFER_BYTES = MAX_FRAME_BYTES + 65536;
const BOUNDARY = Buffer.from('--ohmpath-video-frame');
const SOURCE = 'Raspberry Pi camera via an existing local tunnel';

class PiVideoClient {
  constructor() { this.disconnect(); }
  disconnect() {
    this.controller?.abort();
    clearInterval(this.timer);
    this.controller = null;
    this.frame = null;
    this.connected = false;
    this.state = 'disconnected';
    this.reason = null;
    this.generation = (this.generation || 0) + 1;
    return { connected: false };
  }
  fail(state, reason) {
    this.disconnect();
    this.state = state;
    this.reason = reason;
  }
  status() {
    return {
      connected: this.connected,
      state: this.state,
      ...(this.reason ? { reason: this.reason } : {}),
      fresh_frame: Boolean(this.connected && this.frame && Date.now() - this.frame.received_at <= 2000),
      source: SOURCE,
    };
  }
  async connect(port, token) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || typeof token !== 'string'
      || token.length < 32 || token.length > 256 || !/^[!-~]+$/.test(token)) throw new Error('Enter a valid local tunnel port and per-launch video token.');
    this.disconnect();
    this.state = 'connecting';
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const base = `http://127.0.0.1:${port}`;
    const headers = { Authorization: `Bearer ${token}` };
    try {
      const health = await fetch(base + '/v1/health', { headers, redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]) });
      if (!health.ok) throw new Error('The Pi video service rejected the connection.');
      let healthBytes = Buffer.alloc(0);
      for await (const chunk of health.body) {
        healthBytes = Buffer.concat([healthBytes, Buffer.from(chunk)]);
        if (healthBytes.length > 8192) throw new Error('Unexpected Pi service response.');
      }
      const info = JSON.parse(healthBytes.toString('utf8'));
      if (info.service !== 'ohmpath-pi-video' || info.mode !== 'camera' || info.physical_control !== 'disabled') throw new Error('This port is not the expected camera-only service.');
      const handshake = setTimeout(() => controller.abort(), 5000);
      let response;
      try { response = await fetch(base + '/v1/stream.mjpg', { headers, redirect: 'error', signal: controller.signal }); }
      finally { clearTimeout(handshake); }
      if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('multipart/x-mixed-replace; boundary=ohmpath-video-frame')) throw new Error('The Pi camera stream is unavailable.');
      if (generation !== this.generation) throw new Error('The camera connection was cancelled.');
      this.connected = true;
      this.state = 'waiting';
      this.lastData = Date.now();
      this.timer = setInterval(() => {
        if (Date.now() - this.lastData > 5000) this.fail('stalled', 'No Pi camera frame arrived for five seconds. Check the local tunnel and reconnect.');
      }, 1000);
      this.timer.unref?.();
      void this.readFrames(response.body, generation).catch(error => {
        if (generation !== this.generation) return;
        const invalid = /^(Invalid|Oversized) camera/.test(error?.message || '');
        this.fail('failed', invalid
          ? 'The Pi camera sent an invalid frame. Check the video service and reconnect.'
          : 'The Pi camera stream stopped. Check the local tunnel and reconnect.');
      });
      return { connected: true, source: SOURCE };
    } catch {
      if (generation === this.generation) this.fail('failed', 'Could not connect to the Pi camera. Check the local tunnel, video service and per-launch token.');
      throw new Error('Could not connect to the Pi camera. Check the local tunnel, video service and per-launch token.');
    }
  }
  async readFrames(body, generation) {
    const reader = body.getReader();
    let buffer = Buffer.alloc(0);
    try {
      while (generation === this.generation) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer = Buffer.concat([buffer, Buffer.from(value)]);
        if (buffer.length > MAX_BUFFER_BYTES) throw new Error('Oversized camera frame.');
        while (buffer.length) {
          const start = buffer.indexOf(BOUNDARY);
          if (start < 0) { if (buffer.length > 8192) throw new Error('Invalid camera boundary.'); break; }
          if (start > 0) buffer = buffer.subarray(start);
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) { if (buffer.length > 4096) throw new Error('Invalid camera headers.'); break; }
          const header = buffer.subarray(0, end).toString('ascii');
          const lengths = [...header.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)];
          if (lengths.length !== 1 || !/^Content-Type:\s*image\/jpeg\s*$/im.test(header)) throw new Error('Invalid camera frame type.');
          const length = Number(lengths[0][1]);
          if (length < 4 || length > MAX_FRAME_BYTES) throw new Error('Invalid camera frame length.');
          const frameEnd = end + 4 + length;
          if (buffer.length < frameEnd + 2) break;
          const jpeg = buffer.subarray(end + 4, frameEnd);
          if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[length - 2] !== 0xff || jpeg[length - 1] !== 0xd9
              || buffer.subarray(frameEnd, frameEnd + 2).toString() !== '\r\n') throw new Error('Invalid camera JPEG.');
          if (generation !== this.generation) return;
          this.lastData = Date.now();
          this.frame = { jpeg_base64: jpeg.toString('base64'), received_at: this.lastData };
          this.state = 'streaming';
          buffer = buffer.subarray(frameEnd + 2);
        }
      }
      if (generation === this.generation) throw new Error('Pi camera stream ended.');
    } finally {
      reader.releaseLock();
    }
  }
  latest() {
    if (!this.connected || !this.frame || Date.now() - this.frame.received_at > 2000) return null;
    return { ...this.frame };
  }
}

module.exports = { PiVideoClient };
