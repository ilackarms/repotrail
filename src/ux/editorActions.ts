import * as vscode from "vscode";
import { DriftStatus, TourStep } from "../engine/types";

/**
 * Executes a TourStep's declarative actions against the editor.
 *
 * Only place that calls `vscode.window.show*` / `vscode.workspace.openTextDocument`.
 *
 * Narration stays outside the code surface:
 *   1. The sidebar renders the full current-step narration durably.
 *   2. TourCodeLensProvider draws a control strip above the range and marks the
 *      other stops that live in the same file.
 *
 * Drift handling: the first time a ranged step is shown we snapshot the
 * anchored line's text into `step.anchor`. On later shows (after the code may
 * have been edited, or for a tour shared/resumed from disk) we compare: if the
 * anchored line moved we relocate the highlight to wherever the anchor text now
 * lives; if it's gone we flag the stop as drifted. This keeps shared tours
 * trustworthy as the code evolves.
 *
 * If the agent omits `range`, we default to lines 1–5 so the highlight and
 * CodeLens still have a real range to attach to.
 */

const HIGHLIGHT_DECORATION = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
  border: "1px solid",
  borderColor: new vscode.ThemeColor("editor.findMatchBorder"),
  isWholeLine: false,
  overviewRulerColor: new vscode.ThemeColor("editor.findMatchBorder"),
  overviewRulerLane: vscode.OverviewRulerLane.Right,
});

// Faint overview-ruler ticks for the *other* stops that live in the file the
// user is currently looking at — turns the scrollbar into a map of the tour.
const STOP_MARKER_DECORATION = vscode.window.createTextEditorDecorationType({
  overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.findMatchForeground"),
  overviewRulerLane: vscode.OverviewRulerLane.Center,
  isWholeLine: false,
});

const MAX_ANCHOR_LEN = 200;

export interface ExecuteResult {
  drift: DriftStatus;
  /** Anchor text captured on this show (only when the step had none yet). */
  capturedAnchor?: string;
}

let logger: vscode.OutputChannel | null = null;
export function setEditorLogger(channel: vscode.OutputChannel): void {
  logger = channel;
}

export async function executeStep(
  step: TourStep,
  opts?: { allSteps?: TourStep[]; currentIndex?: number },
): Promise<ExecuteResult> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage("Code Atlas: open a workspace first.");
    return { drift: "ok" };
  }
  if (!step.file) return { drift: "ok" };

  const uri = vscode.Uri.joinPath(folder.uri, step.file);
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (err) {
    logger?.appendLine(`[editor] open failed for ${step.file}: ${String(err)}`);
    vscode.window.showErrorMessage(`Code Atlas: cannot open ${step.file}.`);
    return { drift: "missing" };
  }
  const editor = await vscode.window.showTextDocument(doc, { preview: false });

  let range = resolveRange(step, doc);
  let drift: DriftStatus = "ok";
  let capturedAnchor: string | undefined;

  if (step.range) {
    if (step.anchor) {
      const checked = checkAnchor(doc, range, step.anchor);
      drift = checked.status;
      range = checked.range;
    } else {
      // First show of a ranged step — snapshot the anchor for future drift checks.
      capturedAnchor = firstNonEmptyLine(doc, range);
    }
  }

  editor.setDecorations(HIGHLIGHT_DECORATION, [{ range }]);
  applyStopMarkers(editor, doc, step, opts);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  editor.selection = new vscode.Selection(range.start, range.start);

  logger?.appendLine(
    `[editor] step "${step.title}" range L${range.start.line + 1}:${range.start.character + 1}-L${range.end.line + 1}:${range.end.character + 1}` +
      (step.range ? "" : " (defaulted — agent omitted range)") +
      (drift !== "ok" ? ` [drift: ${drift}]` : ""),
  );

  return { drift, capturedAnchor };
}

