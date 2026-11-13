import type { TourRange } from "./types";

/** A stop's highlight in zero-based editor coordinates. */
export interface EditorSpan {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

/**
 * Where a stop's highlight starts and ends.
 *
 * A range covers whole lines, `startLine` through `endLine`, both included.
 * Columns only narrow the first and last line. An `endColumn` of 1, which is
 * what most tours write and what an omitted column defaults to, means "all of
 * `endLine`". Reading it as "stop before `endLine`" used to drop the last line
 * of every range and leave single-line ranges empty. A range that would still
 * come out empty highlights its whole line instead.
 *
 * `lineLength(n)` returns the length of zero-based line `n`.
 */
export function editorSpan(range: TourRange, lineCount: number, lineLength: (line: number) => number): EditorSpan {
  const last = Math.max(0, lineCount - 1);
  const startLine = clamp(range.startLine - 1, 0, last);
  const endLine = clamp(range.endLine - 1, startLine, last);
  const endOfLine = lineLength(endLine);
  let startCharacter = clamp(range.startColumn - 1, 0, lineLength(startLine));
  let endCharacter = range.endColumn > 1 ? Math.min(range.endColumn - 1, endOfLine) : endOfLine;
  if (endLine === startLine && endCharacter <= startCharacter) {
    startCharacter = 0;
    endCharacter = endOfLine;
  }
  return { startLine, startCharacter, endLine, endCharacter };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
