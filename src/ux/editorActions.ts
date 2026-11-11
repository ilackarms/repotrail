import * as vscode from "vscode";
import { GitDiffSide, materializeStepDiff } from "../diffMaterialize";
import { DriftStatus, formatStepPath, TourPlan, TourStep, TourStepViewMode } from "../engine/types";
import { readGitBlobText } from "../gitBlob";
import { normalizeWorkspaceFile, resolveStepUri, resolveStepWorkspaceFolder } from "../workspace";
import { mapDiffPositionToSource, sameDocumentText } from "./diffPositionMap";
import { diffRevealTargetForRange } from "./diffReveal";
import { plainMessageText } from "./messageText";

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
/** Real workspace file behind each virtual diff side, for go-to-definition. */
const diffDocumentSources = new Map<string, { sourceUri: vscode.Uri; lineOffset?: number }>();
let diffProviderRegistered = false;
let diffDocumentSeq = 0;

export interface ExecuteResult {
  drift: DriftStatus;
  /** Anchor text captured on this show (only when the step had none yet). */
  capturedAnchor?: string;
}

interface StepEditorOptions {
  allSteps?: TourStep[];
  currentIndex?: number;
  plan?: TourPlan;
}

interface PreparedStep {
  doc: vscode.TextDocument;
  range: vscode.Range;
  drift: DriftStatus;
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
  opts?: StepEditorOptions,
): Promise<ExecuteResult> {
  if (!step.file) return { drift: "ok" };
  // Close the previous stop's diff first: its cleanup drops virtual documents
  // no tab shows, which must not include the one prepareStep may create.
  await closeRepoTrailDiffTabs();
  const prepared = await prepareStep(step, opts);
  if (!prepared) return { drift: "missing" };

  const viewMode = effectiveViewMode(step);
  if (viewMode !== "diff") {
    await showSourceDocument(step, prepared.doc, prepared.range, opts, true);
  }
  if (step.diff && viewMode !== "code") {
    await showStepDiff(step, prepared.doc, prepared.range, opts?.plan);
  }

  logger?.appendLine(
    `[editor] step "${step.title}" range L${prepared.range.start.line + 1}:${prepared.range.start.character + 1}-L${prepared.range.end.line + 1}:${prepared.range.end.character + 1}` +
      (step.range ? "" : " (defaulted — agent omitted range)") +
      (step.diff && viewMode !== "code" ? ` [diff: ${viewMode}]` : "") +
      (prepared.drift !== "ok" ? ` [drift: ${prepared.drift}]` : ""),
  );

  return { drift: prepared.drift, capturedAnchor: prepared.capturedAnchor };
}

export async function openStepSource(
  step: TourStep,
  opts?: StepEditorOptions,
): Promise<ExecuteResult> {
  if (!step.file) return { drift: "ok" };
  await closeRepoTrailDiffTabs();
  const prepared = await prepareStep(step, opts, { preferWorkingTree: true });
  if (!prepared) return { drift: "missing" };

  await showSourceDocument(step, prepared.doc, prepared.range, opts, false);

  logger?.appendLine(
    `[editor] source "${step.title}" range L${prepared.range.start.line + 1}:${prepared.range.start.character + 1}-L${prepared.range.end.line + 1}:${prepared.range.end.character + 1}` +
      (prepared.drift !== "ok" ? ` [drift: ${prepared.drift}]` : ""),
  );

  return { drift: prepared.drift, capturedAnchor: prepared.capturedAnchor };
}

async function prepareStep(
  step: TourStep,
  opts?: StepEditorOptions,
  documentOptions: { preferWorkingTree?: boolean } = {},
): Promise<PreparedStep | null> {
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    vscode.window.showErrorMessage("RepoTrail: open a workspace first.");
    return null;
  }

  const label = formatStepPath(step);
  let uri: vscode.Uri | null;
  try {
    uri = resolveStepUri(step, opts?.plan);
  } catch (err) {
    logger?.appendLine(`[editor] invalid step target ${label}: ${String(err)}`);
    vscode.window.showErrorMessage(`RepoTrail: invalid step target ${plainMessageText(label)}.`);
    return null;
  }
  if (!uri) {
    logger?.appendLine(`[editor] no open workspace folder for ${label}`);
    vscode.window.showErrorMessage(`RepoTrail: cannot find workspace folder for ${plainMessageText(label)}.`);
    return null;
  }

  let doc: vscode.TextDocument;
  try {
    doc = await openStepDocument(step, uri, opts?.plan, documentOptions);
  } catch (err) {
    logger?.appendLine(`[editor] open failed for ${label}: ${String(err)}`);
    vscode.window.showErrorMessage(`RepoTrail: cannot open ${plainMessageText(label)}.`);
    return null;
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

  return { doc, range, drift, capturedAnchor };
}

