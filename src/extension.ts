import * as path from "node:path";
import * as vscode from "vscode";
import {
  formatStepPath,
  TourPlan,
  TourStep,
} from "./engine/types";
import {
  AnimatedTourCodeFrame,
  AnimatedTourFrame,
  AnimatedTourTtsDefaults,
  buildAnimatedDiffFrame,
  planToAnimatedHtml,
} from "./engine/animatedHtml";
import {
  parseTourJson,
  planToJson,
  planToMarkdown,
  slugForFilename,
} from "./engine/tourSerialize";
import { materializeStepDiff } from "./diffMaterialize";
import { listRepoTours, readRepoTour, REPO_TOURS_DIR, saveRepoTour, saveRepoTourUnique } from "./storage/repoTours";
import { renameRepoTourTitle, renameSavedTourTitle, validateTourTitle } from "./storage/tourRename";
import { deleteTour, listAllTourRecords, listTours, loadTour, saveTour, TourRecord } from "./storage/tourStore";
import { availableProviders, TtsManager, TtsProvider } from "./tts/manager";
import { TourCodeLensProvider } from "./ux/codeLensProvider";
import { setEditorLogger } from "./ux/editorActions";
import { formatSelectionReference, selectedFullLineRange } from "./ux/selectionReference";
import { TourController } from "./ux/tourController";
import { reconcileTourUpdate } from "./ux/tourProgress";
import { TourViewProvider } from "./ux/webviewPanel";
import {
  currentWorkspaceFolders,
  currentWorkspaceStorageRoot,
  firstWorkspaceRoot,
  hasWorkspaceFolders,
  relativePathInWorkspace,
  resolveStepWorkspaceFolder,
  resolveStepUri,
  resolveTourPlanRoots,
  workspaceFolderIdentity,
  workspaceFolderInfos,
} from "./workspace";

let tourStatusItem: vscode.StatusBarItem | null = null;

const ANIMATED_EXPORT_CONTEXT_LINES = 2;
const ANIMATED_EXPORT_MAX_CODE_LINES = 80;
const WORKSPACE_REGISTRY_DIR_DISPLAY = "~/.repotrail/workspaces";

