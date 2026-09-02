export type WebviewTtsState = "idle" | "preparing" | "playing" | "paused";

export interface RenderSignature {
  tourId: string | null;
  index: number;
  provider: string;
  currentKey: string;
}

export function shouldDeferRenderForTts(
  ttsState: WebviewTtsState,
  previous: RenderSignature | null,
  next: RenderSignature,
): boolean {
  if (ttsState === "idle" || !previous) return false;
  // Keep the current playback surface alive until TtsManager sends tts.cancel.
  // The resulting idle event flushes any pending tour/content change.
  return previous.provider === next.provider;
}
