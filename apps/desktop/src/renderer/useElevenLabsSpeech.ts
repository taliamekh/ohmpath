import { useCallback, useEffect, useRef, useState } from "react";
import { SpeechPlayback } from "./SpeechPlayback";

async function voiceRequest(action: string, payload: Record<string, unknown> = {}) {
  if (!window.ohmpath) throw new Error("Voice playback is unavailable.");
  return await window.ohmpath.request(action, payload) as Record<string, any>;
}

/** Presentation only: speech never submits a question or confirms a measurement. */
export default function useElevenLabsSpeech(onState: (speaking: boolean) => void, onError: (message: string) => void) {
  const [available, setAvailable] = useState(false);
  const availableNow = useRef(false);
  const [pending, setPending] = useState(false);
  const callbacks = useRef({ onState, onError });
  callbacks.current = { onState, onError };
  const player = useRef<SpeechPlayback | null>(null);
  const current = useRef<{ id: string; streamEnded: boolean; onComplete?: () => void } | null>(null);
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const status = await voiceRequest("elevenLabsStatus");
      const ready = status.connected === true && status.generation_enabled === true
        && Boolean(status.selected_voice_id) && status.spending_blocked === false
        && status.provider_remaining_credits > 0 && status.remaining_session_characters > 0 && status.remaining_session_credits > 0;
      if (mounted.current) { availableNow.current = ready; setAvailable(ready); }
      const reason = !status.connected ? 'The ElevenLabs account is not linked in this app. Open Voice setup and link it.'
        : !status.selected_voice_id ? 'No voice is selected. Open Voice setup and choose your voice.'
        : status.spending_blocked !== false ? 'Voice is blocked by the account spending settings. Check Voice setup; no paid fallback was enabled.'
        : !status.generation_enabled ? 'Spoken answers are off for this launch.'
        : !(status.provider_remaining_credits > 0) ? 'ElevenLabs account credits are unavailable or exhausted. Refresh account information in Voice setup.'
        : !(status.remaining_session_characters > 0 && status.remaining_session_credits > 0) ? 'The voice allowance for this launch is used up. No additional credits were authorized.'
        : '';
      return { available: ready, reason };
    } catch {
      if (mounted.current) { availableNow.current = false; setAvailable(false); }
      return { available: false, reason: 'The app could not read its voice connection. Close and reopen Ohm Path.' };
    }
  }, []);

  const stop = useCallback(() => {
    const previous = current.current;
    current.current = null;
    player.current?.stop();
    if (previous) {
      void voiceRequest("elevenLabsCancelSpeech", { request_id: previous.id }).catch(() => undefined);
      if (mounted.current) { setPending(false); callbacks.current.onState(false); }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    player.current = new SpeechPlayback((state, id) => {
      const active = current.current;
      if (!mounted.current || !active || active.id !== id) return;
      if (state === "started") { callbacks.current.onState(true); return; }
      current.current = null;
      setPending(false);
      callbacks.current.onState(false);
      if (state === "error") {
        void voiceRequest("elevenLabsCancelSpeech", { request_id: id }).catch(() => undefined);
        callbacks.current.onError("Voice playback could not finish. The answer is still available as text.");
      } else if (active.streamEnded) active.onComplete?.();
      void refresh();
    });
    const unsubscribe = window.ohmpath?.onSpeechEvent?.(event => {
      if (event.request_id !== current.current?.id) return;
      if (event.type === "end") current.current.streamEnded = true;
      if (event.type === "cancelled") { stop(); return; }
      void player.current?.receive(event).catch(() => {
        if (current.current?.id !== event.request_id || !mounted.current) return;
        stop();
        callbacks.current.onError("Audio output could not continue. The answer is still available as text.");
      });
    });
    void refresh();
    return () => {
      mounted.current = false;
      stop();
      unsubscribe?.();
      player.current?.dispose();
      player.current = null;
    };
  }, [refresh, stop]);

  const speak = useCallback((text: string, onComplete?: () => void) => {
    stop();
    if (!availableNow.current) { callbacks.current.onError("Enable ElevenLabs spoken answers in Settings first."); return; }
    if (!text.trim() || text.length > 1000) {
      callbacks.current.onError("This answer exceeds the 1,000-character speech limit. Read the full answer on screen.");
      return;
    }
    const id = crypto.randomUUID();
    current.current = { id, streamEnded: false, onComplete };
    setPending(true);
    let ready: Promise<void>;
    try { ready = player.current!.arm(id); }
    catch { stop(); callbacks.current.onError("Audio output could not be opened."); return; }
    void ready.then(() => {
      if (current.current?.id !== id || !mounted.current) return;
      return voiceRequest("elevenLabsSpeak", { request_id: id, text }).catch(() => {
        if (current.current?.id !== id || !mounted.current) return;
        stop();
        callbacks.current.onError("Speech was blocked or unavailable. Check the voice allowance in Settings; captions remain available.");
      }).finally(() => { void refresh(); });
    }).catch(() => undefined); // The player's error callback reports the unlock failure.
  }, [available, refresh, stop]);

  const prepare = useCallback(() => {
    if (available) void player.current?.prepare().catch(() => {
      callbacks.current.onError("Audio output could not be opened. The written answer will still be available.");
    });
  }, [available]);

  return { available, pending, speak, stop, refresh, prepare };
}