/** Decorate the ranges of the other in-file stops with overview-ruler ticks. */
function applyStopMarkers(
  editor: vscode.TextEditor,
  doc: vscode.TextDocument,
  current: TourStep,
  opts?: { allSteps?: TourStep[]; currentIndex?: number },
): void {
  const all = opts?.allSteps;
  if (!all || all.length < 2) {
    editor.setDecorations(STOP_MARKER_DECORATION, []);
    return;
  }
  const ranges: vscode.Range[] = [];
  all.forEach((s, i) => {
    if (i === opts?.currentIndex) return;
    if (s.file !== current.file || !s.range) return;
    ranges.push(resolveRange(s, doc));
  });
  editor.setDecorations(STOP_MARKER_DECORATION, ranges);
}

export function clearHighlights(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    editor.setDecorations(HIGHLIGHT_DECORATION, []);
    editor.setDecorations(STOP_MARKER_DECORATION, []);
  }
}

function firstNonEmptyLine(doc: vscode.TextDocument, range: vscode.Range): string | undefined {
  for (let line = range.start.line; line <= range.end.line && line < doc.lineCount; line++) {
    const text = doc.lineAt(line).text.trim();
    if (text) return text.slice(0, MAX_ANCHOR_LEN);
  }
  return undefined;
}

/**
 * Compare the anchored line against `anchor`. If it matches, no drift. If not,
 * search the whole file for the anchor text and relocate to the nearest match
 * (preserving the original line-span). If the anchor is gone, report missing
 * and keep the original range.
 */
function checkAnchor(
  doc: vscode.TextDocument,
  range: vscode.Range,
  anchor: string,
): { status: DriftStatus; range: vscode.Range } {
  const startLine = clamp(range.start.line, 0, doc.lineCount - 1);
  if (doc.lineAt(startLine).text.trim().slice(0, MAX_ANCHOR_LEN) === anchor) {
    return { status: "ok", range };
  }
  const matches: number[] = [];
  for (let i = 0; i < doc.lineCount; i++) {
    if (doc.lineAt(i).text.trim().slice(0, MAX_ANCHOR_LEN) === anchor) matches.push(i);
  }
  if (matches.length === 0) return { status: "missing", range };

  let best = matches[0];
  for (const m of matches) {
    if (Math.abs(m - startLine) < Math.abs(best - startLine)) best = m;
  }
  const span = range.end.line - range.start.line;
  const newStart = best;
  const newEnd = clamp(best + span, 0, doc.lineCount - 1);
  const endChar = doc.lineAt(newEnd).text.length;
  return {
    status: "relocated",
    range: new vscode.Range(newStart, range.start.character, newEnd, endChar),
  };
}

/**
 * Resolve a step's range against the current document without showing it.
 * Used to pre-scan a whole tour for drift on load. Returns the drift status
 * and (if a range was given) the anchor to capture when none exists yet.
 */
export async function checkStepDrift(
  step: TourStep,
): Promise<{ drift: DriftStatus; capturedAnchor?: string }> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || !step.file || !step.range) return { drift: "ok" };
  const uri = vscode.Uri.joinPath(folder.uri, step.file);
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch {
    return { drift: "missing" };
  }
  const range = resolveRange(step, doc);
  if (!step.anchor) return { drift: "ok", capturedAnchor: firstNonEmptyLine(doc, range) };
  return { drift: checkAnchor(doc, range, step.anchor).status };
}

function resolveRange(step: TourStep, doc: vscode.TextDocument): vscode.Range {
  if (step.range) {
    const r = step.range;
    const startLine = clamp(r.startLine - 1, 0, doc.lineCount - 1);
    const endLine = clamp(r.endLine - 1, startLine, doc.lineCount - 1);
    const startCol = Math.max(0, r.startColumn - 1);
    const endCol = Math.max(0, r.endColumn - 1);
    return new vscode.Range(startLine, startCol, endLine, endCol);
  }
  // Default: highlight the first 5 (or all, if shorter) lines so CodeLens has a
  // real range to attach to.
  const endLine = Math.min(4, Math.max(0, doc.lineCount - 1));
  const endChar = doc.lineAt(endLine).text.length;
  return new vscode.Range(0, 0, endLine, endChar);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
