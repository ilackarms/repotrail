import * as vscode from "vscode";
import { TourPlan, TourStep, TourStepDiffScope } from "./engine/types";
import { readGitBlobText } from "./gitBlob";
import { normalizeWorkspaceFile, resolveStepWorkspaceFolder } from "./workspace";

export interface MaterializedStepDiff {
  beforeText: string;
  afterText: string;
  beforeLabel: string;
  afterLabel: string;
  languageId?: string;
  scope: TourStepDiffScope;
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
  if (diff.baseRef) {
    if (!folder) {
      vscode.window.showErrorMessage(`RepoTrail: cannot resolve workspace folder for git diff ${step.file}.`);
      return null;
    }
    const baseFile = normalizeWorkspaceFile(diff.baseFile ?? step.file);
    try {
      const base = await readGitBlobText(folder.uri.fsPath, diff.baseRef, baseFile);
      beforeText = base.text;
      beforeLabel = diff.beforeLabel ?? labelForGitSide(diff.baseRef, base.gitPath, base.missing);
    } catch (err) {
      reportMaterializeError("base", step, err, logger);
      return null;
    }
  } else {
    beforeText = diff.beforeText;
  }

  if (beforeText === undefined) {
    vscode.window.showErrorMessage(
      `RepoTrail: diff step "${step.title}" needs diff.baseRef or diff.beforeText.`,
    );
    return null;
  }

  let afterText: string;
  let afterLabel = diff.afterLabel ?? "After";
  if (diff.headRef) {
    if (!folder) {
      vscode.window.showErrorMessage(`RepoTrail: cannot resolve workspace folder for git diff ${step.file}.`);
      return null;
    }
    const headFile = normalizeWorkspaceFile(diff.headFile ?? step.file);
    try {
      const head = await readGitBlobText(folder.uri.fsPath, diff.headRef, headFile);
      afterText = head.text;
      afterLabel = diff.afterLabel ?? labelForGitSide(diff.headRef, head.gitPath, head.missing);
    } catch (err) {
      reportMaterializeError("head", step, err, logger);
      return null;
    }
  } else if (typeof diff.afterText === "string") {
    afterText = diff.afterText;
  } else {
    afterText = scope === "file" ? doc.getText() : textForDiffAfter(doc, step, range);
    afterLabel = diff.afterLabel ?? (diff.baseRef ? "Workspace" : "After");
  }

  return {
    beforeText,
    afterText,
    beforeLabel,
    afterLabel,
    languageId,
    scope,
  };
}

export function effectiveDiffScope(step: TourStep): TourStepDiffScope {
  const diff = step.diff;
  if (!diff) return "hunk";
  if (diff.scope === "file" || diff.scope === "hunk") return diff.scope;
  return diff.baseRef || diff.headRef || diff.baseFile || diff.headFile ? "file" : "hunk";
}

export function textForDiffAfter(
  doc: vscode.TextDocument,
  step: TourStep,
  range: vscode.Range,
): string {
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
  vscode.window.showErrorMessage(`RepoTrail: could not read ${side} ref for ${step.file}.`);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
