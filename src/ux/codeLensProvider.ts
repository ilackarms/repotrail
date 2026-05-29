import * as vscode from "vscode";
import { TourController } from "./tourController";

/**
 * Renders a control strip as CodeLenses on the line above the current step's
 * highlight. The lens text is the step title + position; the buttons are
 * `← Back · Next → · Deeper · Stop`.
 *
 * Refreshes whenever the controller fires onDidChange (start_tour, add_step,
 * next, back, stop). Only emits lenses for the currently-active file.
 */
export class TourCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly controller: TourController) {
    controller.onDidChange(() => this.emitter.fire());
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const snap = this.controller.snapshot();
    if (!snap.plan || !snap.current || !snap.current.range) return [];

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return [];

    const expected = vscode.Uri.joinPath(folder.uri, snap.current.file).toString();
    if (doc.uri.toString() !== expected) return [];

    const startLine = Math.max(0, snap.current.range.startLine - 1);
    const lensRange = new vscode.Range(startLine, 0, startLine, 0);

    const headerTitle = `$(map) Step ${snap.index + 1}/${snap.plan.steps.length}: ${snap.current.title}`;

    return [
      new vscode.CodeLens(lensRange, { title: headerTitle, command: "" }),
      new vscode.CodeLens(lensRange, {
        title: "$(arrow-left) Back",
        command: "codeAtlas.back",
      }),
      new vscode.CodeLens(lensRange, {
        title: "Next $(arrow-right)",
        command: "codeAtlas.next",
      }),
      new vscode.CodeLens(lensRange, {
        title: "$(zoom-in) Deeper",
        command: "codeAtlas.deeper",
      }),
      new vscode.CodeLens(lensRange, {
        title: "$(stop-circle) Stop",
        command: "codeAtlas.stop",
      }),
      new vscode.CodeLens(lensRange, {
        title: "$(book) Show narration",
        command: "codeAtlas.showHoverNarration",
      }),
    ];
  }
}