type RenameTourArg = string | { id?: string; rootPath?: string; file?: string };

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

  const viewProvider = new TourViewProvider(context.extensionUri, controller, log);
  viewProvider.setTourListLoader(async () => {
    if (!hasWorkspaceFolders()) return [];
    return listTours(currentWorkspaceStorageRoot());
  });
  viewProvider.setRepoTourLoader(async () => {
    return listRepoTours(repoTourRoots());
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TourViewProvider.viewType, viewProvider),
  );
  const repoTourWatcher = vscode.workspace.createFileSystemWatcher(`**/${REPO_TOURS_DIR}/*.json`);
  let reloadTimer: NodeJS.Timeout | null = null;
  let reloadGeneration = 0;
  const refreshRepoTours = () => viewProvider.refresh();
  const scheduleRepoTourReload = (uri: vscode.Uri) => {
    viewProvider.refresh();
    const source = controller.activeRepoTourSource;
    if (!source || !sameRepoTourUri(source, uri)) return;
    const generation = ++reloadGeneration;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      void reloadActiveRepoTour(controller, uri, log, generation, () => reloadGeneration);
    }, 150);
  };
  context.subscriptions.push(
    repoTourWatcher,
    repoTourWatcher.onDidCreate(scheduleRepoTourReload),
    repoTourWatcher.onDidChange(scheduleRepoTourReload),
    repoTourWatcher.onDidDelete(scheduleRepoTourReload),
    vscode.workspace.onDidChangeWorkspaceFolders(refreshRepoTours),
    { dispose: () => reloadTimer && clearTimeout(reloadTimer) },
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

  context.subscriptions.push(
    vscode.commands.registerCommand("repoTrail.tour.focus", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.repoTrail");
    }),
    vscode.commands.registerCommand("repoTrail.copyTourPrompt", () => copyTourPrompt()),
    vscode.commands.registerCommand("repoTrail.exportTour", () => exportActiveTour(controller, log)),
    vscode.commands.registerCommand("repoTrail.importTour", () => importTour(controller, log)),
    vscode.commands.registerCommand("repoTrail.saveTourToRepo", () => saveTourToRepo(controller, log)),
    vscode.commands.registerCommand("repoTrail.migrateSavedTours", () => migrateSavedToursToRepo(viewProvider, log)),
    vscode.commands.registerCommand("repoTrail.tourFromHere", () => tourFromHere()),
    vscode.commands.registerCommand("repoTrail.copySelectionReference", () => copySelectionReference()),
    vscode.commands.registerCommand("repoTrail.next", () => controller.next()),
    vscode.commands.registerCommand("repoTrail.back", () => controller.back()),
    vscode.commands.registerCommand("repoTrail.showStep", (index?: number) => {
      if (typeof index === "number") void controller.showStep(index);
    }),
    vscode.commands.registerCommand("repoTrail.revealCurrent", () => controller.revealCurrent()),
    vscode.commands.registerCommand("repoTrail.openCurrentSource", () => controller.openCurrentSource()),
    vscode.commands.registerCommand("repoTrail.resumeRepoTour", async (arg?: string | { rootPath?: string; file?: string }) => {
      const file = typeof arg === "string" ? arg : arg?.file;
      const requestedRoot = typeof arg === "string" ? undefined : arg?.rootPath;
      const root = resolveOpenRepoTourRoot(requestedRoot);
      if (!root || !file) return;
      const plan = await readRepoTour(root, file);
      if (!plan) {
        vscode.window.showErrorMessage(`RepoTrail: ${REPO_TOURS_DIR}/${file} isn't a valid tour.`);
        return;
      }
      await controller.loadPlan(plan, root, { rootPath: root, file });
      await vscode.commands.executeCommand("repoTrail.tour.focus").then(undefined, () => {});
    }),
    vscode.commands.registerCommand("repoTrail.renameTour", (arg?: RenameTourArg) => renameTour(arg, controller, viewProvider, log)),
    vscode.commands.registerCommand("repoTrail.deeper", () => copyDeepenPrompt(controller, viewProvider, log)),
    vscode.commands.registerCommand(
      "repoTrail.followUp",
      (question?: string) => copyFollowUpPrompt(controller, viewProvider, question ?? "", log),
    ),
    vscode.commands.registerCommand("repoTrail.stop", () => controller.stop()),
    // Compatibility alias for existing keybindings and command invocations.
    vscode.commands.registerCommand("repoTrail.copyAgentSetup", () => copyTourPrompt()),
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
      if (!hasWorkspaceFolders()) {
        vscode.window.showErrorMessage("RepoTrail: open a workspace first.");
        return;
      }
      const root = currentWorkspaceStorageRoot();
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
      await controller.resume(await refreshTourRecordFromSource(rec, log));
      await vscode.commands.executeCommand("repoTrail.tour.focus").then(undefined, () => {});
    }),
    vscode.commands.registerCommand("repoTrail.deleteTour", async (id?: string) => {
      if (!hasWorkspaceFolders()) return;
      const root = currentWorkspaceStorageRoot();
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

  viewProvider.refresh();
  void maybeAutoResume(controller, log);
}

function repoTourRoots() {
  return workspaceFolderInfos().map((info) => ({
    rootPath: info.path,
    workspaceFolder: info.workspaceFolder,
    workspaceName: info.name,
  }));
}

function resolveOpenRepoTourRoot(rootPath?: string): string | undefined {
  if (!rootPath) return firstWorkspaceRoot();
  return currentWorkspaceFolders().find((folder) => folder.uri.fsPath === rootPath)?.uri.fsPath;
}

async function renameTour(
  arg: RenameTourArg | undefined,
  controller: TourController,
  viewProvider: TourViewProvider,
  log: vscode.OutputChannel,
): Promise<void> {
  try {
    const localId = typeof arg === "string" ? arg : arg?.id;
    const repoFile = typeof arg === "object" ? arg.file : undefined;
    const repoRoot = typeof arg === "object" ? arg.rootPath : undefined;

    if (repoFile) {
      const root = resolveOpenRepoTourRoot(repoRoot);
      if (!root) {
        vscode.window.showErrorMessage("RepoTrail: open the workspace that owns this repo tour first.");
        return;
      }
      const plan = await readRepoTour(root, repoFile);
      if (!plan) {
        vscode.window.showErrorMessage(`RepoTrail: ${REPO_TOURS_DIR}/${repoFile} isn't a valid tour.`);
        return;
      }
      const nextTitle = await promptTourTitle(plan.title);
      if (!nextTitle) return;
      const renamed = await renameRepoTourTitle(root, repoFile, nextTitle);
      if (sameRepoTourSource(controller.activeRepoTourSource, { rootPath: root, file: repoFile })) {
        controller.renameActiveTitle(renamed.title);
      }
      viewProvider.refresh();
      vscode.window.setStatusBarMessage(`RepoTrail: renamed tour to "${renamed.title}".`, 2500);
      return;
    }

    if (localId) {
      if (!hasWorkspaceFolders()) {
        vscode.window.showErrorMessage("RepoTrail: open a workspace first.");
        return;
      }
      const root = currentWorkspaceStorageRoot();
      const record = await loadTour(root, localId);
      if (!record) {
        vscode.window.showErrorMessage(`RepoTrail: tour ${localId} not found.`);
        return;
      }
      const nextTitle = await promptTourTitle(record.plan.title);
      if (!nextTitle) return;
      const renamed = await renameSavedTourTitle(root, localId, nextTitle);
      if (!renamed) {
        vscode.window.showErrorMessage(`RepoTrail: tour ${localId} not found.`);
        return;
      }
      if (controller.activeTourId === localId) controller.renameActiveTitle(renamed.plan.title);
      viewProvider.refresh();
      vscode.window.setStatusBarMessage(`RepoTrail: renamed tour to "${renamed.plan.title}".`, 2500);
      return;
    }

    const snap = controller.snapshot();
    if (!snap.plan) {
      vscode.window.showInformationMessage("RepoTrail: no active tour to rename.");
      return;
    }
    const nextTitle = await promptTourTitle(snap.plan.title);
    if (!nextTitle) return;
    const source = controller.activeRepoTourSource;
    if (source) {
      const renamed = await renameRepoTourTitle(source.rootPath, source.file, nextTitle);
      controller.renameActiveTitle(renamed.title);
      viewProvider.refresh();
      vscode.window.setStatusBarMessage(`RepoTrail: renamed tour to "${renamed.title}".`, 2500);
      return;
    }
    const title = validateTourTitle(nextTitle);
    controller.renameActiveTitle(title);
    viewProvider.refresh();
    vscode.window.setStatusBarMessage(`RepoTrail: renamed tour to "${title}".`, 2500);
  } catch (err) {
    log.appendLine(`[rename] failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    vscode.window.showErrorMessage(err instanceof Error ? err.message : "RepoTrail: rename failed.");
  }
}

function sameRepoTourSource(
  a: { rootPath: string; file: string } | null,
  b: { rootPath: string; file: string },
): boolean {
  return Boolean(a && a.rootPath === b.rootPath && a.file === b.file);
}

function sameRepoTourUri(source: { rootPath: string; file: string }, uri: vscode.Uri): boolean {
  const expected = path.resolve(source.rootPath, REPO_TOURS_DIR, path.basename(source.file));
  return path.resolve(uri.fsPath) === expected;
}

async function reloadActiveRepoTour(
  controller: TourController,
  uri: vscode.Uri,
  log: vscode.OutputChannel,
  generation: number,
  currentGeneration: () => number,
): Promise<void> {
  const source = controller.activeRepoTourSource;
  if (!source || !sameRepoTourUri(source, uri)) return;
  const plan = await readRepoTour(source.rootPath, source.file);
  if (generation !== currentGeneration()) return;
  if (!plan) {
    try {
      await vscode.workspace.fs.stat(uri);
      if (generation !== currentGeneration()) return;
      log.appendLine(`[repo-tour] ignored invalid update for ${uri.fsPath}`);
    } catch {
      if (generation !== currentGeneration()) return;
      if (!sameRepoTourSource(controller.activeRepoTourSource, source)) return;
      controller.stop({ forgetRepoSource: true });
      vscode.window.showInformationMessage("RepoTrail: the active tour file was deleted.");
      log.appendLine(`[repo-tour] active source deleted: ${uri.fsPath}`);
    }
    return;
  }
  if (generation !== currentGeneration()) return;
  if (!sameRepoTourSource(controller.activeRepoTourSource, source)) return;
  await controller.reloadPlan(plan);
  log.appendLine(`[repo-tour] reloaded ${uri.fsPath}`);
}

async function refreshTourRecordFromSource(
  record: TourRecord,
  log: vscode.OutputChannel,
): Promise<TourRecord> {
  const source = record.repoTourSource;
  if (!source) return record;
  const plan = await readRepoTour(source.rootPath, source.file);
  if (!plan) {
    log.appendLine(
      `[repo-tour] using cached plan because ${path.join(source.rootPath, REPO_TOURS_DIR, source.file)} is unavailable`,
    );
    return record;
  }
  const nextPlan = resolveTourPlanRoots(plan);
  const progress = reconcileTourUpdate(
    record.plan.steps,
    record.lastIndex,
    record.seen ?? [],
    nextPlan.steps,
  );
  return {
    ...record,
    lastIndex: progress.index,
    plan: { ...nextPlan, steps: progress.steps },
    seen: progress.seen,
  };
}

async function promptTourTitle(currentTitle: string): Promise<string | null> {
  const value = await vscode.window.showInputBox({
    title: "Rename RepoTrail tour",
    value: currentTitle,
    prompt: `Visible title only; ${REPO_TOURS_DIR} filename stays the same.`,
    validateInput: (input) => {
      try {
        validateTourTitle(input);
        return null;
      } catch {
        return "Enter a non-empty title.";
      }
    },
  });
  if (value === undefined) return null;
  return validateTourTitle(value);
}

function preferredRepoRootForPlan(plan: TourPlan): string | undefined {
  const counts = new Map<string, number>();
  for (const step of plan.steps) {
    const folder = resolveStepWorkspaceFolder(step, plan);
    if (!folder) continue;
    counts.set(folder.uri.fsPath, (counts.get(folder.uri.fsPath) ?? 0) + 1);
  }
  let best: { root: string; count: number } | null = null;
  for (const [root, count] of counts) {
    if (!best || count > best.count) best = { root, count };
  }
  return best?.root;
}

function buildTourAuthoringPrompt(): string {
  const infos = workspaceFolderInfos();
  const aliases = buildRootAliases(infos.map((info) => info.name));
  const rootLines = infos
    .map((info, index) => {
      const alias = aliases[index] ?? `root${index + 1}`;
      return `- ${alias}: name=${info.name}; workspaceFolder=${info.workspaceFolder}; path=${info.path}; shared tours go in ${info.path}/${REPO_TOURS_DIR}/`;
    })
    .join("\n");
  const rootJson = Object.fromEntries(
    infos.map((info, index) => {
      const alias = aliases[index] ?? `root${index + 1}`;
      return [alias, { name: info.name, pathHint: info.name }];
    }),
  );
  const firstAlias = aliases[0] ?? "project";
  const example = JSON.stringify(
    {
      repoTrailTour: 2,
      exportedAt: "ISO_TIMESTAMP",
      plan: {
        kind: "architecture",
        title: "Short useful tour title",
        summary: "One paragraph describing what this tour teaches.",
        roots: Object.keys(rootJson).length > 0 ? rootJson : { [firstAlias]: { name: firstAlias, pathHint: firstAlias } },
        steps: [
          {
            root: firstAlias,
            file: "src/example.ts",
            range: { startLine: 1, startColumn: 1, endLine: 20, endColumn: 1 },
            title: "Explain one logical chunk",
            explanation: "Markdown narration. Keep it focused; do not paste code here.",
            viewMode: "code",
          },
        ],
      },
    },
    null,
    2,
  );

  return [
    "Use the repo-trail skill. Create a RepoTrail tour for this VS Code workspace.",
    "",
    "Mode: existing VS Code workspace. The target roots are already open below.",
    "",
    "Write one complete JSON tour file into the owning project's .repotrail/ directory.",
    "",
    `If the user instead asks you to create a new RepoTrail workspace, save the .code-workspace under ${WORKSPACE_REGISTRY_DIR_DISPLAY}/, open it in VS Code if possible, and still write tours into repo-local .repotrail/ directories.`,
    "",
    "Open workspace roots:",
    rootLines || "- No workspace roots detected. Ask the user to open the target project in VS Code.",
    "",
    "Choose the output path:",
    `- If the tour primarily explains one project, write ${REPO_TOURS_DIR}/<descriptive-slug>.json inside that project.`,
    `- For a cross-project tour, write the JSON into the project that owns the story and reference the other open roots through plan.roots plus per-step root aliases.`,
    "- After writing the file, tell the user the path and stop. RepoTrail will refresh its library from the filesystem.",
    "",
    "Presentation mode decision:",
    "- If the user mentions a PR, PRs, commit, commits, branch comparison, diff, changes, review, or another explicit change window, create a change-review tour: use kind \"pr-diff\" and make every changed-code stop diff-backed.",
    "- Changed-code stops in change-review tours use viewMode \"diff\" with diff.baseRef and optional diff.headRef. Omit headRef to compare the base ref against the current workspace file.",
    "- Use diff.scope \"file\" for normal PR/commit review stops so RepoTrail reads real full-file contents from git and VS Code can show unchanged surrounding code.",
    "- Do not paste generated code into diff.beforeText/diff.afterText for git-backed reviews. Use pasted text only when there is no local git ref to compare.",
    "- Use highlight-only viewMode \"code\" only for codebase, file, subsystem, request-path, or architecture tours unrelated to a window of changes, plus optional orientation/context stops that do not review changed code.",
    "",
    "JSON format:",
    "```json",
    example,
    "```",
    "",
    "Rules:",
    "- Read the repo before choosing stops.",
    "- Use workspace-relative forward-slash file paths only.",
    "- Keep ranges tight and 1-indexed.",
    "- Do not use absolute file paths in steps, empty file paths, or paths containing \"..\".",
  ].join("\n");
}

function buildRootAliases(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name, index) => {
    const base = slugForFilename(name).replace(/-/g, "_") || `root${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
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
  if (!hasWorkspaceFolders()) return;
  const root = currentWorkspaceStorageRoot();
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
    await controller.resume(await refreshTourRecordFromSource(rec, log));
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

/**
 * "Go deeper" is a bridge to the user's agent session: we copy a
 * ready-to-paste prompt to the clipboard rather than running an LLM in the
 * extension. The user pastes it into their agent, which rewrites the JSON tour.
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
  const target = formatStepPath(snap.current);
  const revision = activeTourRevisionInstruction(controller);
  const prompt =
    `Deepen step ${idx} of the active RepoTrail tour: "${snap.current.title}" (${target}).\n\n` +
    `Read the relevant code. ${revision} Add 2-4 focused sub-steps after this stop, keep ranges tight, ` +
    `and preserve the RepoTrail schema.`;
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
  const target = formatStepPath(snap.current);
  const revision = activeTourRevisionInstruction(controller);
  const prompt =
    `Follow-up about step ${idx} of the active RepoTrail tour: "${snap.current.title}" (${target}).\n\n` +
    `Question: ${trimmed}\n\n` +
    `Read the relevant code and answer in chat. If the answer belongs in the tour, ${revision.charAt(0).toLowerCase()}${revision.slice(1)} ` +
    `Add a clarifying stop after the current index.`;
  void vscode.env.clipboard.writeText(prompt);
  viewProvider.showBridgePrompt(`Follow-up on step ${idx}`, prompt);
  vscode.window.setStatusBarMessage("RepoTrail: follow-up prompt copied.", 2500);
  log.appendLine(`[followUp] copied prompt for step ${idx}`);
}

function activeTourRevisionInstruction(controller: TourController): string {
  const source = controller.activeRepoTourSource;
  if (source) {
    const file = path.join(source.rootPath, REPO_TOURS_DIR, path.basename(source.file));
    return `Update the active tour at \`${file}\`; RepoTrail reloads that file automatically.`;
  }
  return `Write the revised tour into the owning project's \`${REPO_TOURS_DIR}/\` directory and tell the user to open it.`;
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
        label: "Animated HTML (.html)",
        description: "Standalone browser player with embedded code/diff snapshots",
        value: "html",
      },
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
  const isHtml = fmt.value === "html";
  const content = isHtml
    ? planToAnimatedHtml({
        plan: snap.plan,
        exportedAt,
        frames: await buildAnimatedTourFrames(snap.plan, log),
        tts: buildAnimatedTtsDefaults(),
      })
    : isJson
      ? planToJson(snap.plan, exportedAt)
      : planToMarkdown(snap.plan, exportedAt);
  const base = slugForFilename(snap.plan.title);
  const rootPath = firstWorkspaceRoot();
  const root = rootPath ? vscode.Uri.file(rootPath) : undefined;
  const defaultUri = root
    ? vscode.Uri.joinPath(root, `${base}.${fmt.value}`)
    : vscode.Uri.file(`${base}.${fmt.value}`);

  const target = await vscode.window.showSaveDialog({
    defaultUri,
    filters: isHtml ? { HTML: ["html"] } : isJson ? { "RepoTrail tour": ["json"] } : { Markdown: ["md"] },
  });
  if (!target) return;
  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8"));
    const open = await vscode.window.showInformationMessage(
      `RepoTrail: tour exported to ${target.fsPath.split("/").pop()}.`,
      "Open",
    );
    if (open === "Open") {
      if (isHtml) {
        await vscode.env.openExternal(target);
      } else {
        const doc = await vscode.workspace.openTextDocument(target);
        await vscode.window.showTextDocument(doc, { preview: false });
      }
    }
  } catch (err) {
    log.appendLine(`[export] failed: ${err instanceof Error ? err.message : String(err)}`);
    vscode.window.showErrorMessage("RepoTrail: export failed (see Output ▸ RepoTrail).");
  }
}

