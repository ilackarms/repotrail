import * as vscode from "vscode";
import type { TourController } from "./tourController";

/**
 * Present mode: give the editor area the whole window and show captions on
 * slides. It hides the side bars and the panel; leaving brings the RepoTrail
 * sidebar back. The sidebar's webview is kept alive while hidden, so
 * narration keeps playing.
 */
export class PresentMode implements vscode.Disposable {
  private active = false;
  private readonly activeEmitter = new vscode.EventEmitter<boolean>();
  readonly onDidChangeActive = this.activeEmitter.event;

  constructor(
    private readonly controller: TourController,
    private readonly log: vscode.OutputChannel,
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  async toggle(): Promise<void> {
    if (this.active) await this.exit();
    else await this.enter();
  }

  async enter(): Promise<void> {
    if (this.active) return;
    if (!this.controller.snapshot().plan) {
      void vscode.window.showInformationMessage("RepoTrail: open a tour to present it.");
      return;
    }
    for (const command of ["workbench.action.closeSidebar", "workbench.action.closePanel", "workbench.action.closeAuxiliaryBar"]) {
      await vscode.commands.executeCommand(command).then(undefined, (err) => {
        this.log.appendLine(`[present] ${command} failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    this.setActive(true);
    await this.controller.revealCurrent();
  }

  async exit(): Promise<void> {
    if (!this.active) return;
    this.setActive(false);
    await vscode.commands.executeCommand("repoTrail.tour.focus").then(undefined, () => {});
  }

  dispose(): void {
    this.activeEmitter.dispose();
  }

  private setActive(active: boolean): void {
    this.active = active;
    void vscode.commands.executeCommand("setContext", "repoTrail.presenting", active);
    this.log.appendLine(`[present] ${active ? "on" : "off"}`);
    this.activeEmitter.fire(active);
  }
}
