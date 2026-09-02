import type { TourStep } from "../engine/types";

export interface TourReconciliation {
  steps: TourStep[];
  index: number;
  seen: number[];
  editorRefreshNeeded: boolean;
}

/** Reconcile navigation and runtime anchors against a rewritten tour file. */
export function reconcileTourUpdate(
  previousSteps: readonly TourStep[],
  currentIndex: number,
  seen: Iterable<number>,
  incomingSteps: readonly TourStep[],
): TourReconciliation {
  if (incomingSteps.length === 0) {
    return {
      steps: [],
      index: -1,
      seen: [],
      editorRefreshNeeded: previousSteps.length > 0,
    };
  }

  const seenIndices = [...new Set(seen)].filter((index) => index >= 0).sort((a, b) => a - b);
  const previousToNext = matchSteps(previousSteps, incomingSteps, currentIndex, seenIndices);
  const matchedCurrent = previousToNext[currentIndex] ?? -1;
  const index = matchedCurrent >= 0
    ? matchedCurrent
    : Math.max(0, Math.min(currentIndex, incomingSteps.length - 1));

  const steps = incomingSteps.map((step) => ({ ...step }));
  for (let previousIndex = 0; previousIndex < previousToNext.length; previousIndex++) {
    const nextIndex = previousToNext[previousIndex];
    if (nextIndex == null || nextIndex < 0) continue;
    const previous = previousSteps[previousIndex];
    const next = steps[nextIndex];
    if (next.anchor === undefined && previous.anchor && locationKey(previous) === locationKey(next)) {
      next.anchor = previous.anchor;
    }
  }

  const nextSeen = seenIndices
    .map((previousIndex) => previousToNext[previousIndex] ?? -1)
    .filter((nextIndex) => nextIndex >= 0);
  const previousCurrent = previousSteps[currentIndex];
  const nextCurrent = steps[index];
  const currentChanged = !previousCurrent || editorKey(previousCurrent) !== editorKey(nextCurrent);
  const markersChanged = Boolean(
    previousCurrent &&
      !currentChanged &&
      markerKey(previousSteps, currentIndex) !== markerKey(steps, index),
  );

  return {
    steps,
    index,
    seen: [...new Set(nextSeen)].sort((a, b) => a - b),
    editorRefreshNeeded: currentChanged || markersChanged,
  };
}

function matchSteps(
  previousSteps: readonly TourStep[],
  nextSteps: readonly TourStep[],
  currentIndex: number,
  seenIndices: readonly number[],
): number[] {
  const matches = Array<number>(previousSteps.length).fill(-1);
  const used = new Set<number>();
  const order = [currentIndex, ...seenIndices, ...previousSteps.map((_, index) => index)];
  for (const previousIndex of [...new Set(order)]) {
    const previous = previousSteps[previousIndex];
    if (!previous) continue;
    const matched = matchStep(previous, nextSteps, previousIndex, used);
    if (matched < 0) continue;
    matches[previousIndex] = matched;
    used.add(matched);
  }
  return matches;
}

function matchStep(
  previous: TourStep,
  nextSteps: readonly TourStep[],
  preferredIndex: number,
  excluded: ReadonlySet<number>,
): number {
  const keys: Array<(step: TourStep) => string> = [
    fullMatchKey,
    titledLocationKey,
    fileTitleKey,
    locationKey,
  ];
  for (const key of keys) {
    const expected = key(previous);
    const candidates = nextSteps
      .map((step, index) => ({ index, key: key(step) }))
      .filter((candidate) => candidate.key === expected && !excluded.has(candidate.index))
      .sort((a, b) => Math.abs(a.index - preferredIndex) - Math.abs(b.index - preferredIndex));
    if (candidates.length > 0) return candidates[0].index;
  }
  return -1;
}

function fullMatchKey(step: TourStep): string {
  return JSON.stringify([editorTargetKey(step), step.title, step.explanation]);
}

function titledLocationKey(step: TourStep): string {
  return JSON.stringify([locationKey(step), step.title]);
}

function fileTitleKey(step: TourStep): string {
  return JSON.stringify([fileKey(step), step.title]);
}

function locationKey(step: TourStep): string {
  return JSON.stringify([fileKey(step), step.range ?? null]);
}

function fileKey(step: TourStep): string {
  return JSON.stringify([step.root ?? null, step.workspaceFolder ?? null, step.file]);
}

function editorTargetKey(step: TourStep): string {
  return JSON.stringify([
    fileKey(step),
    step.range ?? null,
    step.viewMode ?? null,
    step.diff ?? null,
  ]);
}

function editorKey(step: TourStep): string {
  return JSON.stringify([editorTargetKey(step), step.anchor ?? null]);
}

function markerKey(steps: readonly TourStep[], currentIndex: number): string {
  const current = steps[currentIndex];
  if (!current) return "";
  const currentFile = fileKey(current);
  return JSON.stringify(
    steps
      .flatMap((step, index) =>
        index !== currentIndex && fileKey(step) === currentFile && step.range ? [step.range] : [],
      )
      .map((range) => JSON.stringify(range))
      .sort(),
  );
}
