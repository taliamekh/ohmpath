/** A user-armed, bounded PCM player. No speech or provider fallback is started here. */

export type SpeechWireEvent =
  | { type: "start"; request_id: string; sample_rate: 24000; format: "pcm_s16le" }
  | { type: "chunk"; request_id: string; sample_rate: 24000; pcm_base64: string }
  | { type: "end" | "cancelled"; request_id: string }
  | { type: "error"; request_id: string; error: string };

export type PlaybackState = "started" | "ended" | "error";
type PlaybackCallback = (state: PlaybackState, requestId: string, detail?: string) => void;

const MAX_CHUNK_BYTES = 48 * 1024;
const MAX_QUEUED_SECONDS = 3;
const MAX_SCHEDULED_SOURCES = 8;
const MAX_PENDING_CHUNKS = 2048;
const MAX_SESSION_AUDIO_BYTES = 8 * 1024 * 1024;
const AUDIO_UNLOCK_TIMEOUT_MS = 5000;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class SpeechPlayback {
  private context: AudioContext | null = null;
  private ready: Promise<void> | null = null;
  private requestId: string | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private pending: Uint8Array[] = [];
  private nextTime = 0;
  private bytes = 0;
  private started = false;
  private streamEnded = false;
  private startTimer: number | null = null;

  constructor(private readonly onPlaybackState: PlaybackCallback) {}

  /** Unlock audio during Ask/Record; a later answer can use the same context. */
  prepare(): Promise<void> {
    if (!this.context || this.context.state === "closed") this.context = new AudioContext();
    const context = this.context;
    if (context.state === "running") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("playback_unavailable")), AUDIO_UNLOCK_TIMEOUT_MS);
      void context.resume().then(() => {
        window.clearTimeout(timer);
        if (context.state === "running") resolve();
        else reject(new Error("playback_unavailable"));
      }, error => { window.clearTimeout(timer); reject(error); });
    });
  }

  /** Call synchronously inside the user's click/key gesture, before requesting speech. */
  arm(requestId: string): Promise<void> {
    if (!REQUEST_ID.test(requestId)) throw new Error("invalid_speech_request");
    this.stop();
    if (!this.context || this.context.state === "closed") this.context = new AudioContext();
    this.requestId = requestId;
    this.nextTime = this.context.currentTime;
    this.bytes = 0;
    this.started = false;
    this.streamEnded = false;
    this.ready = this.prepare();
    void this.ready.catch(() => {
      if (this.requestId === requestId) this.fail("playback_unavailable");
    });
    return this.ready;
  }

  async receive(event: SpeechWireEvent): Promise<void> {
    if (!event || event.request_id !== this.requestId || !this.context || !this.ready) return;
    try { await this.ready; } catch { return; } // arm reports the unlock error once.
    if (event.request_id !== this.requestId || !this.context) return;
    if (event.type === "cancelled") { this.stop(event.request_id); return; }
    if (event.type === "error") { this.fail("speech_unavailable"); return; }
    if (event.type === "start") {
      if (event.sample_rate !== 24000 || event.format !== "pcm_s16le") this.fail("playback_format_invalid");
      return;
    }
    if (event.type === "end") {
      this.streamEnded = true;
      this.pump();
      if (!this.sources.size && !this.pending.length) {
        if (this.started) this.finish();
        else this.fail("empty_speech_stream");
      }
      return;
    }
    if (event.type !== "chunk" || event.sample_rate !== 24000 || this.streamEnded
        || typeof event.pcm_base64 !== "string" || event.pcm_base64.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4 + 4) {
      this.fail("playback_format_invalid");
      return;
    }
    let raw: string;
    try { raw = atob(event.pcm_base64); } catch { this.fail("playback_format_invalid"); return; }
    if (!raw.length || raw.length > MAX_CHUNK_BYTES || raw.length % 2
        || this.bytes + raw.length > MAX_SESSION_AUDIO_BYTES || this.pending.length >= MAX_PENDING_CHUNKS) {
      this.fail("playback_format_invalid");
      return;
    }
    if (this.context.state !== "running") { this.fail("playback_unavailable"); return; }
    this.pending.push(Uint8Array.from(raw, character => character.charCodeAt(0)));
    this.bytes += raw.length;
    this.pump();
  }

  stop(requestId?: string): void {
    if (requestId && requestId !== this.requestId) return;
    const previous = this.requestId;
    const wasStarted = this.started;
    this.requestId = null;
    this.streamEnded = false;
    this.started = false;
    this.bytes = 0;
    this.nextTime = 0;
    this.pending = [];
    if (this.startTimer !== null) window.clearTimeout(this.startTimer);
    this.startTimer = null;
    for (const source of this.sources) {
      source.onended = null;
      try { source.stop(); } catch { /* Already ended. */ }
      source.disconnect();
    }
    this.sources.clear();
    if (previous && wasStarted) this.onPlaybackState("ended", previous);
  }

  dispose(): void {
    this.stop();
    const context = this.context;
    this.context = null;
    this.ready = null;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
  }

  private finish(): void {
    const requestId = this.requestId;
    if (!requestId) return;
    const wasStarted = this.started;
    this.stop(requestId);
    // A short buffer can drain before the delayed started notification.
    if (!wasStarted) this.onPlaybackState("ended", requestId);
  }

  private pump(): void {
    const context = this.context;
    const requestId = this.requestId;
    if (!context || !requestId || context.state !== "running") return;
    while (this.pending.length && this.sources.size < MAX_SCHEDULED_SOURCES
        && this.nextTime - context.currentTime < MAX_QUEUED_SECONDS) {
      const raw = this.pending.shift()!;
      const startAt = Math.max(context.currentTime + .01, this.nextTime);
      const buffer = context.createBuffer(1, raw.length / 2, 24000);
      const samples = buffer.getChannelData(0);
      for (let index = 0; index < samples.length; index += 1) {
        const value = (raw[index * 2 + 1] << 8) | raw[index * 2];
        samples[index] = (value >= 0x8000 ? value - 0x10000 : value) / 32768;
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        this.sources.delete(source);
        source.disconnect();
        if (this.requestId !== requestId) return;
        this.pump();
        if (this.streamEnded && !this.pending.length && !this.sources.size) this.finish();
      };
      this.sources.add(source);
      this.nextTime = startAt + raw.length / 2 / 24000;
      source.start(startAt);
      if (!this.started && this.startTimer === null) {
        this.startTimer = window.setTimeout(() => {
          this.startTimer = null;
          if (this.requestId === requestId && this.context?.state === "running" && this.sources.size) {
            this.started = true;
            this.onPlaybackState("started", requestId);
          }
        }, Math.max(0, (startAt - context.currentTime) * 1000));
      }
    }
  }

  private fail(detail: string): void {
    const requestId = this.requestId;
    // A playback failure is one terminal state, not a successful drain.
    this.started = false;
    this.stop();
    if (requestId) this.onPlaybackState("error", requestId, detail);
  }
}
