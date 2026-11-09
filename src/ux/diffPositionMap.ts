/**
 * Pure helpers for mapping a position inside a RepoTrail virtual diff document
 * (git base/head text, or a hunk slice) back to the matching position in the
 * real workspace file. Language servers only attach to real files, so
 * go-to-definition from a virtual side has to be answered there.
 */

export interface LinePosition {
  line: number;
  character: number;
}

export interface DiffPositionMapInput {
  /** Lines of the virtual diff document the user clicked in. */
  virtualLines: readonly string[];
  position: LinePosition;
  /** Identifier under the cursor; mapped positions must land on the same word. */
  word?: string;
  /** Lines of the real workspace file. */
  sourceLines: readonly string[];
  /**
   * Exact line offset when the virtual text is a verbatim slice of the source
   * file (hunk diffs whose right side is the workspace selection).
   */
  lineOffset?: number;
}

export function mapDiffPositionToSource(input: DiffPositionMapInput): LinePosition | null {
  const { virtualLines, position, word, sourceLines } = input;
  if (sourceLines.length === 0) return null;

  if (input.lineOffset !== undefined) {
    const line = position.line + input.lineOffset;
    if (line >= 0 && line < sourceLines.length) return { line, character: position.character };
  }

  const text = virtualLines[position.line] ?? "";
  if (text.trim()) {
    const candidates: Array<{ line: number; character: number; distance: number; exact: boolean }> = [];
    const trimmed = text.trim();
    const indent = leadingWhitespace(text);
    sourceLines.forEach((sourceLine, line) => {
      if (sourceLine === text) {
        candidates.push({ line, character: position.character, distance: Math.abs(line - position.line), exact: true });
      } else if (sourceLine.trim() === trimmed) {
        const character = Math.max(0, position.character - indent + leadingWhitespace(sourceLine));
        candidates.push({ line, character, distance: Math.abs(line - position.line), exact: false });
      }
    });
    candidates.sort((a, b) => a.distance - b.distance || Number(b.exact) - Number(a.exact));
    for (const candidate of candidates) {
      if (!word || wordAt(sourceLines[candidate.line], candidate.character) === word) {
        return { line: candidate.line, character: candidate.character };
      }
    }
  }

  return word ? nearestWordOccurrence(sourceLines, word, position.line) : null;
}

/** True when two document texts are identical apart from line endings. */
export function sameDocumentText(a: string, b: string): boolean {
  return a.length === b.length ? a === b : a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");
}

/** Identifier (letters, digits, `_`, `$`) touching `character`, or "" if none. */
export function wordAt(line: string, character: number): string {
  const isWord = (ch: string | undefined) => !!ch && /[A-Za-z0-9_$]/.test(ch);
  let start = Math.min(Math.max(0, character), line.length);
  if (!isWord(line[start]) && isWord(line[start - 1])) start -= 1;
  if (!isWord(line[start])) return "";
  let end = start;
  while (start > 0 && isWord(line[start - 1])) start -= 1;
  while (end < line.length && isWord(line[end])) end += 1;
  return line.slice(start, end);
}

function nearestWordOccurrence(lines: readonly string[], word: string, nearLine: number): LinePosition | null {
  const pattern = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(word)}(?![A-Za-z0-9_$])`, "g");
  let best: LinePosition | null = null;
  let bestDistance = Infinity;
  lines.forEach((text, line) => {
    const distance = Math.abs(line - nearLine);
    if (distance >= bestDistance) return;
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) {
      best = { line, character: match.index };
      bestDistance = distance;
    }
  });
  return best;
}

function leadingWhitespace(text: string): number {
  return text.length - text.trimStart().length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