/**
 * Open the document a step's range refers to. A diff stop that pins both sides
 * to commits (hex baseRef and headRef) doesn't depend on what is checked out:
 * its range and anchor refer to the file at headRef. So the working-tree file
 * is used only when its text matches headRef; otherwise (a different branch,
 * or a file the change adds) the file is read from git at headRef, or at
 * baseRef for a file the change deletes. `preferWorkingTree` keeps the real
 * file whenever it exists, for "Open Current Source".
 */
async function openStepDocument(
  step: TourStep,
  uri: vscode.Uri,
  plan?: TourPlan,
  options: { preferWorkingTree?: boolean } = {},
): Promise<vscode.TextDocument> {
  if (!isPinnedDiff(step)) return vscode.workspace.openTextDocument(uri);
  let working: vscode.TextDocument | undefined;
  let workingError: unknown;
  try {
    working = await vscode.workspace.openTextDocument(uri);
  } catch (err) {
    workingError = err;
  }
  if (working && options.preferWorkingTree) return working;
  const revision = await openStepRevision(step, uri, plan, working);
  if (revision) return revision;
  if (working) return working;
  throw workingError;
}

const COMMIT_REF = /^[0-9a-f]{7,40}$/i;

function isPinnedDiff(step: TourStep): boolean {
  const diff = step.diff;
  return Boolean(
    diff?.baseRef && diff.headRef && COMMIT_REF.test(diff.baseRef) && COMMIT_REF.test(diff.headRef) &&
      effectiveViewMode(step) === "diff",
  );
}

async function openStepRevision(
  step: TourStep,
  uri: vscode.Uri,
  plan: TourPlan | undefined,
  working: vscode.TextDocument | undefined,
): Promise<vscode.TextDocument | null> {
  const diff = step.diff;
  if (!diff?.baseRef || !diff.headRef) return null;
  const folder = resolveStepWorkspaceFolder(step, plan);
  if (!folder) return null;
  const sides = [
    { ref: diff.headRef, file: diff.headFile ?? step.file },
    { ref: diff.baseRef, file: diff.baseFile ?? step.file },
  ];
  for (const side of sides) {
    try {
      const file = normalizeWorkspaceFile(side.file);
      const blob = await readGitBlobText(folder.uri.fsPath, side.ref, file);
      if (blob.missing) continue;
      if (working && sameDocumentText(working.getText(), blob.text)) return working;
      const fileUri = vscode.Uri.joinPath(folder.uri, ...file.split("/"));
      const gitUri = await builtInGitUri({ fileUri, ref: side.ref }, blob.text);
      if (gitUri) diffDocumentSources.set(gitUri.toString(), { sourceUri: uri });
      const doc = await vscode.workspace.openTextDocument(
        gitUri ?? virtualDiffUri(step, side.ref.slice(0, 12), blob.text, { sourceUri: uri }),
      );
      logger?.appendLine(
        `[editor] ${formatStepPath(step)} ${working ? "differs from" : "isn't in"} the working tree; using it at ${side.ref}`,
      );
      return doc;
    } catch (err) {
      logger?.appendLine(`[editor] could not read ${side.file} at ${side.ref}: ${String(err)}`);
    }
  }
  return null;
}

