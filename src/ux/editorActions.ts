import * as vscode from "vscode";
import { DriftStatus, formatStepPath, TourPlan, TourStep, TourStepViewMode } from "../engine/types";
import { resolveStepUri } from "../workspace";

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

const DIFF_SCHEME = "repotrail-diff";
const MAX_ANCHOR_LEN = 200;
const diffDocuments = new Map<string, string>();
let diffProviderRegistered = false;
let diffDocumentSeq = 0;

export interface ExecuteResult {
  drift: DriftStatus;
  /** Anchor text captured on this show (only when the step had none yet). */
  capturedAnchor?: string;
}

let logger: vscode.OutputChannel | null = null;
export function setEditorLogger(channel: vscode.OutputChannel): void {
  logger = channel;
}

let tourPrimaryViewColumn: vscode.ViewColumn | undefined;

export function resetTourEditorLayout(): void {
  tourPrimaryViewColumn = undefined;
}

export async function executeStep(
  step: TourStep,
  opts?: { allSteps?: TourStep[]; currentIndex?: number; plan?: TourPlan },
): Promise<ExecuteResult> {
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    vscode.window.showErrorMessage("RepoTrail: open a workspace first.");
    return { drift: "ok" };
  }
  if (!step.file) return { drift: "ok" };

  const label = formatStepPath(step);
  let uri: vscode.Uri | null;
  try {
    uri = resolveStepUri(step, opts?.plan);
  } catch (err) {
    logger?.appendLine(`[editor] invalid step target ${label}: ${String(err)}`);
    vscode.window.showErrorMessage(`RepoTrail: invalid step target ${label}.`);
    return { drift: "missing" };
  }
  if (!uri) {
    logger?.appendLine(`[editor] no open workspace folder for ${label}`);
    vscode.window.showErrorMessage(`RepoTrail: cannot find workspace folder for ${label}.`);
    return { drift: "missing" };
  }
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (err) {
    logger?.appendLine(`[editor] open failed for ${label}: ${String(err)}`);
    vscode.window.showErrorMessage(`RepoTrail: cannot open ${label}.`);
    return { drift: "missing" };
  }
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

  const viewMode = effectiveViewMode(step);
  await closeRepoTrailDiffTabs();
  if (viewMode !== "diff") {
    const editor = await vscode.window.showTextDocument(doc, {
      preview: true,
      viewColumn: reusablePrimaryViewColumn() ?? vscode.ViewColumn.Active,
    });
    tourPrimaryViewColumn = editor.viewColumn;
    editor.setDecorations(HIGHLIGHT_DECORATION, [{ range }]);
    applyStopMarkers(editor, doc, step, opts);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    editor.selection = new vscode.Selection(range.start, range.start);
  }
  if (step.diff && viewMode !== "code") {
    await showStepDiff(step, doc, range);
  }

  logger?.appendLine(
    `[editor] step "${step.title}" range L${range.start.line + 1}:${range.start.character + 1}-L${range.end.line + 1}:${range.end.character + 1}` +
      (step.range ? "" : " (defaulted — agent omitted range)") +
      (step.diff && viewMode !== "code" ? ` [diff: ${viewMode}]` : "") +
      (drift !== "ok" ? ` [drift: ${drift}]` : ""),
  );

  return { drift, capturedAnchor };
}

