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
  codeFrameFromLines,
  planToAnimatedHtml,
} from "./engine/animatedHtml";
import {
  parseTourJson,
  stepLocation,
  planToJson,
  planToMarkdown,
  slugForFilename,
} from "./engine/tourSerialize";
import { materializeStepDiff } from "./diffMaterialize";
import { listRepoTours, readRepoTour, REPO_TOURS_DIR, saveRepoTour } from "./storage/repoTours";
import { renameRepoTourTitle, validateTourTitle } from "./storage/tourRename";
import { deleteTour, loadTour, saveTour, TourRecord } from "./storage/tourStore";
import {
  ACTIVE_TOUR_STATE_KEY,
  activeTourRefForRecord,
  activeTourRefForWorkspace,
} from "./storage/activeTour";
import { availableProviders, TtsManager, TtsProvider } from "./tts/manager";
import {
  browserTtsProvider,
  normalizeTtsProvider,
  TTS_DEFAULTS,
  TTS_SECRET_KEYS,
} from "./tts/config";
import { TourCodeLensProvider } from "./ux/codeLensProvider";
import { openSlideRef, setEditorLogger, setSlideChrome, setSlidePanel } from "./ux/editorActions";
import { Autoplay } from "./ux/autoplay";
import { PresentMode } from "./ux/presentMode";
import { SlidePanel } from "./ux/slidePanel";
import { deleteTourCommand } from "./ux/tourDelete";
import { commentOnPr } from "./ux/prComments";
import { onDidFindLateCheckout, setPullRequestReviewLogger, stopShowsReviewCheckout } from "./ux/pullRequestReview";
import { formatSelectionReference, selectedFullLineRange } from "./ux/selectionReference";
import { TourController } from "./ux/tourController";
import { reconcileTourUpdate } from "./ux/tourProgress";
import { TourFilesProvider } from "./ux/tourFilesView";
import { TourViewProvider } from "./ux/webviewPanel";
import { composeAgentSetupPrompt } from "./ux/agentSetupPrompt";
import {
  copyTourAsPrComment,
  findToursOnPrCommand,
  handleReviewUri,
  importTourFromPrCommand,
  PrImportContext,
  resumePendingPrImport,
} from "./ux/prImport";
import {
  currentWorkspaceFolders,
  currentWorkspaceStorageRoot,
  firstWorkspaceRoot,
  hasWorkspaceFolders,
  relativePathInWorkspace,
  resolveStepWorkspaceFolder,
  resolveStepUri,
  resolveTourPlanRoots,
  workspaceFolderInfos,
} from "./workspace";

let tourStatusItem: vscode.StatusBarItem | null = null;

const WORKSPACE_REGISTRY_DIR_DISPLAY = "~/.repotrail/workspaces";