async function showSourceDocument(
  step: TourStep,
  doc: vscode.TextDocument,
  range: vscode.Range,
  opts: StepEditorOptions | undefined,
  preview: boolean,
): Promise<void> {
  const editor = await vscode.window.showTextDocument(doc, {
    preview,
    viewColumn: reusablePrimaryViewColumn() ?? vscode.ViewColumn.Active,
  });
  tourPrimaryViewColumn = editor.viewColumn;
  editor.setDecorations(HIGHLIGHT_DECORATION, [{ range }]);
  applyStopMarkers(editor, doc, step, opts);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  editor.selection = new vscode.Selection(range.start, range.start);
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
  plan?: TourPlan,
): Promise<void> {
  if (!step.diff) return;
  const materialized = await materializeStepDiff(step, doc, range, plan, logger);
  if (!materialized) return;
  ensureDiffProvider();
  // When the right side is exactly the workspace file, show the real file so
  // the language server attaches: cmd+click, hover, and edits work natively,
  // as in VS Code's own working-tree diffs. Otherwise it stays virtual and the
  // definition provider below maps clicks back to the real file.
  const afterIsWorkspaceFile =
    materialized.scope === "file" && sameDocumentText(materialized.afterText, doc.getText());
  const beforeUri = await diffSideUri(step, materialized.beforeLabel, materialized.beforeText, materialized.beforeGit, {
    sourceUri: doc.uri,
  });
  const afterUri = afterIsWorkspaceFile
    ? doc.uri
    : await diffSideUri(step, materialized.afterLabel, materialized.afterText, materialized.afterGit, {
        sourceUri: doc.uri,
        lineOffset: materialized.afterWorkspaceLineOffset,
      });
  await setVirtualDocLanguage(beforeUri, materialized.languageId);
  if (!afterIsWorkspaceFile) await setVirtualDocLanguage(afterUri, materialized.languageId);
  const reveal = diffRevealTargetForRange(range, materialized.scope);
  await vscode.commands.executeCommand(
    "vscode.diff",
    beforeUri,
    afterUri,
    `${formatStepPath(step)}: ${materialized.beforeLabel} -> ${materialized.afterLabel}`,
    {
      preview: true,
      viewColumn: reusablePrimaryViewColumn() ?? vscode.ViewColumn.Active,
      selection: new vscode.Range(
        reveal.startLine,
        reveal.startCharacter,
        reveal.endLine,
        reveal.endCharacter,
      ),
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
  if (tabs.length > 0) {
    const closed = await vscode.window.tabGroups.close(tabs, false);
    if (!closed) {
      logger?.appendLine("[editor] stale RepoTrail diff tabs could not be closed before navigation");
    }
  }
  pruneDiffDocuments();
}

/** Drop virtual diff text no open tab still shows, so long tours don't pile up file copies. */
function pruneDiffDocuments(): void {
  const live = new Set<string>();
  for (const tab of vscode.window.tabGroups.all.flatMap((group) => group.tabs)) {
    if (tab.input instanceof vscode.TabInputTextDiff) {
      live.add(tab.input.original.toString());
      live.add(tab.input.modified.toString());
    } else if (tab.input instanceof vscode.TabInputText) {
      live.add(tab.input.uri.toString());
    }
  }
  for (const key of [...diffDocuments.keys(), ...diffDocumentSources.keys()]) {
    if (live.has(key)) continue;
    diffDocuments.delete(key);
    diffDocumentSources.delete(key);
  }
}

function isRepoTrailDiffTab(tab: vscode.Tab): boolean {
  if (!(tab.input instanceof vscode.TabInputTextDiff)) return false;
  const { original, modified } = tab.input;
  return (
    original.scheme === DIFF_SCHEME ||
    modified.scheme === DIFF_SCHEME ||
    diffDocumentSources.has(original.toString()) ||
    diffDocumentSources.has(modified.toString())
  );
}

function ensureDiffProvider(): void {
  if (diffProviderRegistered) return;
  vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, {
    provideTextDocumentContent(uri: vscode.Uri): string {
      return diffDocuments.get(uri.toString()) ?? "";
    },
  });
  // `git` covers sides served by the built-in Git extension; the provider only
  // answers for URIs RepoTrail opened, so other git: documents are untouched.
  vscode.languages.registerDefinitionProvider([{ scheme: DIFF_SCHEME }, { scheme: "git" }], {
    provideDefinition: provideDiffDefinition,
  });
  diffProviderRegistered = true;
}

interface GitExtensionExports {
  getAPI(version: 1): { toGitUri(uri: vscode.Uri, ref: string): vscode.Uri };
}

/**
 * URI for one diff side. Git-backed sides prefer the built-in Git extension's
 * `git:` URIs, as VS Code's own Source Control diffs do: TypeScript and other
 * language servers skip that scheme, so cmd+click there reaches only our
 * definition provider instead of also resolving inside the copied text. Falls
 * back to RepoTrail's own scheme when Git is unavailable or its text differs.
 */
async function diffSideUri(
  step: TourStep,
  label: string,
  text: string,
  git: GitDiffSide | undefined,
  source: { sourceUri: vscode.Uri; lineOffset?: number },
): Promise<vscode.Uri> {
  if (git) {
    const uri = await builtInGitUri(git, text);
    if (uri) {
      diffDocumentSources.set(uri.toString(), source);
      return uri;
    }
  }
  return virtualDiffUri(step, label, text, source);
}

async function builtInGitUri(side: GitDiffSide, expectedText: string): Promise<vscode.Uri | undefined> {
  try {
    const ext = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
    if (!ext) return undefined;
    const exports = ext.isActive ? ext.exports : await ext.activate();
    const uri = exports.getAPI(1).toGitUri(side.fileUri, side.ref);
    const doc = await vscode.workspace.openTextDocument(uri);
    if (sameDocumentText(doc.getText(), expectedText)) return uri;
    logger?.appendLine(`[editor] git:${side.ref} text differs from RepoTrail's read; using a RepoTrail diff document`);
  } catch (err) {
    logger?.appendLine(`[editor] built-in git URI unavailable: ${String(err)}`);
  }
  return undefined;
}

/**
 * Cmd+click inside a virtual diff side. Language servers don't attach to the
 * `repotrail-diff` scheme, so map the click onto the real workspace file and
 * ask its providers. With no definition there, land on the matching code in
 * the real file; as a last resort, use workspace symbols with the same name.
 */
async function provideDiffDefinition(
  doc: vscode.TextDocument,
  position: vscode.Position,
): Promise<vscode.Definition | vscode.LocationLink[] | undefined> {
  const source = diffDocumentSources.get(doc.uri.toString());
  const wordRange = doc.getWordRangeAtPosition(position);
  if (!source || !wordRange) return undefined;
  const word = doc.getText(wordRange);

  let sourceDoc: vscode.TextDocument;
  try {
    sourceDoc = await vscode.workspace.openTextDocument(source.sourceUri);
  } catch {
    return undefined;
  }
  const mapped = mapDiffPositionToSource({
    virtualLines: documentLines(doc),
    position: { line: position.line, character: position.character },
    word,
    sourceLines: documentLines(sourceDoc),
    lineOffset: source.lineOffset,
  });

  if (mapped) {
    const sourcePosition = new vscode.Position(mapped.line, mapped.character);
    const found = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
      "vscode.executeDefinitionProvider",
      source.sourceUri,
      sourcePosition,
    );
    if (found && found.length > 0) {
      // Re-anchor the underline to the word in this virtual document.
      return found.map((d) =>
        d instanceof vscode.Location
          ? { originSelectionRange: wordRange, targetUri: d.uri, targetRange: d.range, targetSelectionRange: d.range }
          : { ...d, originSelectionRange: wordRange },
      );
    }
    const target = new vscode.Range(sourcePosition, sourcePosition.translate(0, word.length));
    return [{ originSelectionRange: wordRange, targetUri: source.sourceUri, targetRange: target, targetSelectionRange: target }];
  }

  const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    "vscode.executeWorkspaceSymbolProvider",
    word,
  );
  const exact = (symbols ?? []).filter((s) => s.name === word).slice(0, 20);
  return exact.length > 0 ? exact.map((s) => s.location) : undefined;
}

function documentLines(doc: vscode.TextDocument): string[] {
  const lines: string[] = [];
  for (let i = 0; i < doc.lineCount; i++) lines.push(doc.lineAt(i).text);
  return lines;
}

function virtualDiffUri(
  step: TourStep,
  label: string,
  text: string,
  source: { sourceUri: vscode.Uri; lineOffset?: number },
): vscode.Uri {
  ensureDiffProvider();
  const ext = extensionForFile(step.file);
  const slug = sanitizePathPart(`${step.title}-${label}`) || "step";
  const uri = vscode.Uri.from({
    scheme: DIFF_SCHEME,
    path: `/${diffDocumentSeq++}-${slug}${ext}`,
  });
  diffDocuments.set(uri.toString(), text);
  diffDocumentSources.set(uri.toString(), source);
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
    doc = await openStepDocument(step, uri, plan);
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
