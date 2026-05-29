import * as vscode from "vscode";
import { TourStep } from "../engine/types";

/**
 * Executes a TourStep's declarative actions against the editor.
 *
 * This module is the ONLY place that calls `vscode.window.show*` /
 * `vscode.workspace.openTextDocument`. Keep all editor I/O here so the
 * engine stays pure and the UX surface is auditable.
 */

const HIGHLIGHT_DECORATION = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
  border: "1px solid",
  borderColor: new vscode.ThemeColor("editor.findMatchBorder"),
  isWholeLine: false,
});

export async function executeStep(step: TourStep): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage("Code Atlas: open a workspace first.");
    return;
  }

  if (step.actions.includes("openFile") && step.file) {
    const uri = vscode.Uri.joinPath(folder.uri, step.file);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });

    if (step.range && step.actions.includes("highlightRange")) {
      const r = step.range;
      // Convert 1-indexed TourRange to 0-indexed VS Code Range.
      const range = new vscode.Range(
        Math.max(0, r.startLine - 1),
        Math.max(0, r.startColumn - 1),
        Math.max(0, r.endLine - 1),
        Math.max(0, r.endColumn - 1),
      );
      editor.setDecorations(HIGHLIGHT_DECORATION, [range]);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(range.start, range.start);
    }
  }
}

export function clearHighlights(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    editor.setDecorations(HIGHLIGHT_DECORATION, []);
  }
}
