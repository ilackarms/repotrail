import * as vscode from "vscode";
import { TourController } from "./tourController";

/**
 * Renders a control strip as CodeLenses on the line above the current step's
 * highlight. Shows step title + Back / Next / Deeper / Stop / Show narration.
 *
 * Refreshes on controller.onDidChange. Only emits for the file the current
 * step points at. If the agent omitted `range`, anchors to line 1.
 */
export class TourCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly controller: TourController) {
    controller.onDidChange(() => this.emitter.fire());
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const snap = this.controller.snapshot();
    if (!snap.plan || !snap.current) return [];

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return [];

    const expected = vscode.Uri.joinPath(folder.uri, snap.current.file).toString();
    if (doc.uri.toString() !== expected) return [];

    const startLine = Math.max(0, (snap.current.range?.startLine ?? 1) - 1);
    const anchored = Math.min(startLine, Math.max(0, doc.lineCount - 1));
    const lensRange = new vscode.Range(anchored, 0, anchored, 0);

    const header = `$(map) Step ${snap.index + 1}/${snap.plan.steps.length}: ${snap.current.title}`;

    return [
      new vscode.CodeLens(lensRange, { title: header, command: "" }),
      new vscode.CodeLens(lensRange, { title: "$(arrow-left) Back", command: "codeAtlas.back" }),
      new vscode.CodeLens(lensRange, { title: "Next $(arrow-right)", command: "codeAtlas.next" }),
      new vscode.CodeLens(lensRange, { title: "$(zoom-in) Deeper", command: "codeAtlas.deeper" }),
      new vscode.CodeLens(lensRange, { title: "$(stop-circle) Stop", command: "codeAtlas.stop" }),
      new vscode.CodeLens(lensRange, {
        title: "$(book) Show narration",
        command: "codeAtlas.showHoverNarration",
      }),
    ];
  }
}
