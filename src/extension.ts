import * as vscode from "vscode";
import { gatherRepoContext } from "./analysis/repoContext";
import { ClaudeTourProvider } from "./engine/claudeProvider";
import { MockTourProvider } from "./engine/mockProvider";
import { TourProvider } from "./engine/tourProvider";
import { TourKind, TourRequest } from "./engine/types";
import { CodeAtlasMcpServer } from "./mcp/server";
import { TourController } from "./ux/tourController";
import { TourViewProvider } from "./ux/webviewPanel";

const TOUR_KIND_PICKS: { label: string; value: TourKind; description: string }[] = [
  { label: "Architecture overview", value: "architecture", description: "Top-level systems and how they connect" },
  { label: "PR / diff walkthrough", value: "pr-diff", description: "Explain the changes in a unified diff" },
  { label: "File walkthrough", value: "file-walkthrough", description: "Tour a specific file end-to-end" },
  { label: "Request lifecycle trace", value: "request-lifecycle", description: "Follow a request through the stack" },
  { label: "Bug investigation path", value: "bug-investigation", description: "Trace likely causes of a reported bug" },
];

let mcp: CodeAtlasMcpServer | null = null;
let statusItem: vscode.StatusBarItem | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const controller = new TourController(pickProvider());

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration("codeAtlas")) {
        controller.setProvider(pickProvider());
        if (e.affectsConfiguration("codeAtlas.mcpEnabled") || e.affectsConfiguration("codeAtlas.mcpPort")) {
          await restartMcp(context, controller);
        }
      }
    }),
  );

  const viewProvider = new TourViewProvider(context.extensionUri, controller);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TourViewProvider.viewType, viewProvider),
  );

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "codeAtlas.showMcpInfo";
  context.subscriptions.push(statusItem);

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
    vscode.commands.registerCommand("codeAtlas.showMcpInfo", () => showMcpInfo()),
  );

  await restartMcp(context, controller);
}

export async function deactivate(): Promise<void> {
  if (mcp) {
    await mcp.stop().catch(() => {});
    mcp = null;
  }
}

function pickProvider(): TourProvider {
  const cfg = vscode.workspace.getConfiguration("codeAtlas");
  const apiKey = cfg.get<string>("anthropicApiKey") || process.env.ANTHROPIC_API_KEY || "";
  const model = cfg.get<string>("model") || "claude-opus-4-7";
  if (apiKey) {
    return new ClaudeTourProvider(apiKey, model);
  }
  return new MockTourProvider();
}

async function restartMcp(context: vscode.ExtensionContext, controller: TourController): Promise<void> {
  if (mcp) {
    await mcp.stop().catch(() => {});
    mcp = null;
  }
  const cfg = vscode.workspace.getConfiguration("codeAtlas");
  if (!cfg.get<boolean>("mcpEnabled", true)) {
    updateStatus("disabled");
    return;
  }
  const port = cfg.get<number>("mcpPort", 7777);
  const version = (context.extension.packageJSON as { version?: string }).version ?? "0.0.0";
  const server = new CodeAtlasMcpServer(controller, version);
  try {
    const actual = await server.start(port);
    mcp = server;
    updateStatus("listening", actual);
  } catch (err) {
    updateStatus("error");
    vscode.window.showErrorMessage(
      `Code Atlas MCP server failed to start on port ${port}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Change "codeAtlas.mcpPort" in settings.`,
    );
  }
}

function updateStatus(state: "listening" | "disabled" | "error", port?: number): void {
  if (!statusItem) return;
  if (state === "listening" && port) {
    statusItem.text = `$(map) Atlas :${port}`;
    statusItem.tooltip = `Code Atlas MCP listening on http://127.0.0.1:${port}/mcp\nClick for connection details.`;
  } else if (state === "disabled") {
    statusItem.text = "$(map) Atlas off";
    statusItem.tooltip = "Code Atlas MCP server is disabled (codeAtlas.mcpEnabled = false).";
  } else {
    statusItem.text = "$(warning) Atlas error";
    statusItem.tooltip = "Code Atlas MCP server failed to start. Click for details.";
  }
  statusItem.show();
}

function showMcpInfo(): void {
  const cfg = vscode.workspace.getConfiguration("codeAtlas");
  const enabled = cfg.get<boolean>("mcpEnabled", true);
  if (!enabled) {
    vscode.window.showInformationMessage("Code Atlas MCP server is disabled. Enable in settings.");
    return;
  }
  const port = mcp?.port ?? cfg.get<number>("mcpPort", 7777);
  const url = `http://127.0.0.1:${port}/mcp`;
  const cmd = `claude mcp add --transport http code-atlas ${url}`;
  vscode.window
    .showInformationMessage(
      `Code Atlas MCP: ${url}`,
      "Copy `claude mcp add` command",
      "Copy URL",
    )
    .then((pick) => {
      if (pick === "Copy `claude mcp add` command") {
        vscode.env.clipboard.writeText(cmd);
      } else if (pick === "Copy URL") {
        vscode.env.clipboard.writeText(url);
      }
    });
}
