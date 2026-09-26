export {};

declare global {
  interface Window {
    ohmpath?: {
      request(action: string, payload?: Record<string, unknown>): Promise<unknown>;
      onServiceStopped?(callback: () => void): () => void;
      onCompanionClosed?(callback: () => void): () => void;
      onPhonePhoto?(callback: () => void): () => void;
      onSpeechEvent?(callback: (event: import("./SpeechPlayback").SpeechWireEvent) => void): () => void;
    };
    ohmpathCompanion?: {
      onState(callback: (state: { activity: "idle" | "listening" | "thinking" | "speaking" | "paused" | "error"; expression?: "neutral" | "thinking" | "stumped" | "happy" | "smug" | "weary"; caption: string; reducedMotion: boolean }) => void): () => void;
      hide(): Promise<unknown>;
    };
  }
}
