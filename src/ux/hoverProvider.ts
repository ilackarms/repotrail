import * as vscode from "vscode";
import { TourController } from "./tourController";

/**
 * Provides the active tour step's narration as a native VS Code hover whenever
 * the cursor (or mouse) is inside the step's highlighted range.
 *
 * Registered alongside the decoration-bound hoverMessage as belt-and-suspenders:
 * the decoration hover handles mouse-over reliably, this provider makes
 * `editor.action.showHover` work for the auto-pop call too.
 */
export class TourHoverProvider implements vscode.HoverProvider {
  constructor(private readonly controller: TourController) {}

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | null {
    const snap = this.controller.snapshot();
    if (!snap.current) return null;

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return null;

    const expected = vscode.Uri.joinPath(folder.uri, snap.current.file).toString();
    if (doc.uri.toString() !== expected) return null;

    const r = snap.current.range;
    if (r) {
      const range = new vscode.Range(
        Math.max(0, r.startLine - 1),
        Math.max(0, r.startColumn - 1),
        Math.max(0, r.endLine - 1),
        Math.max(0, r.endColumn - 1),
      );
      if (!range.contains(pos)) return null;
    } else {
      // No range — surface narration on the first 5 lines of the file.
      if (pos.line > 4) return null;
    }

    return new vscode.Hover(buildHoverMarkdown(snap.current));
  }
}

export function buildHoverMarkdown(step: {
  title: string;
  explanation: string;
}): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportThemeIcons = true;

  md.appendMarkdown(`### $(map) ${step.title}\n\n`);
  md.appendMarkdown(`${step.explanation}\n\n`);
  md.appendMarkdown(`---\n\n`);
  md.appendMarkdown(
    `[$(arrow-left) Back](command:codeAtlas.back) ` +
      `· [Next $(arrow-right)](command:codeAtlas.next) ` +
      `· [$(zoom-in) Deeper](command:codeAtlas.deeper) ` +
      `· [$(stop-circle) Stop](command:codeAtlas.stop) ` +
      `· [$(megaphone) Speak](command:codeAtlas.speakCurrent) ` +
      `· [$(unmute) TTS](command:codeAtlas.cycleTts)`,
  );
  return md;
}
