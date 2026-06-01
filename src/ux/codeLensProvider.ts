import * as vscode from "vscode";
import { TourController } from "./tourController";

/**
 * Renders a control strip as CodeLenses on the line above the current step's
 * highlight (Back / Next / Deeper / Stop / Open narration / TTS), plus a small
 * clickable marker on every *other* stop that lives in the same file — so the
 * editor itself becomes a map of the tour. Drifted stops are flagged.
 *
 * Refreshes on controller.onDidChange. If the agent omitted `range`, anchors to
 * line 1.
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

    const lenses: vscode.CodeLens[] = [];
    const lineCount = Math.max(0, doc.lineCount - 1);
    const anchorLine = (step: { range?: { startLine: number } }) =>
      Math.min(Math.max(0, (step.range?.startLine ?? 1) - 1), lineCount);

    const onCurrentFile =
      doc.uri.toString() === vscode.Uri.joinPath(folder.uri, snap.current.file).toString();

    if (onCurrentFile) {
      const lensRange = new vscode.Range(anchorLine(snap.current), 0, anchorLine(snap.current), 0);
      const driftMark =
        snap.currentDrift === "relocated"
          ? "$(warning) "
          : snap.currentDrift === "missing"
            ? "$(error) "
            : "";
      const header = `${driftMark || "$(map) "}Step ${snap.index + 1}/${snap.plan.steps.length}: ${snap.current.title}`;

      lenses.push(
        new vscode.CodeLens(lensRange, { title: header, command: "" }),
        new vscode.CodeLens(lensRange, { title: "$(arrow-left) Back", command: "repoTrail.back" }),
        new vscode.CodeLens(lensRange, { title: "Next $(arrow-right)", command: "repoTrail.next" }),
        new vscode.CodeLens(lensRange, {
          title: "$(clippy) Deepen (copy prompt)",
          command: "repoTrail.deeper",
          tooltip: "Copy a 'deepen this step' prompt to your clipboard for paste into Claude Code.",
        }),
        new vscode.CodeLens(lensRange, { title: "$(stop-circle) Stop", command: "repoTrail.stop" }),
        new vscode.CodeLens(lensRange, { title: "$(book) Open narration", command: "repoTrail.openNarration" }),
        new vscode.CodeLens(lensRange, { title: ttsLensLabel(), command: "repoTrail.cycleTts" }),
      );
      if (snap.currentDrift !== "ok") {
        lenses.push(
          new vscode.CodeLens(lensRange, {
            title:
              snap.currentDrift === "relocated"
                ? "$(info) code moved since this stop was authored — highlight re-anchored"
                : "$(info) the anchored code is gone — highlight may be stale",
            command: "",
          }),
        );
      }
    }

    // Clickable jump markers for the OTHER stops that live in this file.
    snap.plan.steps.forEach((step, i) => {
      if (i === snap.index) return;
      if (vscode.Uri.joinPath(folder.uri, step.file).toString() !== doc.uri.toString()) return;
      const line = anchorLine(step);
      const drift = snap.drift[i];
      const icon = drift === "missing" ? "$(error)" : drift === "relocated" ? "$(warning)" : "$(circle-small-filled)";
      lenses.push(
        new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
          title: `${icon} Trail stop ${i + 1}: ${step.title}`,
          command: "repoTrail.showStep",
          arguments: [i],
          tooltip: "Jump to this RepoTrail stop.",
        }),
      );
    });

    return lenses;
  }
}

function ttsLensLabel(): string {
  const provider = vscode.workspace.getConfiguration("repoTrail").get<string>("tts.provider", "system");
  if (provider === "off") return "$(unmute) TTS";
  return `$(megaphone) TTS: ${provider}`;
}
