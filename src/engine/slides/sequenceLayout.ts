/**
 * Layout for `sequence` blocks: participants in a row, a lifeline under each,
 * and one row per message or note, top to bottom. Pure, like flowLayout.
 */

import type { SlideSequenceBlock } from "../types";
import { nodeSize, wrap, type FlowNodeBox, type TextMeasure, type TextVariants } from "./flowLayout";

export interface SequenceLifeline {
  id: string;
  x: number;
  y1: number;
  y2: number;
}

export interface SequenceMessageRoute {
  id: string;
  x1: number;
  x2: number;
  y: number;
  self: boolean;
  /** `y` is the center of the first line. */
  label?: { x: number; y: number; lines: string[]; anchor: "middle" | "start" };
}

export interface SequenceNoteBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  lines: string[];
}

export interface SequenceLayout {
  width: number;
  height: number;
  participants: FlowNodeBox[];
  lifelines: SequenceLifeline[];
  messages: SequenceMessageRoute[];
  notes: SequenceNoteBox[];
}

export const SEQUENCE_METRICS = {
  gap: 44,
  messageMaxWidth: 300,
  noteMaxWidth: 340,
  line: 17,
  firstRow: 24,
  rowGap: 16,
  labelGap: 4,
  selfWidth: 30,
  selfHeight: 24,
  notePadX: 12,
  notePadY: 7,
  noteOverhang: 36,
  margin: 12,
} as const;

export function layoutSequence(block: SlideSequenceBlock, measure: TextMeasure, variants: TextVariants = new Map()): SequenceLayout {
  const s = SEQUENCE_METRICS;
  const sizes = block.participants.map((p) => nodeSize(p, measure, variants.get(p.id)));
  const index = new Map(block.participants.map((p, i) => [p.id, i]));
  const textWidth = (lines: string[]) => Math.max(0, ...lines.map((l) => measure(l, "sub")));
  const messageLines = (text: string) => wrap(text, "sub", s.messageMaxWidth, measure, 2);

  // Column centers: boxes side by side, then widened until every label fits.
  const centers: number[] = [];
  sizes.forEach((size, i) => {
    centers.push(i === 0 ? size.width / 2 : centers[i - 1] + sizes[i - 1].width / 2 + s.gap + size.width / 2);
  });
  const shiftFrom = (k: number, by: number) => {
    for (let j = k; j < centers.length; j++) centers[j] += by;
  };
  for (const item of block.messages) {
    if ("note" in item) continue;
    const texts = [item.label, ...(variants.get(item.id)?.label ?? [])].filter((t): t is string => Boolean(t));
    const width = Math.max(0, ...texts.map((t) => textWidth(messageLines(t))));
    const a = index.get(item.from)!;
    const b = index.get(item.to)!;
    if (a === b) {
      const need = s.selfWidth + 10 + width + 12;
      if (a < centers.length - 1) {
        const have = centers[a + 1] - centers[a] - sizes[a + 1].width / 2;
        if (have < need) shiftFrom(a + 1, need - have);
      }
      continue;
    }
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const need = width + 36;
    const have = centers[hi] - centers[lo];
    if (have < need) {
      const each = (need - have) / (hi - lo);
      for (let k = lo + 1; k <= hi; k++) shiftFrom(k, each);
    }
  }

  const headerHeight = Math.max(...sizes.map((size) => size.height));
  const participants: FlowNodeBox[] = block.participants.map((p, i) => {
    const size = sizes[i];
    const y = (headerHeight - size.height) / 2;
    return {
      id: p.id,
      x: centers[i] - size.width / 2,
      y,
      width: size.width,
      height: size.height,
      labelLines: size.labelLines,
      subLines: size.subLines,
      textX: centers[i] + size.textDx,
      textY: y + size.height / 2 + size.textDy,
    };
  });

  const messages: SequenceMessageRoute[] = [];
  const notes: SequenceNoteBox[] = [];
  let y = headerHeight + s.firstRow;
  for (const item of block.messages) {
    if ("note" in item) {
      const lines = wrap(item.note, "sub", s.noteMaxWidth, measure, 3);
      const spanned = item.over.map((id) => centers[index.get(id)!]);
      const left = Math.min(...spanned) - s.noteOverhang;
      const right = Math.max(...spanned) + s.noteOverhang;
      const width = Math.max(right - left, textWidth(lines) + 2 * s.notePadX);
      const height = lines.length * s.line + 2 * s.notePadY;
      notes.push({ id: item.id, x: (left + right) / 2 - width / 2, y, width, height, lines });
      y += height + s.rowGap;
      continue;
    }
    const lines = item.label ? messageLines(item.label) : [];
    const reserved = Math.max(lines.length, ...(variants.get(item.id)?.label ?? []).map((t) => messageLines(t).length));
    const from = centers[index.get(item.from)!];
    const to = centers[index.get(item.to)!];
    if (item.from === item.to) {
      const lineY = y + 6;
      const route: SequenceMessageRoute = { id: item.id, x1: from, x2: from + s.selfWidth, y: lineY, self: true };
      if (lines.length > 0 || reserved > 0) {
        route.label = { x: from + s.selfWidth + 10, y: lineY + s.selfHeight / 2 - ((lines.length - 1) * s.line) / 2, lines, anchor: "start" };
      }
      messages.push(route);
      y = lineY + Math.max(s.selfHeight, reserved * s.line) + s.rowGap;
      continue;
    }
    const labelHeight = reserved * s.line;
    const lineY = y + labelHeight + s.labelGap;
    const route: SequenceMessageRoute = { id: item.id, x1: from, x2: to, y: lineY, self: false };
    if (reserved > 0) route.label = { x: (from + to) / 2, y: y + s.line / 2, lines, anchor: "middle" };
    messages.push(route);
    y = lineY + s.rowGap;
  }

  const bottom = y + 4;
  const lifelines: SequenceLifeline[] = participants.map((p) => ({ id: p.id, x: p.x + p.width / 2, y1: p.y + p.height, y2: bottom }));

  // Shift so the drawing starts at the margin, and size the canvas.
  const xs: number[] = [];
  participants.forEach((p) => xs.push(p.x, p.x + p.width));
  notes.forEach((n) => xs.push(n.x, n.x + n.width));
  for (const route of messages) {
    xs.push(route.x1, route.x2);
    if (route.label) {
      const width = textWidth(route.label.lines);
      xs.push(route.label.anchor === "start" ? route.label.x + width : route.label.x + width / 2);
      if (route.label.anchor === "middle") xs.push(route.label.x - width / 2);
    }
  }
  const dx = s.margin - Math.min(...xs);
  const dy = s.margin;
  return {
    width: Math.ceil(Math.max(...xs) - Math.min(...xs) + 2 * s.margin),
    height: Math.ceil(bottom + 2 * s.margin),
    participants: participants.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy, textX: p.textX + dx, textY: p.textY + dy })),
    lifelines: lifelines.map((l) => ({ ...l, x: l.x + dx, y1: l.y1 + dy, y2: l.y2 + dy })),
    messages: messages.map((m) => ({
      ...m,
      x1: m.x1 + dx,
      x2: m.x2 + dx,
      y: m.y + dy,
      label: m.label ? { ...m.label, x: m.label.x + dx, y: m.label.y + dy } : undefined,
    })),
    notes: notes.map((n) => ({ ...n, x: n.x + dx, y: n.y + dy })),
  };
}
