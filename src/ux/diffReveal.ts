export interface RangePointLike {
  line: number;
  character: number;
}

export interface RangeLike {
  start: RangePointLike;
  end: RangePointLike;
}

export interface DiffRevealTarget {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export type DiffRevealScope = "file" | "hunk";

export function diffRevealTargetForRange(range: RangeLike, scope: DiffRevealScope = "file"): DiffRevealTarget {
  const startLine = clampWholeNumber(range.start.line);
  const startCharacter = clampWholeNumber(range.start.character);
  const endLine = Math.max(startLine, clampWholeNumber(range.end.line));
  const endCharacter = clampWholeNumber(range.end.character);
  if (scope === "hunk") {
    return {
      startLine: 0,
      startCharacter,
      endLine: endLine - startLine,
      endCharacter,
    };
  }
  return {
    startLine,
    startCharacter,
    endLine,
    endCharacter,
  };
}

function clampWholeNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
