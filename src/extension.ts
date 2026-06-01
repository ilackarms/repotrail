import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  parseTourJson,
  planToJson,
  planToMarkdown,
  slugForFilename,
} from "./engine/tourSerialize";
import { RepoTrailMcpServer } from "./mcp/server";
import { listRepoTours, readRepoTour, REPO_TOURS_DIR, saveRepoTour } from "./storage/repoTours";
import { deleteTour, listTours, loadTour, saveTour } from "./storage/tourStore";
import { availableProviders, TtsManager, TtsProvider } from "./tts/manager";
import { TourCodeLensProvider } from "./ux/codeLensProvider";
import { setEditorLogger } from "./ux/editorActions";
import { TourController } from "./ux/tourController";
import { TourViewProvider } from "./ux/webviewPanel";

let mcp: RepoTrailMcpServer | null = null;
let statusItem: vscode.StatusBarItem | null = null;
let tourStatusItem: vscode.StatusBarItem | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel("RepoTrail");
  context.subscriptions.push(log);
  setEditorLogger(log);
  log.appendLine(`[ext] activate ${(context.extension.packageJSON as { version?: string }).version ?? "?"}`);

  const controller = new TourController();
  controller.setPersistFn((record) => {
    if (!record) return;
    saveTour(record).catch((err) =>
      log.appendLine(`[store] save failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration("repoTrail")) {
        if (e.affectsConfiguration("repoTrail.mcpEnabled") || e.affectsConfiguration("repoTrail.mcpPort")) {
          await restartMcp(context, controller);
          viewProvider.refresh();
        }
      }
    }),
  );

  const viewProvider = new TourViewProvider(context.extensionUri, controller, log);
  viewProvider.setTourListLoader(async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return [];
    return listTours(root);
  });
  viewProvider.setMcpStatusLoader(() => ({
    enabled: vscode.workspace.getConfiguration("repoTrail").get<boolean>("mcpEnabled", true),
    port: mcp?.port ?? null,
  }));
  viewProvider.setRepoTourLoader(async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return [];
    return listRepoTours(root);
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TourViewProvider.viewType, viewProvider),
  );

  // Status-bar tour indicator: "Trail k/N" while a tour is active, click to focus.
  tourStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  tourStatusItem.command = "repoTrail.tour.focus";
  context.subscriptions.push(tourStatusItem);
  const refreshTourStatus = () => {
    const snap = controller.snapshot();
    if (snap.plan && snap.plan.steps.length > 0) {
      tourStatusItem!.text = `$(map) Trail ${snap.index + 1}/${snap.plan.steps.length}`;
      tourStatusItem!.tooltip = snap.current?.title
        ? `RepoTrail — ${snap.current.title}\nClick to open the tour panel.`
        : "RepoTrail tour";
      tourStatusItem!.show();
    } else {
      tourStatusItem!.hide();
    }
  };
  context.subscriptions.push(controller.onDidChange(refreshTourStatus));
  refreshTourStatus();

  const tts = new TtsManager(controller, log);
  viewProvider.registerSinkListener((sink) => tts.setWebviewSink(sink));
  context.subscriptions.push(tts);

  const codeLensProvider = new TourCodeLensProvider(controller);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, codeLensProvider),
  );

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "repoTrail.showMcpInfo";
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("repoTrail.tour.focus", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.repoTrail");
    }),
    vscode.commands.registerCommand("repoTrail.startTour", async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        vscode.window.showErrorMessage("RepoTrail: open a folder/workspace first.");
        return;
      }
      const prompt =
        "Give me a RepoTrail tour of this repository — an architecture overview. " +
        "(Or ask for: a PR/diff walkthrough, a file walkthrough, a request-lifecycle trace, or a bug-investigation tour.)";
      await vscode.env.clipboard.writeText(prompt);
      await vscode.commands.executeCommand("repoTrail.tour.focus").then(undefined, () => {});
      const pick = await vscode.window.showInformationMessage(
        "Tour prompt copied. Paste it into any MCP-capable agent connected to RepoTrail.",
        "Show agent setup",
      );
      if (pick === "Show agent setup") showMcpInfo(context);
    }),
    vscode.commands.registerCommand("repoTrail.exportTour", () => exportActiveTour(controller, log)),
    vscode.commands.registerCommand("repoTrail.importTour", () => importTour(controller, log)),
    vscode.commands.registerCommand("repoTrail.saveTourToRepo", () => saveTourToRepo(controller, log)),
    vscode.commands.registerCommand("repoTrail.tourFromHere", () => tourFromHere()),
    vscode.commands.registerCommand("repoTrail.next", () => controller.next()),
    vscode.commands.registerCommand("repoTrail.back", () => controller.back()),
    vscode.commands.registerCommand("repoTrail.showStep", (index?: number) => {
      if (typeof index === "number") void controller.showStep(index);
    }),
    vscode.commands.registerCommand("repoTrail.togglePlay", () => viewProvider.togglePlay()),
    vscode.commands.registerCommand("repoTrail.revealCurrent", () => controller.revealCurrent()),
    vscode.commands.registerCommand("repoTrail.resumeRepoTour", async (file?: string) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root || !file) return;
      const plan = await readRepoTour(root, file);
      if (!plan) {
        vscode.window.showErrorMessage(`RepoTrail: ${REPO_TOURS_DIR}/${file} isn't a valid tour.`);
        return;
      }
      await controller.loadPlan(plan);
      await vscode.commands.executeCommand("repoTrail.tour.focus").then(undefined, () => {});
    }),
    vscode.commands.registerCommand("repoTrail.deeper", () => copyDeepenPrompt(controller, viewProvider, log)),
    vscode.commands.registerCommand(
      "repoTrail.followUp",
      (question?: string) => copyFollowUpPrompt(controller, viewProvider, question ?? "", log),
    ),
    vscode.commands.registerCommand("repoTrail.stop", () => controller.stop()),
    vscode.commands.registerCommand("repoTrail.installClaudeSkill", () => installClaudeSkill(context)),
    vscode.commands.registerCommand("repoTrail.showMcpInfo", () => showMcpInfo(context)),
    vscode.commands.registerCommand("repoTrail.openNarration", () => {
      vscode.commands.executeCommand("repoTrail.tour.focus").then(undefined, () => {});
    }),
    vscode.commands.registerCommand("repoTrail.cycleTts", async () => {
      const cfg = vscode.workspace.getConfiguration("repoTrail");
      const cur = cfg.get<string>("tts.provider", "system") as TtsProvider;
      const order = availableProviders();
      const idx = order.indexOf(cur);
      const next = order[(idx + 1) % order.length] ?? "off";
      await cfg.update("tts.provider", next, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`RepoTrail TTS: ${next}`, 1500);
      // Switching providers no longer auto-speaks — it only stops any current
      // narration. Use the Speak button to start playback on demand.
      tts.cancel();
    }),
    vscode.commands.registerCommand("repoTrail.speakCurrent", () => tts.speakCurrent()),
    vscode.commands.registerCommand("repoTrail.stopTts", () => tts.cancel()),
    vscode.commands.registerCommand("repoTrail.resumeTour", async (id?: string) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        vscode.window.showErrorMessage("RepoTrail: open a workspace first.");
        return;
      }
      let chosen = id;
      if (!chosen) {
        const all = await listTours(root);
        if (all.length === 0) {
          vscode.window.showInformationMessage("RepoTrail: no saved tours for this workspace.");
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
        vscode.window.showErrorMessage(`RepoTrail: tour ${chosen} not found.`);
        return;
      }
      await controller.resume(rec);
      await vscode.commands.executeCommand("repoTrail.tour.focus").then(undefined, () => {});
    }),
    vscode.commands.registerCommand("repoTrail.deleteTour", async (id?: string) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return;
      let chosen = id;
      if (!chosen) {
        const all = await listTours(root);
        if (all.length === 0) {
          vscode.window.showInformationMessage("RepoTrail: no saved tours.");
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
  viewProvider.refresh();
  void maybeAutoResume(controller, log);
}

/**
 * On startup, offer to bring back the most recent tour for this workspace so a
 * window reload doesn't feel like losing your place. Controlled by
 * repoTrail.autoResume: "prompt" (default) asks, "auto" restores silently,
 * "off" does nothing.
 */
async function maybeAutoResume(controller: TourController, log: vscode.OutputChannel): Promise<void> {
  if (controller.activeTourId) return; // an agent/import already loaded one
  const mode = vscode.workspace.getConfiguration("repoTrail").get<string>("autoResume", "prompt");
  if (mode === "off") return;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;
  let summaries;
  try {
    summaries = await listTours(root);
  } catch {
    return;
  }
  const latest = summaries[0]; // listTours is sorted newest-first
  if (!latest) return;
  if (controller.activeTourId) return; // re-check after the await

  const resume = async () => {
    const rec = await loadTour(root, latest.id);
    if (!rec) return;
    await controller.resume(rec);
    await vscode.commands.executeCommand("repoTrail.tour.focus").then(undefined, () => {});
  };

  if (mode === "auto") {
    await resume();
    log.appendLine(`[resume] auto-resumed "${latest.title}"`);
    return;
  }
  const pick = await vscode.window.showInformationMessage(
    `RepoTrail: resume "${latest.title}" (step ${latest.lastIndex + 1} of ${latest.stepCount})?`,
    "Resume",
    "Not now",
  );
  if (pick === "Resume" && !controller.activeTourId) await resume();
}

export async function deactivate(): Promise<void> {
  if (mcp) {
    await mcp.stop().catch(() => {});
    mcp = null;
  }
}

async function restartMcp(context: vscode.ExtensionContext, controller: TourController): Promise<void> {
  if (mcp) {
    await mcp.stop().catch(() => {});
    mcp = null;
  }
  const cfg = vscode.workspace.getConfiguration("repoTrail");
  if (!cfg.get<boolean>("mcpEnabled", true)) {
    updateStatus("disabled");
    return;
  }
  const basePort = cfg.get<number>("mcpPort", 7777);
  const portRange = cfg.get<number>("mcpPortRange", 16);
  const version = (context.extension.packageJSON as { version?: string }).version ?? "0.0.0";
  const server = new RepoTrailMcpServer(controller, version);
  try {
    const actual = await server.startWithFallback(basePort, portRange);
    mcp = server;
    updateStatus("listening", actual);
  } catch (err) {
    updateStatus("error");
    vscode.window.showErrorMessage(
      `RepoTrail MCP server failed to bind any port in ${basePort}..${basePort + portRange - 1}: ` +
        `${err instanceof Error ? err.message : String(err)}.`,
    );
  }
}

function updateStatus(state: "listening" | "disabled" | "error", port?: number): void {
  if (!statusItem) return;
  if (state === "listening" && port) {
    statusItem.text = `$(map) Trail :${port}`;
    statusItem.tooltip = "RepoTrail MCP is listening on 127.0.0.1. Click for the tokenized connection URL.";
  } else if (state === "disabled") {
    statusItem.text = "$(map) Trail off";
    statusItem.tooltip = "RepoTrail MCP server is disabled (repoTrail.mcpEnabled = false).";
  } else {
    statusItem.text = "$(warning) Trail error";
    statusItem.tooltip = "RepoTrail MCP server failed to start. Click for details.";
  }
  statusItem.show();
}

/**
 * "Go deeper" is a bridge to the user's agent session: we copy a
 * ready-to-paste prompt to the clipboard rather than running an LLM in the
 * extension. The user pastes into their agent terminal; the agent calls
 * `insert_step` to splice sub-steps after the current index.
 */
function copyDeepenPrompt(
  controller: TourController,
  viewProvider: TourViewProvider,
  log: vscode.OutputChannel,
): void {
  const snap = controller.snapshot();
  if (!snap.plan || !snap.current) {
    vscode.window.showInformationMessage("RepoTrail: no active tour.");
    return;
  }
  const idx = snap.index + 1;
  const prompt =
    `Deepen step ${idx} of the active RepoTrail tour: "${snap.current.title}" (${snap.current.file}).\n\n` +
    `Call mcp__repotrail__get_state to confirm the current index, then read the relevant code, ` +
    `then call mcp__repotrail__insert_step one or more times with \`at\` = current index + 1, +2, ... ` +
    `to splice in 2–4 sub-steps that zoom into this area at finer granularity. Keep ranges tight ` +
    `(see the granularity rule in the repotrail skill).`;
  void vscode.env.clipboard.writeText(prompt);
  // Show the exact prompt in the sidebar so the handoff is visible, not a blind
  // clipboard write the user has to trust.
  viewProvider.showBridgePrompt(`Deepen step ${idx}`, prompt);
  vscode.window.setStatusBarMessage(`RepoTrail: deepen prompt copied for step ${idx}.`, 2500);
  log.appendLine(`[deeper] copied prompt for step ${idx}`);
}

function copyFollowUpPrompt(
  controller: TourController,
  viewProvider: TourViewProvider,
  question: string,
  log: vscode.OutputChannel,
): void {
  const snap = controller.snapshot();
  if (!snap.plan || !snap.current) {
    vscode.window.showInformationMessage("RepoTrail: no active tour.");
    return;
  }
  const trimmed = question.trim();
  if (!trimmed) {
    vscode.window.showInformationMessage("Type a question first.");
    return;
  }
  const idx = snap.index + 1;
  const prompt =
    `Follow-up about step ${idx} of the active RepoTrail tour: "${snap.current.title}" (${snap.current.file}).\n\n` +
    `Question: ${trimmed}\n\n` +
    `Read the relevant code, answer in chat. If the answer is pin-worthy, also call ` +
    `mcp__repotrail__insert_step to add a clarifying stop after the current index.`;
  void vscode.env.clipboard.writeText(prompt);
  viewProvider.showBridgePrompt(`Follow-up on step ${idx}`, prompt);
  vscode.window.setStatusBarMessage("RepoTrail: follow-up prompt copied.", 2500);
  log.appendLine(`[followUp] copied prompt for step ${idx}`);
}

/**
 * Export the active tour to a file the user picks. Markdown is the readable
 * artifact (file:line refs + narration); JSON round-trips back through Import.
 */
async function exportActiveTour(controller: TourController, log: vscode.OutputChannel): Promise<void> {
  const snap = controller.snapshot();
  if (!snap.plan || snap.plan.steps.length === 0) {
    vscode.window.showInformationMessage("RepoTrail: no active tour to export.");
    return;
  }
  const fmt = await vscode.window.showQuickPick(
    [
      { label: "Markdown (.md)", description: "Readable walkthrough to share or commit", value: "md" },
      { label: "JSON (.json)", description: "Re-importable — replay this tour later or elsewhere", value: "json" },
      {
        label: `Save to repo (${REPO_TOURS_DIR}/)`,
        description: "Commit it so teammates see it in their Start tab",
        value: "repo",
      },
    ],
    { placeHolder: "Export format" },
  );
  if (!fmt) return;

  if (fmt.value === "repo") {
    await saveTourToRepo(controller, log);
    return;
  }

  const exportedAt = new Date().toISOString();
  const isJson = fmt.value === "json";
  const content = isJson
    ? planToJson(snap.plan, exportedAt)
    : planToMarkdown(snap.plan, exportedAt);
  const base = slugForFilename(snap.plan.title);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  const defaultUri = root
    ? vscode.Uri.joinPath(root, `${base}.${fmt.value}`)
    : vscode.Uri.file(`${base}.${fmt.value}`);

  const target = await vscode.window.showSaveDialog({
    defaultUri,
    filters: isJson ? { "RepoTrail tour": ["json"] } : { Markdown: ["md"] },
  });
  if (!target) return;
  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8"));
    const open = await vscode.window.showInformationMessage(
      `RepoTrail: tour exported to ${target.fsPath.split("/").pop()}.`,
      "Open",
    );
    if (open === "Open") {
      const doc = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(doc, { preview: false });
    }
  } catch (err) {
    log.appendLine(`[export] failed: ${err instanceof Error ? err.message : String(err)}`);
    vscode.window.showErrorMessage("RepoTrail: export failed (see Output ▸ RepoTrail).");
  }
}

/** Import a previously-exported JSON tour and load it as a fresh tour. */
async function importTour(controller: TourController, log: vscode.OutputChannel): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  const picks = await vscode.window.showOpenDialog({
    canSelectMany: false,
    defaultUri: root,
    filters: { "RepoTrail tour": ["json"] },
    openLabel: "Import tour",
  });
  if (!picks || picks.length === 0) return;
  try {
    const bytes = await vscode.workspace.fs.readFile(picks[0]);
    const plan = parseTourJson(Buffer.from(bytes).toString("utf8"));
    if (!plan) {
      vscode.window.showErrorMessage("RepoTrail: that file isn't a valid exported tour.");
      return;
    }
    await controller.loadPlan(plan);
    await vscode.commands.executeCommand("repoTrail.tour.focus").then(undefined, () => {});
    vscode.window.setStatusBarMessage(`RepoTrail: imported "${plan.title}" (${plan.steps.length} stops).`, 3000);
  } catch (err) {
    log.appendLine(`[import] failed: ${err instanceof Error ? err.message : String(err)}`);
    vscode.window.showErrorMessage("RepoTrail: import failed (see Output ▸ RepoTrail).");
  }
}