async function buildAnimatedTourFrames(
  plan: TourPlan,
  log: vscode.OutputChannel,
): Promise<AnimatedTourFrame[]> {
  const frames: AnimatedTourFrame[] = [];
  for (let i = 0; i < plan.steps.length; i++) {
    frames.push(await buildAnimatedTourFrame(plan, plan.steps[i], i, log));
  }
  return frames;
}

async function buildAnimatedTourFrame(
  plan: TourPlan,
  step: TourStep,
  index: number,
  log: vscode.OutputChannel,
): Promise<AnimatedTourFrame> {
  const warnings: string[] = [];
  const code = await snapshotStepCode(step, plan, warnings, log);
  const shouldRenderDiff = Boolean(step.diff && step.viewMode !== "code");
  const diff = shouldRenderDiff
    ? await buildAnimatedStepDiff(plan, step, warnings, log)
    : undefined;
  if (diff?.truncated) {
    warnings.push("Diff snapshot was trimmed for a compact shareable export.");
  }

  return {
    index,
    title: step.title,
    location: stepLocationLabel(step),
    explanation: step.explanation,
    viewLabel: diff ? "Diff" : "Code",
    code,
    diff,
    warnings,
  };
}

async function buildAnimatedStepDiff(
  plan: TourPlan,
  step: TourStep,
  warnings: string[],
  log: vscode.OutputChannel,
): Promise<AnimatedTourFrame["diff"]> {
  let uri: vscode.Uri | null;
  try {
    uri = resolveStepUri(step, plan);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    warnings.push(`Could not resolve diff target: ${detail}`);
    return undefined;
  }
  if (!uri) {
    warnings.push("The workspace file for this diff stop is not open in this VS Code window.");
    return undefined;
  }

  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.appendLine(`[export:animated] diff open failed for ${formatStepPath(step)}: ${detail}`);
    warnings.push("Could not read the workspace file for this diff stop.");
    return undefined;
  }

  const materialized = await materializeStepDiff(step, doc, resolveExportRange(step, doc), plan, log);
  if (!materialized) {
    warnings.push("Could not materialize the diff for this stop.");
    return undefined;
  }
  return buildAnimatedDiffFrame({
    beforeText: materialized.beforeText,
    afterText: materialized.afterText,
    beforeLabel: materialized.beforeLabel,
    afterLabel: materialized.afterLabel,
    languageId: materialized.languageId,
  });
}

