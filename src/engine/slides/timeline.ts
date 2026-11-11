/**
 * Beats as pure data: what a slide looks like at each position, what plays
 * when a beat is entered, and how Next and Back move through a tour.
 *
 * Position 0 is a slide before any beat; position k is after beat k. State is
 * computed from the beats alone, so any position can be shown directly (Back,
 * route jumps, live reload) and the renderer only animates the difference.
 */

import type { SlideBeat, SlideElementPatch, SlideFlowEffect, TourSlide, TourStep } from "../types";

export interface SlideState {
  position: number;
  /** Every element that isn't visible, including ones hidden through a parent or an endpoint. */
  hidden: string[];
  /** Accumulated `set` changes per element. */
  patches: Record<string, SlideElementPatch>;
  /** This beat's spotlight. Code line ranges are expanded to single lines. */
  focus: string[];
  highlight: string[];
}

export interface ScheduledFlow extends SlideFlowEffect {
  from: string;
  to: string;
  /** Flows with the same slot start together; slot n starts when slot n-1 arrives. */
  slot: number;
}

export interface SlideEffects {
  /** Elements that become visible on entering the beat, in reveal order. */
  appear: string[];
  flows: ScheduledFlow[];
  pulse: string[];
}

export interface TourCursor {
  index: number;
  beat: number;
}

export type CursorMove = "next" | "back" | "nextStop";

const CODE_LINE_RANGE = /^(.+):L(\d+)(?:-(\d+))?$/;

/** The slide's beats: explicit `beats`, or the ones `build` blocks imply. */
export function slideBeats(slide: TourSlide): SlideBeat[] {
  if (slide.beats?.length) return slide.beats;
  const beats: SlideBeat[] = [];
  for (const block of slide.blocks) {
    if (!block.build) continue;
    if (block.type === "bullets") for (const item of block.items) beats.push({ show: [item.id] });
    else if (block.type === "table") for (const row of block.rows) beats.push({ show: [row.id] });
    else if (block.type === "sequence") {
      for (const message of block.messages) beats.push({ show: [message.id], highlight: [message.id] });
    }
  }
  return beats;
}

/** Positions on a stop: one for a code stop, beats + 1 for a slide. */
export function positionCount(step: TourStep): number {
  return step.slide ? slideBeats(step.slide).length + 1 : 1;
}

export function stateAt(slide: TourSlide, position: number): SlideState {
  const beats = slideBeats(slide);
  const p = clamp(position, 0, beats.length);
  const hidden = new Set<string>();
  for (const beat of beats) for (const id of expandIds(beat.show)) hidden.add(id);
  const patches: Record<string, SlideElementPatch> = {};
  for (const beat of beats.slice(0, p)) {
    for (const id of expandIds(beat.show)) hidden.delete(id);
    for (const id of expandIds(beat.hide)) hidden.add(id);
    for (const [id, patch] of Object.entries(beat.set ?? {})) patches[id] = { ...patches[id], ...patch };
  }
  const current = p > 0 ? beats[p - 1] : undefined;
  return {
    position: p,
    hidden: effectiveHidden(slide, hidden),
    patches,
    focus: expandIds(current?.focus),
    highlight: expandIds(current?.highlight),
  };
}

/** What plays when position `position` is entered from the position before it. */
export function effectsEntering(slide: TourSlide, position: number): SlideEffects {
  const beats = slideBeats(slide);
  if (position < 1 || position > beats.length) return { appear: [], flows: [], pulse: [] };
  const beat = beats[position - 1];
  const before = new Set(stateAt(slide, position - 1).hidden);
  const after = new Set(stateAt(slide, position).hidden);
  const appeared = [...before].filter((id) => !after.has(id));
  const listed = expandIds(beat.show).filter((id) => appeared.includes(id));
  const appear = [...listed, ...appeared.filter((id) => !listed.includes(id))];
  return { appear, flows: scheduleFlows(slide, beat.flow ?? []), pulse: expandIds(beat.pulse) };
}

/**
 * A flow that starts where the previous one ended waits for it, so a path
 * plays as a chain; any other flow starts with the previous one.
 */
export function scheduleFlows(slide: TourSlide, flows: SlideFlowEffect[]): ScheduledFlow[] {
  const ends = new Map<string, { from: string; to: string }>();
  for (const block of slide.blocks) {
    if (block.type === "flow") for (const edge of block.edges) ends.set(edge.id, { from: edge.from, to: edge.to });
  }
  const scheduled: ScheduledFlow[] = [];
  for (const flow of flows) {
    const edge = ends.get(flow.edge);
    if (!edge) continue;
    const from = flow.reverse ? edge.to : edge.from;
    const to = flow.reverse ? edge.from : edge.to;
    const previous = scheduled[scheduled.length - 1];
    const slot = !previous ? 0 : previous.to === from ? previous.slot + 1 : previous.slot;
    scheduled.push({ ...flow, from, to, slot });
  }
  return scheduled;
}

