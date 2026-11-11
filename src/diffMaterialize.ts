import * as vscode from "vscode";
import { TourPlan, TourStep, TourStepDiffScope } from "./engine/types";
import { readGitBlobText } from "./gitBlob";
import { plainMessageText } from "./ux/messageText";
import { normalizeWorkspaceFile, resolveStepWorkspaceFolder } from "./workspace";

export interface MaterializedStepDiff {
  beforeText: string;
  afterText: string;
  beforeLabel: string;
  afterLabel: string;
  languageId?: string;
  scope: TourStepDiffScope;
  /**
   * Set when the right side was read from the workspace document: the 0-based
   * source line of the text's first line. Lets editor features map virtual
   * positions back to the real file exactly.
   */
  afterWorkspaceLineOffset?: number;
  /** Git source of each side, when it was read from a ref. */
  beforeGit?: GitDiffSide;
  afterGit?: GitDiffSide;
}

export interface GitDiffSide {
  /** Workspace URI of the file path at that ref (may not exist on disk). */
  fileUri: vscode.Uri;
  ref: string;
}

export async function materializeStepDiff(
  step: TourStep,
  doc: vscode.TextDocument,
  range: vscode.Range,
  plan?: TourPlan,
  logger?: vscode.OutputChannel | null,
): Promise<MaterializedStepDiff | null> {
  const diff = step.diff;
  if (!diff) return null;

  const scope = effectiveDiffScope(step);
  const languageId = diff.languageId ?? doc.languageId;
  const folder = resolveStepWorkspaceFolder(step, plan) ?? vscode.workspace.getWorkspaceFolder(doc.uri) ?? null;

  let beforeText: string | undefined;
  let beforeLabel = diff.beforeLabel ?? "Before";
  let beforeGit: GitDiffSide | undefined;
  if (diff.baseRef) {
    if (!folder) {
      vscode.window.showErrorMessage(`RepoTrail: cannot resolve workspace folder for git diff ${plainMessageText(step.file)}.`);
      return null;
    }
    const baseFile = normalizeWorkspaceFile(diff.baseFile ?? step.file);
    try {
      const base = await readGitBlobText(folder.uri.fsPath, diff.baseRef, baseFile);
      beforeText = base.text;
      beforeLabel = diff.beforeLabel ?? labelForGitSide(diff.baseRef, base.gitPath, base.missing);
      beforeGit = { fileUri: vscode.Uri.joinPath(folder.uri, ...baseFile.split("/")), ref: diff.baseRef };
    } catch (err) {
      reportMaterializeError("base", step, err, logger);
      return null;
    }
  } else {
    beforeText = diff.beforeText;
  }

  if (beforeText === undefined) {
    vscode.window.showErrorMessage(
      `RepoTrail: diff step "${plainMessageText(step.title)}" needs diff.baseRef or diff.beforeText.`,
    );
    return null;
  }

  let afterText: string;
  let afterLabel = diff.afterLabel ?? "After";
  let afterWorkspaceLineOffset: number | undefined;
  let afterGit: GitDiffSide | undefined;
  if (diff.headRef) {
    if (!folder) {
      vscode.window.showErrorMessage(`RepoTrail: cannot resolve workspace folder for git diff ${plainMessageText(step.file)}.`);
      return null;
    }
    const headFile = normalizeWorkspaceFile(diff.headFile ?? step.file);
    try {
      const head = await readGitBlobText(folder.uri.fsPath, diff.headRef, headFile);
      afterText = head.text;
      afterLabel = diff.afterLabel ?? labelForGitSide(diff.headRef, head.gitPath, head.missing);
      afterGit = { fileUri: vscode.Uri.joinPath(folder.uri, ...headFile.split("/")), ref: diff.headRef };
    } catch (err) {
      reportMaterializeError("head", step, err, logger);
      return null;
    }
  } else if (typeof diff.afterText === "string") {
    afterText = diff.afterText;
  } else {
    afterText = scope === "file" ? doc.getText() : textForDiffAfter(doc, step, range);
    afterLabel = diff.afterLabel ?? (diff.baseRef ? "Workspace" : "After");
    afterWorkspaceLineOffset = scope === "file" ? 0 : diffAfterStartLine(doc, step, range);
  }

  return {
    beforeText,
    afterText,
    beforeLabel,
    afterLabel,
    languageId,
    scope,
    afterWorkspaceLineOffset,
    beforeGit,
    afterGit,
  };
}

export function effectiveDiffScope(step: TourStep): TourStepDiffScope {
  const diff = step.diff;
  if (!diff) return "hunk";
  if (diff.scope === "file" || diff.scope === "hunk") return diff.scope;
  return diff.baseRef || diff.headRef || diff.baseFile || diff.headFile ? "file" : "hunk";
}

/** 0-based workspace line where `textForDiffAfter` starts. */
function diffAfterStartLine(doc: vscode.TextDocument, step: TourStep, range: vscode.Range): number {
  return step.range ? clamp(step.range.startLine - 1, 0, doc.lineCount - 1) : range.start.line;
}

export function textForDiffAfter(
  doc: vscode.TextDocument,
  step: TourStep,
  range: vscode.Range,
): string {
  if (!step.range) return doc.getText(range);
  const eol = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
  const startLine = diffAfterStartLine(doc, step, range);
  const endLine = clamp(step.range.endLine - 1, startLine, doc.lineCount - 1);
  const lines: string[] = [];
  for (let line = startLine; line <= endLine; line++) {
    lines.push(doc.lineAt(line).text);
  }
  return lines.join(eol);
}

function labelForGitSide(ref: string, file: string, missing: boolean): string {
  const suffix = missing ? " (missing)" : "";
  return `${ref}:${file}${suffix}`;
}

function reportMaterializeError(
  side: "base" | "head",
  step: TourStep,
  err: unknown,
  logger?: vscode.OutputChannel | null,
): void {
  const detail = err instanceof Error ? err.message : String(err);
  logger?.appendLine(`[diff] failed to materialize ${side} for ${step.file}: ${detail}`);
  vscode.window.showErrorMessage(`RepoTrail: could not read ${side} ref for ${plainMessageText(step.file)}.`);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