async function snapshotStepCode(
  step: TourStep,
  plan: TourPlan,
  warnings: string[],
  log: vscode.OutputChannel,
): Promise<AnimatedTourCodeFrame | undefined> {
  let uri: vscode.Uri | null;
  try {
    uri = resolveStepUri(step, plan);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    warnings.push(`Could not resolve workspace target: ${detail}`);
    return undefined;
  }
  if (!uri) {
    warnings.push("The workspace file for this stop is not open in this VS Code window.");
    return undefined;
  }

  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.appendLine(`[export:animated] open failed for ${formatStepPath(step)}: ${detail}`);
    warnings.push("Could not read the workspace file for this stop.");
    return undefined;
  }

  if (doc.lineCount === 0) {
    return {
      text: "",
      startLine: 1,
      languageId: doc.languageId,
    };
  }

  const focusStart = step.range ? clamp(step.range.startLine - 1, 0, doc.lineCount - 1) : 0;
  const focusEnd = step.range ? clamp(step.range.endLine - 1, focusStart, doc.lineCount - 1) : 0;
  let start = step.range
    ? Math.max(0, focusStart - ANIMATED_EXPORT_CONTEXT_LINES)
    : 0;
  let end = step.range
    ? Math.min(doc.lineCount - 1, focusEnd + ANIMATED_EXPORT_CONTEXT_LINES)
    : Math.min(doc.lineCount - 1, ANIMATED_EXPORT_MAX_CODE_LINES - 1);

  if (end - start + 1 > ANIMATED_EXPORT_MAX_CODE_LINES) {
    end = start + ANIMATED_EXPORT_MAX_CODE_LINES - 1;
  }
  const truncated = start > 0 || end < doc.lineCount - 1;
  const lines: string[] = [];
  for (let line = start; line <= end; line++) {
    lines.push(doc.lineAt(line).text);
  }
  if (truncated) {
    warnings.push("Code snapshot was trimmed around the tour range.");
  }

  return {
    text: lines.join(doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"),
    startLine: start + 1,
    highlightStartLine: step.range ? focusStart + 1 : undefined,
    highlightEndLine: step.range ? focusEnd + 1 : undefined,
    languageId: doc.languageId,
    truncated,
  };
}

