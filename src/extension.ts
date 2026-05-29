import * as vscode from "vscode";
import { gatherRepoContext } from "./analysis/repoContext";
import { ClaudeTourProvider } from "./engine/claudeProvider";
import { MockTourProvider } from "./engine/mockProvider";
import { TourProvider } from "./engine/tourProvider";
import { TourKind, TourRequest } from "./engine/types";
import { TourController } from "./ux/tourController";
import { TourViewProvider } from "./ux/webviewPanel";

const TOUR_KIND_PICKS: { label: string; value: TourKind; description: string }[] = [
  { label: "Architecture overview", value: "architecture", description: "Top-level systems and how they connect" },
  { label: "PR / diff walkthrough", value: "pr-diff", description: "Explain the changes in a unified diff" },
  { label: "File walkthrough", value: "file-walkthrough", description: "Tour a specific file end-to-end" },
  { label: "Request lifecycle trace", value: "request-lifecycle", description: "Follow a request through the stack" },
  { label: "Bug investigation path", value: "bug-investigation", description: "Trace likely causes of a reported bug" },
];

export function activate(context: vscode.ExtensionContext): void {
  const controller = new TourController(pickProvider());

  // Re-pick provider when configuration changes (e.g. user adds API key).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codeAtlas")) {
        controller.setProvider(pickProvider());
      }
    }),
  );

  const viewProvider = new TourViewProvider(context.extensionUri, controller);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TourViewProvider.viewType, viewProvider),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeAtlas.startTour", async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        vscode.window.showErrorMessage("Code Atlas: open a folder/workspace first.");
        return;
      }
      const picked = await vscode.window.showQuickPick(TOUR_KIND_PICKS, {
        placeHolder: "What kind of tour?",
        matchOnDescription: true,
      });
      if (!picked) return;

      const ctx = await gatherRepoContext();
      const req: TourRequest = {
        kind: picked.value,
        workspaceRoot: root,
        files: ctx?.files ?? [],
      };
      try {
        await controller.start(req);
        await vscode.commands.executeCommand("codeAtlas.tour.focus");
      } catch (err) {
        vscode.window.showErrorMessage(
          `Code Atlas: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
    vscode.commands.registerCommand("codeAtlas.next", () => controller.next()),
    vscode.commands.registerCommand("codeAtlas.back", () => controller.back()),
    vscode.commands.registerCommand("codeAtlas.deeper", () => controller.deeper()),
    vscode.commands.registerCommand("codeAtlas.stop", () => controller.stop()),
  );
}

export function deactivate(): void {}

function pickProvider(): TourProvider {
  const cfg = vscode.workspace.getConfiguration("codeAtlas");
  const apiKey = cfg.get<string>("anthropicApiKey") || process.env.ANTHROPIC_API_KEY || "";
  const model = cfg.get<string>("model") || "claude-opus-4-7";
  if (apiKey) {
    // ClaudeTourProvider is currently a stub that throws. The controller
    // surfaces the error; users can fall back by clearing the API key.
    return new ClaudeTourProvider(apiKey, model);
  }
  return new MockTourProvider();
}