/** Decorate the ranges of the other in-file stops with overview-ruler ticks. */
function applyStopMarkers(
  editor: vscode.TextEditor,
  doc: vscode.TextDocument,
  current: TourStep,
  opts?: { allSteps?: TourStep[]; currentIndex?: number; plan?: TourPlan },
): void {
  const all = opts?.allSteps;
  if (!all || all.length < 2) {
    editor.setDecorations(STOP_MARKER_DECORATION, []);
    return;
  }
  const ranges: vscode.Range[] = [];
  all.forEach((s, i) => {
    if (i === opts?.currentIndex) return;
    if (!s.range) return;
    let uri: vscode.Uri | null = null;
    try {
      uri = resolveStepUri(s, opts?.plan);
    } catch {
      return;
    }
    if (!uri || uri.toString() !== doc.uri.toString()) return;
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

function effectiveViewMode(step: TourStep): TourStepViewMode {
  if (!step.diff) return "code";
  return step.viewMode === "code" ? "code" : "diff";
}

async function showStepDiff(
  step: TourStep,
  doc: vscode.TextDocument,
  range: vscode.Range,
): Promise<void> {
  if (!step.diff) return;
  ensureDiffProvider();
  const afterText = step.diff.afterText ?? textForDiffAfter(doc, step, range);
  const beforeLabel = step.diff.beforeLabel ?? "Before";
  const afterLabel = step.diff.afterLabel ?? "After";
  const beforeUri = virtualDiffUri(step, beforeLabel, step.diff.beforeText);
  const afterUri = virtualDiffUri(step, afterLabel, afterText);
  await setVirtualDocLanguage(beforeUri, step.diff.languageId);
  await setVirtualDocLanguage(afterUri, step.diff.languageId);
  await vscode.commands.executeCommand(
    "vscode.diff",
    beforeUri,
    afterUri,
    `${formatStepPath(step)}: ${beforeLabel} -> ${afterLabel}`,
    {
      preview: true,
      viewColumn: reusablePrimaryViewColumn() ?? vscode.ViewColumn.Active,
    },
  );
  tourPrimaryViewColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
}

function reusablePrimaryViewColumn(): vscode.ViewColumn | undefined {
  if (!tourPrimaryViewColumn) return undefined;
  return vscode.window.tabGroups.all.some((group) => group.viewColumn === tourPrimaryViewColumn)
    ? tourPrimaryViewColumn
    : undefined;
}

async function closeRepoTrailDiffTabs(): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter(isRepoTrailDiffTab);
  if (tabs.length === 0) return;
  const closed = await vscode.window.tabGroups.close(tabs, false);
  if (!closed) {
    logger?.appendLine("[editor] stale RepoTrail diff tabs could not be closed before navigation");
  }
}

function isRepoTrailDiffTab(tab: vscode.Tab): boolean {
  if (!(tab.input instanceof vscode.TabInputTextDiff)) return false;
  return tab.input.original.scheme === DIFF_SCHEME || tab.input.modified.scheme === DIFF_SCHEME;
}

function ensureDiffProvider(): void {
  if (diffProviderRegistered) return;
  vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, {
    provideTextDocumentContent(uri: vscode.Uri): string {
      return diffDocuments.get(uri.toString()) ?? "";
    },
  });
  diffProviderRegistered = true;
}

function virtualDiffUri(step: TourStep, label: string, text: string): vscode.Uri {
  const ext = extensionForFile(step.file);
  const slug = sanitizePathPart(`${step.title}-${label}`) || "step";
  const uri = vscode.Uri.from({
    scheme: DIFF_SCHEME,
    path: `/${diffDocumentSeq++}-${slug}${ext}`,
  });
  diffDocuments.set(uri.toString(), text);
  return uri;
}

async function setVirtualDocLanguage(uri: vscode.Uri, languageId?: string): Promise<void> {
  if (!languageId) return;
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(doc, languageId);
  } catch (err) {
    logger?.appendLine(`[editor] diff language "${languageId}" ignored: ${String(err)}`);
  }
}

function textForDiffAfter(doc: vscode.TextDocument, step: TourStep, range: vscode.Range): string {
  if (!step.range) return doc.getText(range);
  const eol = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
  const startLine = clamp(step.range.startLine - 1, 0, doc.lineCount - 1);
  const endLine = clamp(step.range.endLine - 1, startLine, doc.lineCount - 1);
  const lines: string[] = [];
  for (let line = startLine; line <= endLine; line++) {
    lines.push(doc.lineAt(line).text);
  }
  return lines.join(eol);
}

function extensionForFile(file: string): string {
  const match = /(\.[A-Za-z0-9]+)$/.exec(file);
  return match?.[1] ?? ".txt";
}

function sanitizePathPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
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
  plan?: TourPlan,
): Promise<{ drift: DriftStatus; capturedAnchor?: string }> {
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) return { drift: "ok" };
  if (!step.file || !step.range) return { drift: "ok" };
  let uri: vscode.Uri | null;
  try {
    uri = resolveStepUri(step, plan);
  } catch {
    return { drift: "missing" };
  }
  if (!uri) return { drift: "missing" };
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