function resolveExportRange(step: TourStep, doc: vscode.TextDocument): vscode.Range {
  if (step.range) {
    const startLine = clamp(step.range.startLine - 1, 0, doc.lineCount - 1);
    const endLine = clamp(step.range.endLine - 1, startLine, doc.lineCount - 1);
    const startCol = clamp(step.range.startColumn - 1, 0, doc.lineAt(startLine).text.length);
    const endCol = clamp(step.range.endColumn - 1, 0, doc.lineAt(endLine).text.length);
    return new vscode.Range(startLine, startCol, endLine, endCol);
  }
  const end = Math.min(Math.max(doc.lineCount - 1, 0), 4);
  return new vscode.Range(0, 0, end, doc.lineAt(end).text.length);
}

function stepLocationLabel(step: TourStep): string {
  const target = formatStepPath(step);
  if (!step.range) return target;
  const { startLine, endLine } = step.range;
  return startLine === endLine ? `${target}:${startLine}` : `${target}:${startLine}-${endLine}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildAnimatedTtsDefaults(): AnimatedTourTtsDefaults {
  const cfg = vscode.workspace.getConfiguration("repoTrail");
  return {
    provider: cfg.get<AnimatedTourTtsDefaults["provider"]>("tts.provider", "system"),
    kokoroVoice: cfg.get<string>("tts.kokoroVoice", "af_heart"),
    elevenLabsVoiceId: cfg.get<string>("tts.elevenLabsVoiceId", "21m00Tcm4TlvDq8ikWAM"),
    elevenLabsModel: cfg.get<string>("tts.elevenLabsModel", "eleven_flash_v2_5"),
    openAiModel: cfg.get<string>("tts.openAiModel", "gpt-4o-mini-tts"),
    openAiVoice: cfg.get<string>("tts.openAiVoice", "ash"),
    openAiInstructions: cfg.get<string>(
      "tts.openAiInstructions",
      "Read this code walkthrough aloud like a friendly senior engineer pair-programming: clear, calm, with natural pacing.",
    ),
  };
}

/** Import a previously-exported JSON tour and load it as a fresh tour. */
async function importTour(controller: TourController, log: vscode.OutputChannel): Promise<void> {
  const rootPath = firstWorkspaceRoot();
  const root = rootPath ? vscode.Uri.file(rootPath) : undefined;
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
  const plan = resolveTourPlanRoots(snap.plan);
  const root = preferredRepoRootForPlan(plan) ?? firstWorkspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage("RepoTrail: open a workspace first.");
    return;
  }
  const slug = slugForFilename(plan.title);
  const content = planToJson(plan, new Date().toISOString());
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

async function migrateSavedToursToRepo(
  viewProvider: TourViewProvider,
  log: vscode.OutputChannel,
): Promise<void> {
  if (!hasWorkspaceFolders()) {
    vscode.window.showErrorMessage("RepoTrail: open the target workspace roots before migrating saved tours.");
    return;
  }

  let records;
  try {
    records = await listAllTourRecords();
  } catch (err) {
    log.appendLine(`[migrate] list failed: ${err instanceof Error ? err.message : String(err)}`);
    vscode.window.showErrorMessage("RepoTrail: saved tour migration failed (see Output - RepoTrail).");
    return;
  }

  let skippedArchived = 0;
  let skippedEmpty = 0;
  let skippedUnmatched = 0;
  let failed = 0;
  const migrated: string[] = [];

  for (const entry of records) {
    if (entry.archived) {
      skippedArchived++;
      continue;
    }
    if (entry.record.plan.steps.length === 0) {
      skippedEmpty++;
      continue;
    }
    const candidate = buildMigratedTour(entry.record);
    if (!candidate) {
      skippedUnmatched++;
      continue;
    }

    try {
      const content = planToJson(candidate.plan, new Date(entry.record.updatedAt).toISOString());
      const file = await saveRepoTourUnique(candidate.targetRoot, slugForFilename(candidate.plan.title), content);
      migrated.push(file);
      log.appendLine(`[migrate] ${entry.path} -> ${file}`);
    } catch (err) {
      failed++;
      log.appendLine(`[migrate] failed ${entry.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  viewProvider.refresh();
  const skipped = skippedArchived + skippedEmpty + skippedUnmatched;
  const message = `RepoTrail: migrated ${migrated.length} saved tour${migrated.length === 1 ? "" : "s"} to ${REPO_TOURS_DIR}/` +
    (skipped || failed ? ` (${skipped} skipped${failed ? `, ${failed} failed` : ""}).` : ".");
  const choice = await vscode.window.showInformationMessage(message, migrated.length ? "Show Files" : "Show Log");
  if (choice === "Show Files") {
    const docs = migrated.slice(0, 5).map((file) => vscode.workspace.openTextDocument(vscode.Uri.file(file)));
    for (const doc of await Promise.all(docs)) {
      await vscode.window.showTextDocument(doc, { preview: false });
    }
  } else if (choice === "Show Log") {
    log.show(true);
  }
}

function buildMigratedTour(record: TourRecord): { plan: TourPlan; targetRoot: string } | null {
  const folders = currentWorkspaceFolders();
  const infos = workspaceFolderInfos(folders);
  const aliases = buildRootAliases(infos.map((info) => info.name));
  const aliasesByPath = new Map(infos.map((info, index) => [info.path, aliases[index] ?? `root${index + 1}`]));
  const defaultFolder = resolveRecordWorkspaceFolder(record.workspaceRoot);
  const roots: NonNullable<TourPlan["roots"]> = { ...(record.plan.roots ?? {}) };
  const counts = new Map<string, number>();

  const steps = record.plan.steps.map((step) => {
    const folder = resolveStepFolderForMigration(step, record.plan, defaultFolder);
    if (!folder) return step;
    const alias = aliasesByPath.get(folder.uri.fsPath);
    if (!alias) return step;

    counts.set(folder.uri.fsPath, (counts.get(folder.uri.fsPath) ?? 0) + 1);
    roots[alias] = rootRefForFolder(folder, folders);
    const { workspaceFolder: _workspaceFolder, ...rest } = step;
    return { ...rest, root: alias };
  });

  let targetRoot: string | null = null;
  let targetCount = 0;
  for (const [root, count] of counts) {
    if (count > targetCount) {
      targetRoot = root;
      targetCount = count;
    }
  }
  if (!targetRoot) return null;

  return {
    targetRoot,
    plan: {
      ...record.plan,
      roots,
      steps,
    },
  };
}

function resolveStepFolderForMigration(
  step: TourStep,
  plan: TourPlan,
  defaultFolder: vscode.WorkspaceFolder | null,
): vscode.WorkspaceFolder | null {
  if (step.workspaceFolder || step.root) return resolveStepWorkspaceFolder(step, plan);
  return defaultFolder;
}

function resolveRecordWorkspaceFolder(workspaceRoot: string): vscode.WorkspaceFolder | null {
  if (!path.isAbsolute(workspaceRoot)) return null;
  return currentWorkspaceFolders().find((folder) => folder.uri.fsPath === workspaceRoot) ?? null;
}

function rootRefForFolder(
  folder: vscode.WorkspaceFolder,
  folders: readonly vscode.WorkspaceFolder[],
): NonNullable<TourPlan["roots"]>[string] {
  const identity = workspaceFolderIdentity(folder, folders);
  const ref: NonNullable<TourPlan["roots"]>[string] = {
    name: folder.name,
    pathHint: path.basename(folder.uri.fsPath),
  };
  if (identity !== folder.name) ref.workspaceFolder = identity;
  return ref;
}

/**
 * Right-click entry point: copy an agent prompt scoped to the file/selection
 * the user is looking at, so they can ask for a tour starting right here.
 */
async function tourFromHere(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !hasWorkspaceFolders()) {
    vscode.window.showInformationMessage("RepoTrail: open a file to tour from here.");
    return;
  }
  const target = relativePathInWorkspace(editor.document.uri);
  if (!target) {
    vscode.window.showInformationMessage("RepoTrail: open a workspace file to tour from here.");
    return;
  }
  const targetLabel = target.workspaceFolder
    ? `workspace folder \`${target.workspaceFolder}\`, file \`${target.file}\``
    : `\`${target.file}\``;
  const sel = editor.selection;
  const hasSel = !sel.isEmpty;
  const scope = hasSel
    ? `the selected code in ${targetLabel} (lines ${sel.start.line + 1}–${sel.end.line + 1})`
    : targetLabel;
  const prompt =
    `Use the repo-trail skill. Give me a RepoTrail tour starting from ${scope}. ` +
    `Walk through what it does and how it connects to the rest of the codebase, ` +
    `then write the complete tour as JSON under the owning project's ${REPO_TOURS_DIR}/ directory. ` +
    `Use root aliases for multi-root tours.`;
  await vscode.env.clipboard.writeText(prompt);
  await vscode.commands.executeCommand("repoTrail.tour.focus").then(undefined, () => {});
  vscode.window.setStatusBarMessage("RepoTrail: 'tour from here' prompt copied for your agent.", 3000);
}