/** Where Next, Back and Next stop go from `cursor`; null when there's nowhere to go. */
export function moveCursor(steps: readonly TourStep[], cursor: TourCursor, move: CursorMove): TourCursor | null {
  const step = steps[cursor.index];
  if (!step) return null;
  const last = positionCount(step) - 1;
  if (move === "next" && cursor.beat < last) return { index: cursor.index, beat: cursor.beat + 1 };
  if (move === "back") {
    if (cursor.beat > 0) return { index: cursor.index, beat: Math.min(cursor.beat, last) - 1 };
    if (cursor.index === 0) return null;
    // Like a slideshow: Back from a slide's first beat shows the previous slide finished.
    return { index: cursor.index - 1, beat: positionCount(steps[cursor.index - 1]) - 1 };
  }
  if (cursor.index >= steps.length - 1) return null;
  return { index: cursor.index + 1, beat: 0 };
}

/** What narration says at a position: the stop's title and explanation, then each beat's `say`. */
export function narrationAt(step: TourStep, beat: number): string {
  if (beat <= 0 || !step.slide) return `${step.title}. ${step.explanation}`;
  return slideBeats(step.slide)[beat - 1]?.say ?? "";
}

/**
 * Every label and sub a node or edge shows across the beats, so layout can
 * size it once for the longest and nothing moves when `set` changes text.
 */
export function textVariants(slide: TourSlide): Map<string, { label: string[]; sub: string[] }> {
  const variants = new Map<string, { label: string[]; sub: string[] }>();
  for (const beat of slideBeats(slide)) {
    for (const [id, patch] of Object.entries(beat.set ?? {})) {
      const entry = variants.get(id) ?? { label: [], sub: [] };
      if (patch.label !== undefined) entry.label.push(patch.label);
      if (patch.sub !== undefined) entry.sub.push(patch.sub);
      variants.set(id, entry);
    }
  }
  return variants;
}

/** Expand `code:L3-5` into `code:L3`, `code:L4`, `code:L5`; other ids pass through. */
export function expandIds(ids: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const id of ids ?? []) {
    const m = CODE_LINE_RANGE.exec(id);
    if (!m) {
      out.push(id);
      continue;
    }
    const start = Number(m[2]);
    const end = m[3] ? Number(m[3]) : start;
    for (let line = start; line <= end && line - start < 200; line++) out.push(`${m[1]}:L${line}`);
  }
  return out;
}

/**
 * Apply containment: hiding a block hides its contents, a hidden group hides
 * its nodes, and an edge or message hides with either end. Returned in
 * document order.
 */
function effectiveHidden(slide: TourSlide, hidden: Set<string>): string[] {
  const out: string[] = [];
  const mark = (id: string, isHidden: boolean) => {
    if (isHidden) out.push(id);
    return isHidden;
  };
  for (const block of slide.blocks) {
    const blockHidden = mark(block.id, hidden.has(block.id));
    switch (block.type) {
      case "bullets": {
        const walk = (items: typeof block.items, parentHidden: boolean) => {
          for (const item of items) {
            const itemHidden = mark(item.id, parentHidden || hidden.has(item.id));
            if (item.items) walk(item.items, itemHidden);
          }
        };
        walk(block.items, blockHidden);
        break;
      }
      case "table":
        for (const row of block.rows) mark(row.id, blockHidden || hidden.has(row.id));
        break;
      case "code": {
        const first = block.startLine ?? 1;
        const count = block.code.split("\n").length;
        for (let line = first; line < first + count; line++) {
          const id = `${block.id}:L${line}`;
          mark(id, blockHidden || hidden.has(id));
        }
        break;
      }
      case "flow": {
        const groupHidden = new Map<string, boolean>();
        for (const group of block.groups) groupHidden.set(group.id, mark(group.id, blockHidden || hidden.has(group.id)));
        const nodeHidden = new Map<string, boolean>();
        for (const node of block.nodes) {
          const isHidden = blockHidden || hidden.has(node.id) || Boolean(node.group && groupHidden.get(node.group));
          nodeHidden.set(node.id, mark(node.id, isHidden));
        }
        for (const edge of block.edges) {
          mark(edge.id, blockHidden || hidden.has(edge.id) || Boolean(nodeHidden.get(edge.from)) || Boolean(nodeHidden.get(edge.to)));
        }
        break;
      }
      case "sequence": {
        const participantHidden = new Map<string, boolean>();
        for (const participant of block.participants) {
          participantHidden.set(participant.id, mark(participant.id, blockHidden || hidden.has(participant.id)));
        }
        for (const message of block.messages) {
          const ends = "note" in message ? message.over : [message.from, message.to];
          mark(message.id, blockHidden || hidden.has(message.id) || ends.some((id) => participantHidden.get(id)));
        }
        break;
      }
    }
  }
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