type RenameTourArg = { rootPath?: string; file?: string };

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel("RepoTrail");
  context.subscriptions.push(log);
  setEditorLogger(log);
  setPullRequestReviewLogger(log);
  log.appendLine(`[ext] activate ${(context.extension.packageJSON as { version?: string }).version ?? "?"}`);
  try {
    await migrateLegacyTtsCredentials(context.secrets, log);
  } catch (err) {
    log.appendLine(`[tts] legacy credential migration failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const controller = new TourController();
  const presentMode = new PresentMode(controller, log);
  let autoplay: Autoplay | null = null;
  const slidePanel = new SlidePanel(
    context.extensionUri,
    {
      next: () => void controller.next(),
      back: () => void controller.back(),
      nextStop: () => void controller.nextStop(),
      openSource: () => void controller.openCurrentSource(),
      exitPresent: () => void presentMode.exit(),
      toggleAutoplay: () => autoplay?.toggle(),
      openRef: (ref, slideIndex) => {
        const snap = controller.snapshot();
        if (snap.plan && snap.index === slideIndex) void openSlideRef(ref, snap.current, snap.plan);
      },
    },
    log,
  );
  setSlidePanel(slidePanel);
  context.subscriptions.push({ dispose: () => slidePanel.close() });
  let persistQueue = Promise.resolve();
  controller.setPersistFn((record) => {
    persistQueue = persistQueue
      .then(async () => {
        if (!record) {
          await context.workspaceState.update(ACTIVE_TOUR_STATE_KEY, undefined);
          return;
        }
        await saveTour(record);
        await context.workspaceState.update(ACTIVE_TOUR_STATE_KEY, activeTourRefForRecord(record));
      })
      .catch((err) => {
        log.appendLine(`[store] persist failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  });
  // Queued behind pending saves, so a save can't bring a deleted record back.
  const forgetProgress = (workspaceRoot: string, id: string): Promise<void> => {
    persistQueue = persistQueue
      .then(async () => {
        if (!(await deleteTour(workspaceRoot, id))) log.appendLine(`[store] couldn't delete progress record ${id}`);
      })
      .catch((err) => {
        log.appendLine(`[store] forget failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    return persistQueue;
  };

  const viewProvider = new TourViewProvider(context.extensionUri, controller, log);
  viewProvider.setRepoTourLoader(async () => {
    return listRepoTours(repoTourRoots());
  });
  context.subscriptions.push(
    // Kept alive while hidden so narration keeps playing in present mode.
    vscode.window.registerWebviewViewProvider(TourViewProvider.viewType, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  const filesProvider = new TourFilesProvider(controller);
  const filesView = vscode.window.createTreeView("repoTrail.files", {
    treeDataProvider: filesProvider,
    showCollapseAll: true,
  });
  filesProvider.attach(filesView);
  context.subscriptions.push(filesView, filesProvider);
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
      void reloadActiveRepoTour(controller, uri, log, generation, () => reloadGeneration, forgetProgress);
    }, 150);
  };
  const activeRepoTourUri = (): vscode.Uri | null => {
    const source = controller.activeRepoTourSource;
    return source ? vscode.Uri.file(path.join(source.rootPath, REPO_TOURS_DIR, path.basename(source.file))) : null;
  };
  // Deleting or moving the whole .repotrail folder reports one event for the
  // folder, not one per tour file, so the folder is watched too.
  const repoTourDirWatcher = vscode.workspace.createFileSystemWatcher(`**/${REPO_TOURS_DIR}`);
  let windowFocused = vscode.window.state.focused;
  const repoTourDirDeleted = (uri: vscode.Uri) => {
    viewProvider.refresh();
    const active = activeRepoTourUri();
    if (active && path.resolve(path.dirname(active.fsPath)) === path.resolve(uri.fsPath)) scheduleRepoTourReload(active);
  };
  context.subscriptions.push(
    repoTourWatcher,
    repoTourWatcher.onDidCreate(scheduleRepoTourReload),
    repoTourWatcher.onDidChange(scheduleRepoTourReload),
    repoTourWatcher.onDidDelete(scheduleRepoTourReload),
    repoTourDirWatcher,
    repoTourDirWatcher.onDidCreate(refreshRepoTours),
    repoTourDirWatcher.onDidDelete(repoTourDirDeleted),
    // Safety net for events the watchers miss: on focus, drop an active tour
    // whose file is gone and redraw a library that changed.
    vscode.window.onDidChangeWindowState((state) => {
      const gainedFocus = state.focused && !windowFocused;
      windowFocused = state.focused;
      if (!gainedFocus) return;
      const active = activeRepoTourUri();
      if (active) {
        void Promise.resolve(vscode.workspace.fs.stat(active)).then(
          () => undefined,
          () => scheduleRepoTourReload(active),
        );
      } else {
        void viewProvider.refreshIfLibraryChanged();
      }
    }),
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

  const tts = new TtsManager(controller, log, context.secrets);
  viewProvider.registerSinkListener((sink) => tts.setWebviewSink(sink));
  context.subscriptions.push(tts);

  autoplay = new Autoplay(controller, tts, log);
  const player = autoplay;
  viewProvider.onTtsEnded(() => tts.notifyWebviewEnded());
  viewProvider.onTtsState((state) => player.ttsStateChanged(state));
  const refreshSlideChrome = () => {
    setSlideChrome({ presenting: presentMode.isActive, autoplay: player.isActive });
    controller.repostSlide();
  };
  context.subscriptions.push(
    player,
    presentMode,
    player.onDidChangeActive(refreshSlideChrome),
    presentMode.onDidChangeActive(refreshSlideChrome),
    // Leaving the tour leaves present mode too.
    controller.onDidChange(() => {
      if (presentMode.isActive && !controller.snapshot().plan) void presentMode.exit();
    }),
    vscode.commands.registerCommand("repoTrail.present", () => presentMode.toggle()),
    vscode.commands.registerCommand("repoTrail.autoplay", () => player.toggle()),
  );

  const prImport: PrImportContext = {
    controller,
    log,
    extensionId: context.extension.id,
  };
  // Review links: <any VS Code scheme>://repotrail.repotrail/review?pr=... The
  // scheme is whatever this editor registered (vscode, vscode-insiders, ...).
  context.subscriptions.push(
    vscode.window.registerUriHandler({ handleUri: (uri) => handleReviewUri(uri, prImport) }),
  );

  // A stop shown while GitHub Pull Requests was still starting up missed its
  // checkout; show it again once that extension answers.
  context.subscriptions.push(
    onDidFindLateCheckout(async (folder) => {
      try {
        const { plan, current } = controller.snapshot();
        if (!plan || !current?.diff?.headRef) return;
        if (resolveStepWorkspaceFolder(current, plan)?.uri.toString() !== folder.toString()) return;
        // Only when the stop would now show the checked-out file.
        if (!(await stopShowsReviewCheckout(current, plan, controller.activePullRequest ?? undefined))) return;
        if (controller.snapshot().current !== current) return;
        await controller.revealCurrent();
      } catch (err) {
        log.appendLine(`[pr-review] reopening the stop failed: ${String(err)}`);
      }
    }),
  );

  const codeLensProvider = new TourCodeLensProvider(controller);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, codeLensProvider),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("repoTrail.tour.focus", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.repoTrail");
    }),
    vscode.commands.registerCommand("repoTrail.copyAgentSetup", () => copyTourPrompt(context.extensionUri, log)),
    // Compatibility alias for the 0.11.0 command ID.
    vscode.commands.registerCommand("repoTrail.copyTourPrompt", () => copyTourPrompt(context.extensionUri, log)),
    vscode.commands.registerCommand("repoTrail.exportTour", () => exportActiveTour(controller, log, context.extensionUri)),
    vscode.commands.registerCommand("repoTrail.importTour", () => importTour(controller, log)),
    vscode.commands.registerCommand("repoTrail.importTourFromPr", () => importTourFromPrCommand(prImport)),
    vscode.commands.registerCommand("repoTrail.findToursOnPr", () => findToursOnPrCommand(prImport)),
    vscode.commands.registerCommand("repoTrail.copyTourAsPrComment", () => copyTourAsPrComment(prImport)),
    vscode.commands.registerCommand("repoTrail.saveTourToRepo", () => saveTourToRepo(controller, log)),
    vscode.commands.registerCommand("repoTrail.tourFromHere", () => tourFromHere(context.extensionUri, log)),
    vscode.commands.registerCommand("repoTrail.copySelectionReference", () => copySelectionReference()),
    vscode.commands.registerCommand("repoTrail.next", () => controller.next()),
    vscode.commands.registerCommand("repoTrail.back", () => controller.back()),
    vscode.commands.registerCommand("repoTrail.nextStop", () => controller.nextStop()),
    vscode.commands.registerCommand("repoTrail.showStep", (index?: number) => {
      if (typeof index === "number") void controller.showStep(index);
    }),
    vscode.commands.registerCommand("repoTrail.revealCurrent", () => controller.revealCurrent()),
    vscode.commands.registerCommand("repoTrail.openCurrentSource", () => controller.openCurrentSource()),
    vscode.commands.registerCommand("repoTrail.commentOnPr", () => commentOnPr(controller, log)),
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
      await controller.loadPlan(plan, currentWorkspaceStorageRoot(), { rootPath: root, file });
      await vscode.commands.executeCommand("repoTrail.tour.focus").then(undefined, () => {});
    }),
    vscode.commands.registerCommand("repoTrail.renameTour", (arg?: RenameTourArg) => renameTour(arg, controller, viewProvider, log)),
    vscode.commands.registerCommand("repoTrail.deleteTour", (arg?: RenameTourArg) =>
      deleteTourCommand(arg, {
        controller,
        log,
        roots: repoTourRoots,
        refresh: () => viewProvider.refresh(),
        forgetProgress,
      }),
    ),
    vscode.commands.registerCommand("repoTrail.deeper", () => copyDeepenPrompt(controller, viewProvider, log)),
    vscode.commands.registerCommand(
      "repoTrail.followUp",
      (question?: string) => copyFollowUpPrompt(controller, viewProvider, question ?? "", log),
    ),
    vscode.commands.registerCommand("repoTrail.stop", () => controller.stop()),
    vscode.commands.registerCommand("repoTrail.manageTtsCredentials", () => manageTtsCredentials(context.secrets)),
    vscode.commands.registerCommand("repoTrail.openNarration", () => {
      vscode.commands.executeCommand("repoTrail.tour.focus").then(undefined, () => {});
    }),
    vscode.commands.registerCommand("repoTrail.cycleTts", async () => {
      const cfg = vscode.workspace.getConfiguration("repoTrail");
      const cur = cfg.get<string>("tts.provider", TTS_DEFAULTS.provider) as TtsProvider;
      const order = await availableProviders(context.secrets);
      const idx = order.indexOf(cur);
      const next = order[(idx + 1) % order.length] ?? "off";
      await cfg.update("tts.provider", next, configurationTargetForSetting(cfg, "tts.provider"));
      vscode.window.setStatusBarMessage(`RepoTrail TTS: ${next}`, 1500);
      // Switching providers no longer auto-speaks — it only stops any current
      // narration. Use the Speak button to start playback on demand.
      tts.cancel();
    }),
    vscode.commands.registerCommand("repoTrail.speakCurrent", () => tts.speakCurrent()),
    vscode.commands.registerCommand("repoTrail.stopTts", () => tts.cancel()),
  );

  viewProvider.refresh();
  void restoreActiveTour(context, controller, log);
  void resumePendingPrImport(prImport);
  // A review link that opened in another window can hand its import to this
  // one by opening this folder, which focuses this window.
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) void resumePendingPrImport(prImport, { quiet: true });
    }),
  );
}

function configurationTargetForSetting(
  configuration: vscode.WorkspaceConfiguration,
  setting: string,
): vscode.ConfigurationTarget {
  const inspected = configuration.inspect(setting);
  if (inspected?.workspaceFolderValue !== undefined) return vscode.ConfigurationTarget.WorkspaceFolder;
  if (inspected?.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
  return vscode.ConfigurationTarget.Global;
}

async function manageTtsCredentials(secrets: vscode.SecretStorage): Promise<void> {
  const providers = [
    { label: "OpenAI TTS", secretKey: TTS_SECRET_KEYS.openAi, environmentKey: "OPENAI_API_KEY" },
    { label: "ElevenLabs TTS", secretKey: TTS_SECRET_KEYS.elevenLabs, environmentKey: "ELEVENLABS_API_KEY" },
  ];
  const states = await Promise.all(
    providers.map(async (provider) => ({
      ...provider,
      stored: Boolean((await readSecret(secrets, provider.secretKey))?.trim()),
      fromEnvironment: Boolean(process.env[provider.environmentKey]?.trim()),
    })),
  );
  const provider = await vscode.window.showQuickPick(
    states.map((state) => ({
      label: state.label,
      description: state.stored
        ? "Stored securely in VS Code"
        : state.fromEnvironment
          ? `Using ${state.environmentKey}`
          : "Not configured",
      state,
    })),
    { title: "Manage RepoTrail TTS credentials", placeHolder: "Choose a provider" },
  );
  if (!provider) return;

  const actions = [{ label: provider.state.stored ? "Replace stored API key" : "Store API key", action: "set" }];
  if (provider.state.stored) actions.push({ label: "Clear stored API key", action: "clear" });
  const action = await vscode.window.showQuickPick(actions, {
    title: provider.state.label,
    placeHolder: provider.state.fromEnvironment
      ? `${provider.state.environmentKey} is also available in this extension host.`
      : "API keys are stored in VS Code SecretStorage.",
  });
  if (!action) return;

  if (action.action === "clear") {
    await secrets.delete(provider.state.secretKey);
    vscode.window.setStatusBarMessage(`RepoTrail: cleared the stored ${provider.state.label} API key.`, 3000);
    return;
  }
  const value = await vscode.window.showInputBox({
    title: `Store ${provider.state.label} API key`,
    prompt: "Saved in VS Code SecretStorage. The value will not appear in settings.json.",
    password: true,
    ignoreFocusOut: true,
  });
  if (!value?.trim()) return;
  await secrets.store(provider.state.secretKey, value.trim());
  vscode.window.setStatusBarMessage(`RepoTrail: stored the ${provider.state.label} API key.`, 3000);
}

async function migrateLegacyTtsCredentials(
  secrets: vscode.SecretStorage,
  log: vscode.OutputChannel,
): Promise<void> {
  const legacy = [
    { setting: "tts.openAiApiKey", secretKey: TTS_SECRET_KEYS.openAi, label: "OpenAI" },
    { setting: "tts.elevenLabsApiKey", secretKey: TTS_SECRET_KEYS.elevenLabs, label: "ElevenLabs" },
  ];
  for (const item of legacy) {
    const base = vscode.workspace.getConfiguration("repoTrail");
    const folderConfigurations = currentWorkspaceFolders().map((folder) =>
      vscode.workspace.getConfiguration("repoTrail", folder.uri),
    );
    const candidates = [base, ...folderConfigurations]
      .map((configuration) => configuration.get<string>(item.setting, "").trim())
      .filter(Boolean);
    const stored = await readSecret(secrets, item.secretKey);
    if (!stored?.trim() && candidates[0]) {
      await secrets.store(item.secretKey, candidates[0]);
      log.appendLine(`[tts] migrated the ${item.label} API key to SecretStorage.`);
    }
    await clearLegacyTtsSetting(base, item.setting, vscode.ConfigurationTarget.Global, "globalValue", log);
    await clearLegacyTtsSetting(base, item.setting, vscode.ConfigurationTarget.Workspace, "workspaceValue", log);
    for (const configuration of folderConfigurations) {
      await clearLegacyTtsSetting(
        configuration,
        item.setting,
        vscode.ConfigurationTarget.WorkspaceFolder,
        "workspaceFolderValue",
        log,
      );
    }
  }
}

async function readSecret(secrets: vscode.SecretStorage, key: string): Promise<string | undefined> {
  try {
    return await secrets.get(key);
  } catch {
    return undefined;
  }
}

async function clearLegacyTtsSetting(
  configuration: vscode.WorkspaceConfiguration,
  setting: string,
  target: vscode.ConfigurationTarget,
  field: "globalValue" | "workspaceValue" | "workspaceFolderValue",
  log: vscode.OutputChannel,
): Promise<void> {
  const inspected = configuration.inspect<string>(setting);
  if (inspected?.[field] === undefined) return;
  try {
    await configuration.update(setting, undefined, target);
  } catch (err) {
    log.appendLine(`[tts] could not remove legacy ${setting}: ${err instanceof Error ? err.message : String(err)}`);
  }
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
    const repoFile = arg?.file;
    const repoRoot = arg?.rootPath;

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
  forgetProgress: (workspaceRoot: string, id: string) => Promise<void>,
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
      const progressId = controller.activeTourId;
      const storageRoot = controller.activeWorkspaceRoot ?? currentWorkspaceStorageRoot();
      controller.stop({ forgetRepoSource: true });
      if (progressId) await forgetProgress(storageRoot, progressId);
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
): Promise<TourRecord | null> {
  const source = record.repoTourSource;
  if (!source) return record;
  const plan = await readRepoTour(source.rootPath, source.file);
  if (!plan) {
    log.appendLine(
      `[repo-tour] skipped cached progress because ${path.join(source.rootPath, REPO_TOURS_DIR, source.file)} is unavailable`,
    );
    return null;
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

function buildTourAuthoringPrompt(paths: { schema: string; cli: string }): string {
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
    "Create a RepoTrail tour for this VS Code workspace.",
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
    "- If the subject is a design document, RFC, ADR, proposal, or architecture plan, even one that arrives as a PR, create a design-review tour (kind \"design-review\") built from slides, as the skill's \"Design Reviews And Slides\" section describes.",
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
    `- Check the finished file with RepoTrail's linter and fix every error: node "${paths.cli}" lint <tour file>. It validates against the JSON Schema at ${paths.schema}, checks beat ids, sources and text budgets. Pass --root <alias>=<dir> for roots outside the tour's project.`,
    `- For slides, if you can open a browser: node "${paths.cli}" render <tour file> --out <file.html>, then open <file.html>#stop=<n>&beat=<k> to see any slide at any beat.`,
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

/** Restore the tour that was still active when this workspace last closed. */
async function restoreActiveTour(
  context: vscode.ExtensionContext,
  controller: TourController,
  log: vscode.OutputChannel,
): Promise<void> {
  if (controller.activeTourId) return;
  if (!hasWorkspaceFolders()) return;
  const root = currentWorkspaceStorageRoot();
  const rawRef = context.workspaceState.get<unknown>(ACTIVE_TOUR_STATE_KEY);
  const ref = activeTourRefForWorkspace(rawRef, root);
  if (!ref) {
    if (rawRef !== undefined) await context.workspaceState.update(ACTIVE_TOUR_STATE_KEY, undefined);
    return;
  }
  const record = await loadTour(ref.workspaceRoot, ref.id);
  if (!record) {
    await context.workspaceState.update(ACTIVE_TOUR_STATE_KEY, undefined);
    return;
  }
  const refreshed = await refreshTourRecordFromSource(record, log);
  if (!refreshed) {
    await context.workspaceState.update(ACTIVE_TOUR_STATE_KEY, undefined);
    return;
  }
  if (controller.activeTourId) return;
  await controller.resume(refreshed);
  await vscode.commands.executeCommand("repoTrail.tour.focus").then(undefined, () => {});
  log.appendLine(`[resume] restored active tour "${refreshed.plan.title}"`);
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
async function exportActiveTour(
  controller: TourController,
  log: vscode.OutputChannel,
  extensionUri: vscode.Uri,
): Promise<void> {
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
        slideRuntime: snap.plan.steps.some((step) => step.slide) ? await readSlideRuntime(extensionUri, log) : undefined,
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
  if (step.slide) {
    return {
      index,
      title: step.title,
      location: stepLocationLabel(step),
      explanation: step.explanation,
      viewLabel: "Slide",
      slide: step.slide,
      warnings: [],
    };
  }
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

  const lines: string[] = [];
  for (let line = 0; line < doc.lineCount; line++) lines.push(doc.lineAt(line).text);
  const snapshot = codeFrameFromLines(
    lines,
    step.range,
    doc.languageId,
    doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n",
  );
  warnings.push(...snapshot.warnings);
  return snapshot.frame;
}

/** The slide runtime the Slides panel uses, for inlining into an HTML export. */
async function readSlideRuntime(
  extensionUri: vscode.Uri,
  log: vscode.OutputChannel,
): Promise<{ script: string; css: string } | undefined> {
  try {
    const [script, css] = await Promise.all(
      ["slides.js", "slides.css"].map(async (name) =>
        Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionUri, "out", name))).toString("utf8"),
      ),
    );
    return { script, css };
  } catch (err) {
    log.appendLine(`[export:animated] slide runtime unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
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
  return stepLocation(step);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildAnimatedTtsDefaults(): AnimatedTourTtsDefaults {
  const cfg = vscode.workspace.getConfiguration("repoTrail");
  return {
    provider: browserTtsProvider(normalizeTtsProvider(cfg.get<string>("tts.provider", TTS_DEFAULTS.provider))),
    kokoroVoice: cfg.get<string>("tts.kokoroVoice", TTS_DEFAULTS.kokoroVoice),
    elevenLabsVoiceId: cfg.get<string>("tts.elevenLabsVoiceId", TTS_DEFAULTS.elevenLabsVoiceId),
    elevenLabsModel: cfg.get<string>("tts.elevenLabsModel", TTS_DEFAULTS.elevenLabsModel),
    openAiModel: cfg.get<string>("tts.openAiModel", TTS_DEFAULTS.openAiModel),
    openAiVoice: cfg.get<string>("tts.openAiVoice", TTS_DEFAULTS.openAiVoice),
    openAiInstructions: cfg.get<string>("tts.openAiInstructions", TTS_DEFAULTS.openAiInstructions),
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
 * then chooses whether/when to `git commit` it — saving never touches git. Once
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

/**
 * Right-click entry point: copy an agent prompt scoped to the file/selection
 * the user is looking at, so they can ask for a tour starting right here.
 */
async function tourFromHere(extensionUri: vscode.Uri, log: vscode.OutputChannel): Promise<void> {
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
    `Give me a RepoTrail tour starting from ${scope}. ` +
    `Walk through what it does and how it connects to the rest of the codebase, ` +
    `then write the complete tour as JSON under the owning project's ${REPO_TOURS_DIR}/ directory. ` +
    `Use root aliases for multi-root tours.`;
  if (!await copyBundledAgentPrompt(extensionUri, prompt, log)) return;
  await vscode.commands.executeCommand("repoTrail.tour.focus").then(undefined, () => {});
  vscode.window.setStatusBarMessage("RepoTrail: 'tour from here' prompt and bundled skill copied.", 3000);
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

async function copyTourPrompt(extensionUri: vscode.Uri, log: vscode.OutputChannel): Promise<void> {
  if (!hasWorkspaceFolders()) {
    vscode.window.showErrorMessage("RepoTrail: open a folder/workspace first.");
    return;
  }
  const paths = {
    schema: vscode.Uri.joinPath(extensionUri, "harness", "tour.schema.json").fsPath,
    cli: vscode.Uri.joinPath(extensionUri, "out", "cli.js").fsPath,
  };
  if (!await copyBundledAgentPrompt(extensionUri, buildTourAuthoringPrompt(paths), log)) return;
  await vscode.commands.executeCommand("repoTrail.tour.focus").then(undefined, () => {});
  vscode.window.showInformationMessage(
    "RepoTrail agent setup copied with the bundled skill. Paste it into your agent; it should write a .repotrail/*.json file.",
  );
}

async function copyBundledAgentPrompt(
  extensionUri: vscode.Uri,
  request: string,
  log: vscode.OutputChannel,
): Promise<boolean> {
  const skillUri = vscode.Uri.joinPath(extensionUri, "harness", "repo-trail", "SKILL.md");
  try {
    const bytes = await vscode.workspace.fs.readFile(skillUri);
    const prompt = composeAgentSetupPrompt(Buffer.from(bytes).toString("utf8"), request);
    await vscode.env.clipboard.writeText(prompt);
    return true;
  } catch (err) {
    log.appendLine(`[agent-setup] failed to read ${skillUri.toString()}: ${err instanceof Error ? err.message : String(err)}`);
    vscode.window.showErrorMessage(
      "RepoTrail: the bundled agent skill could not be read. Reinstall the extension and try again.",
    );
    return false;
  }
}
