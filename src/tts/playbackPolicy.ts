import type { TourStep } from "../engine/types";

/** Stable identity for the narration currently playing in the webview or host. */
export function narrationTargetKey(tourId: string | null, step: TourStep | null): string | null {
  if (!tourId || !step) return null;
  return JSON.stringify([
    tourId,
    step.root ?? null,
    step.workspaceFolder ?? null,
    step.file,
    step.range ?? null,
    step.viewMode ?? null,
    step.diff ?? null,
    step.title,
    step.explanation,
  ]);
}