/**
 * Write the active tour into the repo's .repotrail/ folder as JSON. The user
 * then chooses whether/when to `git commit` it — we never touch git. Once
 * committed, teammates see it in their Start tab.
 */
async function saveTourToRepo(controller: TourController, log: vscode.OutputChannel): Promise<void> {
  const snap = controller.snapshot();
  if (!snap.plan || snap.plan.steps.length === 0) {
    vscode.window.showInformationMessage("RepoTrail: no active tour to save.");
    return;
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    vscode.window.showErrorMessage("RepoTrail: open a workspace first.");
    return;
  }
  const slug = slugForFilename(snap.plan.title);
  const content = planToJson(snap.plan, new Date().toISOString());
  try {
    const file = await saveRepoTour(root, slug, content);
    const rel = `${REPO_TOURS_DIR}/${file.split("/").pop()}`;
    const pick = await vscode.window.showInformationMessage(
      `RepoTrail: saved to ${rel}. Commit it to share this tour with the team.`,
      "Open",
    );
    if (pick === "Open") {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(doc, { preview: false });
    }
  } catch (err) {
    log.appendLine(`[repo-save] failed: ${err instanceof Error ? err.message : String(err)}`);
    vscode.window.showErrorMessage("RepoTrail: save to repo failed (see Output ▸ RepoTrail).");
  }
}

