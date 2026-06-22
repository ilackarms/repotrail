export interface SelectionPoint {
  line: number;
  character: number;
}

export interface SelectionBounds {
  start: SelectionPoint;
  end: SelectionPoint;
}

export interface SelectionReference {
  file: string;
  workspaceFolder?: string;
  startLine: number;
  endLine: number;
  languageId?: string;
  code: string;
}

export function selectedFullLineRange(selection: SelectionBounds): { startLine: number; endLine: number } | null {
  const [start, end] = sortSelectionPoints(selection.start, selection.end);
  if (samePoint(start, end)) return null;

  let endLine = end.line;
  if (end.character === 0 && end.line > start.line) {
    endLine = end.line - 1;
  }
  if (endLine < start.line) return null;
  return { startLine: start.line, endLine };
}

export function formatSelectionReference(ref: SelectionReference): string {
  if (ref.startLine < 1 || ref.endLine < ref.startLine) {
    throw new Error("Selection reference line numbers must be 1-indexed and ordered.");
  }

  const target = ref.workspaceFolder
    ? `${ref.workspaceFolder.replace(/\/+$/g, "")}/${ref.file.replace(/^\/+/g, "")}`
    : ref.file;
  const lineRef = ref.startLine === ref.endLine
    ? `${target}:${ref.startLine}`
    : `${target}:${ref.startLine}-${ref.endLine}`;
  const code = ref.code.replace(/\r\n/g, "\n");
  const fence = codeFenceFor(code);
  const language = cleanFenceLanguage(ref.languageId);

  return [lineRef, "", `${fence}${language}`, code, fence].join("\n");
}

function sortSelectionPoints(a: SelectionPoint, b: SelectionPoint): [SelectionPoint, SelectionPoint] {
  if (a.line < b.line || (a.line === b.line && a.character <= b.character)) return [a, b];
  return [b, a];
}

function samePoint(a: SelectionPoint, b: SelectionPoint): boolean {
  return a.line === b.line && a.character === b.character;
}

function codeFenceFor(code: string): string {
  const runs = code.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 2);
  return "`".repeat(longest + 1);
}

function cleanFenceLanguage(languageId?: string): string {
  if (!languageId) return "";
  return /^[A-Za-z0-9_+.#-]+$/.test(languageId) ? languageId : "";
}
