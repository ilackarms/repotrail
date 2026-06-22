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
  return (
    previous.tourId === next.tourId &&
    previous.index === next.index &&
    previous.provider === next.provider &&
    previous.currentKey === next.currentKey
  );
}
