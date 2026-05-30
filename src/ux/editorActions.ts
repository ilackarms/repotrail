import * as vscode from "vscode";
import { TourStep } from "../engine/types";

/**
 * Executes a TourStep's declarative actions against the editor.
 *
 * Only place that calls `vscode.window.show*` / `vscode.workspace.openTextDocument`.
 *
 * Narration stays outside the code surface:
 *   1. The sidebar renders the full current-step narration durably.
 *   2. TourCodeLensProvider draws a control strip above the range and can focus
 *      the sidebar when the user wants to read the narration.
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

let logger: vscode.OutputChannel | null = null;
export function setEditorLogger(channel: vscode.OutputChannel): void {
  logger = channel;
}

export async function executeStep(step: TourStep): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage("Code Atlas: open a workspace first.");
    return;
  }
  if (!step.file) return;

  const uri = vscode.Uri.joinPath(folder.uri, step.file);
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (err) {
    logger?.appendLine(`[editor] open failed for ${step.file}: ${String(err)}`);
    vscode.window.showErrorMessage(`Code Atlas: cannot open ${step.file}.`);
    return;
  }
  const editor = await vscode.window.showTextDocument(doc, { preview: false });

  const range = resolveRange(step, doc);
  editor.setDecorations(HIGHLIGHT_DECORATION, [{ range }]);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  editor.selection = new vscode.Selection(range.start, range.start);

  logger?.appendLine(
    `[editor] step "${step.title}" range L${range.start.line + 1}:${range.start.character + 1}-L${range.end.line + 1}:${range.end.character + 1}` +
      (step.range ? "" : " (defaulted — agent omitted range)"),
  );

}

export function clearHighlights(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    editor.setDecorations(HIGHLIGHT_DECORATION, []);
  }
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
