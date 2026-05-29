import * as vscode from "vscode";
import { TourStep } from "../engine/types";

/**
 * Executes a TourStep's declarative actions against the editor.
 *
 * Only place that calls `vscode.window.show*` / `vscode.workspace.openTextDocument`.
 *
 * Narration is shown two ways:
 *   1. A markdown hover bound to the highlighted decoration. Cursor-on-range
 *      triggers the standard VS Code hover popup. We auto-invoke
 *      `editor.action.showHover` after each step so the user sees it
 *      immediately without having to mouse over.
 *   2. The TourCodeLensProvider renders a control strip above the highlight.
 */

const HIGHLIGHT_DECORATION = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
  border: "1px solid",
  borderColor: new vscode.ThemeColor("editor.findMatchBorder"),
  isWholeLine: false,
  overviewRulerColor: new vscode.ThemeColor("editor.findMatchBorder"),
  overviewRulerLane: vscode.OverviewRulerLane.Right,
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
      const range = new vscode.Range(
        Math.max(0, r.startLine - 1),
        Math.max(0, r.startColumn - 1),
        Math.max(0, r.endLine - 1),
        Math.max(0, r.endColumn - 1),
      );

      const hover = buildHoverMarkdown(step);
      editor.setDecorations(HIGHLIGHT_DECORATION, [{ range, hoverMessage: hover }]);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(range.start, range.start);

      // Pop the hover immediately so user doesn't have to mouse over.
      // showHover requires the editor to have focus; showTextDocument above
      // gives it focus, but defer one tick so the decoration is registered.
      setTimeout(() => {
        vscode.commands.executeCommand("editor.action.showHover").then(undefined, () => {});
      }, 50);
    } else {
      // No range — just open the file. Show the narration as a non-modal info
      // notification so user still gets the explanation.
      vscode.window.showInformationMessage(`${step.title}: ${truncate(step.explanation, 200)}`);
    }
  }
}

export function clearHighlights(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    editor.setDecorations(HIGHLIGHT_DECORATION, []);
  }
}

function buildHoverMarkdown(step: TourStep): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportHtml = false;
  md.supportThemeIcons = true;

  md.appendMarkdown(`### $(map) ${escapeMd(step.title)}\n\n`);
  md.appendMarkdown(`${step.explanation}\n\n`);
  md.appendMarkdown(`---\n\n`);
  md.appendMarkdown(
    `[$(arrow-left) Back](command:codeAtlas.back) ` +
      `· [Next $(arrow-right)](command:codeAtlas.next) ` +
      `· [$(zoom-in) Deeper](command:codeAtlas.deeper) ` +
      `· [$(stop-circle) Stop](command:codeAtlas.stop)`,
  );
  return md;
}

function escapeMd(s: string): string {
  return s.replace(/([\\`*_{}\[\]()#+\-.!])/g, "\\$1");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