async function copySelectionReference(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !hasWorkspaceFolders()) {
    vscode.window.showInformationMessage("RepoTrail: open a workspace file and select code first.");
    return;
  }
  const target = relativePathInWorkspace(editor.document.uri);
  if (!target) {
    vscode.window.showInformationMessage("RepoTrail: open a workspace file to copy a selection reference.");
    return;
  }
  const selectedLines = selectedFullLineRange({
    start: {
      line: editor.selection.start.line,
      character: editor.selection.start.character,
    },
    end: {
      line: editor.selection.end.line,
      character: editor.selection.end.character,
    },
  });
  if (!selectedLines) {
    vscode.window.showInformationMessage("RepoTrail: select code to copy a reference.");
    return;
  }

  const range = new vscode.Range(
    new vscode.Position(selectedLines.startLine, 0),
    editor.document.lineAt(selectedLines.endLine).range.end,
  );
  const code = editor.document.getText(range);
  const snippet = formatSelectionReference({
    ...target,
    startLine: selectedLines.startLine + 1,
    endLine: selectedLines.endLine + 1,
    languageId: editor.document.languageId,
    code,
  });
  await vscode.env.clipboard.writeText(snippet);

  const lineRef = selectedLines.startLine === selectedLines.endLine
    ? `${target.file}:${selectedLines.startLine + 1}`
    : `${target.file}:${selectedLines.startLine + 1}-${selectedLines.endLine + 1}`;
  vscode.window.setStatusBarMessage(`RepoTrail: copied ${lineRef} with code.`, 3000);
}

async function copyTourPrompt(): Promise<void> {
  if (!hasWorkspaceFolders()) {
    vscode.window.showErrorMessage("RepoTrail: open a folder/workspace first.");
    return;
  }
  const prompt = buildTourAuthoringPrompt();
  await vscode.env.clipboard.writeText(prompt);
  await vscode.commands.executeCommand("repoTrail.tour.focus").then(undefined, () => {});
  vscode.window.showInformationMessage(
    "RepoTrail tour authoring prompt copied. Paste it into your agent; it should write a .repotrail/*.json file.",
  );
}