/**
 * Right-click entry point: copy an agent prompt scoped to the file/selection
 * the user is looking at, so they can ask for a tour starting right here.
 */
async function tourFromHere(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!editor || !root) {
    vscode.window.showInformationMessage("RepoTrail: open a file to tour from here.");
    return;
  }
  const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
  const sel = editor.selection;
  const hasSel = !sel.isEmpty;
  const scope = hasSel
    ? `the selected code in \`${rel}\` (lines ${sel.start.line + 1}–${sel.end.line + 1})`
    : `\`${rel}\``;
  const prompt =
    `Give me a RepoTrail tour starting from ${scope}. ` +
    `Walk through what it does and how it connects to the rest of the codebase, ` +
    `following the repotrail skill (push stops over MCP).`;
  await vscode.env.clipboard.writeText(prompt);
  await vscode.commands.executeCommand("repoTrail.tour.focus").then(undefined, () => {});
  vscode.window.setStatusBarMessage("RepoTrail: 'tour from here' prompt copied for your agent.", 3000);
}

function showMcpInfo(context: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration("repoTrail");
  const enabled = cfg.get<boolean>("mcpEnabled", true);
  if (!enabled) {
    vscode.window.showInformationMessage("RepoTrail MCP server is disabled. Enable in settings.");
    return;
  }
  const url = mcp?.connectionUrl;
  if (!url) {
    vscode.window.showInformationMessage("RepoTrail MCP server is not running yet.");
    return;
  }
  const parsedUrl = new URL(url);
  const token = parsedUrl.searchParams.get("token") ?? "";
  const bearerUrl = `${parsedUrl.origin}${parsedUrl.pathname}`;
  const genericConfig = JSON.stringify(
    {
      name: "repotrail",
      transport: "streamable-http",
      url,
      alternateAuth: {
        url: bearerUrl,
        headers: {
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
        },
      },
      notes: [
        "Use the tokenized url, or use alternateAuth if your MCP client supports headers.",
        "Streamable HTTP requests should advertise Accept: application/json, text/event-stream.",
        "Call get_workspace first and verify workspaceRoot before emitting a tour.",
        "Emit the full route up front with start_tour, add_step, and show_step({ index: 0 }).",
      ],
    },
    null,
    2,
  );
  const userScopeCmd = `claude mcp add --scope user --transport http repotrail ${shellQuote(url)}`;
  vscode.window
    .showInformationMessage(
      "RepoTrail MCP is ready. Install the Claude Code skill, or connect any MCP-capable agent with the tokenized URL.",
      "Install Claude skill",
      "Copy Claude MCP add",
      "Copy generic config",
      "Copy URL",
    )
    .then(async (pick) => {
      if (pick === "Install Claude skill") {
        await installClaudeSkill(context);
      } else if (pick === "Copy Claude MCP add") {
        vscode.env.clipboard.writeText(userScopeCmd);
        vscode.window.showInformationMessage(
          "Copied. Run once in any terminal, then start a new Claude Code session.",
        );
      } else if (pick === "Copy generic config") {
        vscode.env.clipboard.writeText(genericConfig);
        vscode.window.showInformationMessage("Copied generic MCP connection config.");
      } else if (pick === "Copy URL") {
        vscode.env.clipboard.writeText(url);
      }
    });
}

async function installClaudeSkill(context: vscode.ExtensionContext): Promise<void> {
  const sourceDir = vscode.Uri.joinPath(context.extensionUri, "harness", "claude", "repotrail").fsPath;
  const targetDir = path.join(os.homedir(), ".claude", "skills", "repotrail");
  try {
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    await fs.cp(sourceDir, targetDir, { recursive: true });
    vscode.window.showInformationMessage(
      "RepoTrail Claude Code skill installed. Add the MCP server if needed, then start a new Claude Code session.",
      "Show MCP setup",
    ).then((pick) => {
      if (pick === "Show MCP setup") showMcpInfo(context);
    });
  } catch (err) {
    vscode.window.showErrorMessage(
      `RepoTrail: failed to install Claude Code skill: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
