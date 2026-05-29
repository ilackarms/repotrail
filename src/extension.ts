import * as vscode from "vscode";
import { gatherRepoContext } from "./analysis/repoContext";
import { ClaudeTourProvider } from "./engine/claudeProvider";
import { MockTourProvider } from "./engine/mockProvider";
import { TourProvider } from "./engine/tourProvider";
import { TourKind, TourRequest } from "./engine/types";
import { CodeAtlasMcpServer } from "./mcp/server";
import { deleteTour, listTours, loadTour, saveTour } from "./storage/tourStore";
import { availableProviders, TtsManager, TtsProvider } from "./tts/manager";
import { TourCodeLensProvider } from "./ux/codeLensProvider";
import { setEditorLogger } from "./ux/editorActions";
import { TourHoverProvider } from "./ux/hoverProvider";
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
  const log = vscode.window.createOutputChannel("Code Atlas");
  context.subscriptions.push(log);
  setEditorLogger(log);
  log.appendLine(`[ext] activate ${(context.extension.packageJSON as { version?: string }).version ?? "?"}`);

  const controller = new TourController(pickProvider());
  controller.setPersistFn((record) => {
    if (!record) return;
    saveTour(record).catch((err) =>
      log.appendLine(`[store] save failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  });

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
  viewProvider.setTourListLoader(async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return [];
    return listTours(root);
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TourViewProvider.viewType, viewProvider),
  );

  const tts = new TtsManager(controller, log);
  viewProvider.registerSinkListener((sink) => tts.setWebviewSink(sink));
  context.subscriptions.push(tts);

  const codeLensProvider = new TourCodeLensProvider(controller);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, codeLensProvider),
  );

  const hoverProvider = new TourHoverProvider(controller);
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ scheme: "file" }, hoverProvider),
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
    vscode.commands.registerCommand("codeAtlas.deeper", () => copyDeepenPrompt(controller, log)),
    vscode.commands.registerCommand(
      "codeAtlas.followUp",
      (question?: string) => copyFollowUpPrompt(controller, question ?? "", log),
    ),
    vscode.commands.registerCommand("codeAtlas.stop", () => controller.stop()),
    vscode.commands.registerCommand("codeAtlas.showMcpInfo", () => showMcpInfo()),
    vscode.commands.registerCommand("codeAtlas.showHoverNarration", () => {
      vscode.commands.executeCommand("editor.action.showHover").then(undefined, () => {});
    }),
    vscode.commands.registerCommand("codeAtlas.cycleTts", async () => {
      const cfg = vscode.workspace.getConfiguration("codeAtlas");
      const cur = cfg.get<string>("tts.provider", "kokoro") as TtsProvider;
      const order = availableProviders();
      const idx = order.indexOf(cur);
      const next = order[(idx + 1) % order.length] ?? "off";
      await cfg.update("tts.provider", next, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`Code Atlas TTS: ${next}`, 1500);
      // Switching providers no longer auto-speaks — it only stops any current
      // narration. Use the Speak button to start playback on demand.
      tts.cancel();
    }),
    vscode.commands.registerCommand("codeAtlas.speakCurrent", () => tts.speakCurrent()),
    vscode.commands.registerCommand("codeAtlas.stopTts", () => tts.cancel()),
    vscode.commands.registerCommand("codeAtlas.resumeTour", async (id?: string) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        vscode.window.showErrorMessage("Code Atlas: open a workspace first.");
        return;
      }
      let chosen = id;
      if (!chosen) {
        const all = await listTours(root);
        if (all.length === 0) {
          vscode.window.showInformationMessage("Code Atlas: no saved tours for this workspace.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          all.map((t) => ({
            label: t.title || "(untitled)",
            description: `${t.kind} · ${t.stepCount} stops · step ${t.lastIndex + 1}`,
            detail: new Date(t.updatedAt).toLocaleString(),
            id: t.id,
          })),
          { placeHolder: "Resume which tour?" },
        );
        if (!pick) return;
        chosen = pick.id;
      }
      const rec = await loadTour(root, chosen);
      if (!rec) {
        vscode.window.showErrorMessage(`Code Atlas: tour ${chosen} not found.`);
        return;
      }
      await controller.resume(rec);
      await vscode.commands.executeCommand("codeAtlas.tour.focus").then(undefined, () => {});
    }),
    vscode.commands.registerCommand("codeAtlas.deleteTour", async (id?: string) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return;
      let chosen = id;
      if (!chosen) {
        const all = await listTours(root);
        if (all.length === 0) {
          vscode.window.showInformationMessage("Code Atlas: no saved tours.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          all.map((t) => ({
            label: t.title || "(untitled)",
            description: `${t.kind} · ${t.stepCount} stops`,
            id: t.id,
          })),
          { placeHolder: "Delete which tour?" },
        );
        if (!pick) return;
        chosen = pick.id;
      }
      const ok = await deleteTour(root, chosen);
      if (ok) {
        // If we just deleted the active one, clear in-memory plan too.
        if (controller.activeTourId === chosen) controller.stop();
        viewProvider.refresh();
      }
    }),
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
  const basePort = cfg.get<number>("mcpPort", 7777);
  const portRange = cfg.get<number>("mcpPortRange", 16);
  const version = (context.extension.packageJSON as { version?: string }).version ?? "0.0.0";
  const server = new CodeAtlasMcpServer(controller, version);
  try {
    const actual = await server.startWithFallback(basePort, portRange);
    mcp = server;
    updateStatus("listening", actual);
  } catch (err) {
    updateStatus("error");
    vscode.window.showErrorMessage(
      `Code Atlas MCP server failed to bind any port in ${basePort}..${basePort + portRange - 1}: ` +
        `${err instanceof Error ? err.message : String(err)}.`,
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

/**
 * "Go deeper" is a bridge to the user's Claude Code session: we copy a
 * ready-to-paste prompt to the clipboard rather than running an LLM in the
 * extension. The user pastes into their agent terminal; the agent calls
 * `insert_step` to splice sub-steps after the current index.
 */
function copyDeepenPrompt(controller: TourController, log: vscode.OutputChannel): void {
  const snap = controller.snapshot();
  if (!snap.plan || !snap.current) {
    vscode.window.showInformationMessage("Code Atlas: no active tour.");
    return;
  }
  const idx = snap.index + 1;
  const prompt =
    `Deepen step ${idx} of the active Code Atlas tour: "${snap.current.title}" (${snap.current.file}).\n\n` +
    `Call mcp__code-atlas__get_state to confirm the current index, then read the relevant code, ` +
    `then call mcp__code-atlas__insert_step one or more times with \`at\` = current index + 1, +2, ... ` +
    `to splice in 2–4 sub-steps that zoom into this area at finer granularity. Keep ranges tight ` +
    `(see the granularity rule in the code-atlas skill).`;
  void vscode.env.clipboard.writeText(prompt);
  vscode.window.showInformationMessage(
    `Deepen prompt copied for step ${idx}. Paste into your Claude Code session.`,
  );
  log.appendLine(`[deeper] copied prompt for step ${idx}`);
}

function copyFollowUpPrompt(
  controller: TourController,
  question: string,
  log: vscode.OutputChannel,
): void {
  const snap = controller.snapshot();
  if (!snap.plan || !snap.current) {
    vscode.window.showInformationMessage("Code Atlas: no active tour.");
    return;
  }
  const trimmed = question.trim();
  if (!trimmed) {
    vscode.window.showInformationMessage("Type a question first.");
    return;
  }
  const idx = snap.index + 1;
  const prompt =
    `Follow-up about step ${idx} of the active Code Atlas tour: "${snap.current.title}" (${snap.current.file}).\n\n` +
    `Question: ${trimmed}\n\n` +
    `Read the relevant code, answer in chat. If the answer is pin-worthy, also call ` +
    `mcp__code-atlas__insert_step to add a clarifying stop after the current index.`;
  void vscode.env.clipboard.writeText(prompt);
  vscode.window.showInformationMessage(
    `Follow-up prompt copied. Paste into your Claude Code session.`,
  );
  log.appendLine(`[followUp] copied prompt for step ${idx}`);
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
  // User-scope registration is one-time and survives across Claude Code sessions;
  // tools auto-load on every new session. Prefer this over per-project.
  const userScopeCmd = `claude mcp add --scope user --transport http code-atlas ${url}`;
  const projectScopeCmd = `claude mcp add --transport http code-atlas ${url}`;
  vscode.window
    .showInformationMessage(
      `Code Atlas MCP: ${url}`,
      "Copy global `claude mcp add` (recommended)",
      "Copy project-scope command",
      "Copy URL",
    )
    .then((pick) => {
      if (pick?.startsWith("Copy global")) {
        vscode.env.clipboard.writeText(userScopeCmd);
        vscode.window.showInformationMessage(
          "Copied. Run once in any terminal — new Claude Code sessions auto-load Code Atlas tools.",
        );
      } else if (pick === "Copy project-scope command") {
        vscode.env.clipboard.writeText(projectScopeCmd);
      } else if (pick === "Copy URL") {
        vscode.env.clipboard.writeText(url);
      }
    });
}
