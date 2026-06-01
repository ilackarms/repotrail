import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { RepoTourSummary } from "../storage/repoTours";
import { TourSummary } from "../storage/tourStore";
import { TourController } from "./tourController";

type WebviewSink = (msg: { type: string; text?: string }) => void;

/**
 * Narration WebviewViewProvider. Renders the current step's title +
 * explanation and exposes next/back/deeper/follow-up controls.
 *
 * Also hosts the TTS playback surface. The extension host posts one of:
 * `tts.speak` (engine=system → SpeechSynthesis, engine=kokoro → local Kokoro-82M
 * neural voice via WASM), `tts.audio` (MP3 bytes from a hosted provider), or
 * `tts.cancel`. Set `retainContextWhenHidden: true` so playback (and the cached
 * Kokoro model) survive the user collapsing the sidebar mid-utterance.
 */
export class TourViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "codeAtlas.tour";

  private view: vscode.WebviewView | undefined;
  private onSinkChange: ((sink: WebviewSink | null) => void) | null = null;
  private tourListLoader: (() => Promise<TourSummary[]>) | null = null;
  private repoTourLoader: (() => Promise<RepoTourSummary[]>) | null = null;
  private mcpStatusLoader: (() => { enabled: boolean; port: number | null }) | null = null;

  private warnedKokoroFallback = false;

  // The last clipboard-bridge prompt (deepen / follow-up) so we can show the
  // user exactly what to paste, rather than a fire-and-forget toast. Pinned to
  // the step it was generated for; cleared once the user navigates away.
  private bridge: { label: string; prompt: string; index: number } | null = null;

  // Track step count per tour so we can flag agent-inserted steps.
  private lastTotal = 0;
  private lastTourId: string | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: TourController,
    private readonly log: vscode.OutputChannel,
  ) {
    controller.onDidChange(() => void this.render());
    // Re-render when the TTS settings change so the "Voice: …" hint and the
    // Speak button's enabled state stay in sync (config changes don't trigger a
    // controller change on their own).
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codeAtlas.tts")) void this.render();
    });
  }

  /** Lets the extension supply a function that returns saved tours. */
  setTourListLoader(fn: () => Promise<TourSummary[]>): void {
    this.tourListLoader = fn;
    void this.render();
  }

  /** Lets the extension supply tours committed to the repo (.codeatlas/). */
  setRepoTourLoader(fn: () => Promise<RepoTourSummary[]>): void {
    this.repoTourLoader = fn;
    void this.render();
  }

  /** Lets the extension report MCP server status for the empty-state hint. */
  setMcpStatusLoader(fn: () => { enabled: boolean; port: number | null }): void {
    this.mcpStatusLoader = fn;
    void this.render();
  }

  /** Toggle continuous "play the tour" mode (from a command/keybinding). */
  togglePlay(): void {
    this.view?.webview.postMessage({ type: "tts.togglePlay" });
  }

  /**
   * Display the prompt a clipboard-bridge action (deepen / follow-up) just
   * copied, so the user can see what to paste into Claude Code instead of
   * guessing. Pinned to the current step.
   */
  showBridgePrompt(label: string, prompt: string): void {
    const snap = this.controller.snapshot();
    this.bridge = { label, prompt, index: snap.index };
    void this.render();
  }

  /** Trigger a re-render (e.g. after a tour is deleted externally). */
  refresh(): void {
    void this.render();
  }

  /** Called by extension.ts to wire the TtsManager. */
  registerSinkListener(fn: (sink: WebviewSink | null) => void): void {
    this.onSinkChange = fn;
    if (this.view) {
      fn((msg) => this.view!.webview.postMessage(msg));
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };

    // Keep the webview's JS alive while the sidebar is collapsed so TTS doesn't
    // get cut off mid-utterance.
    (view as { retainContextWhenHidden?: boolean }).retainContextWhenHidden = true;

    view.onDidDispose(() => {
      this.onSinkChange?.(null);
      this.view = undefined;
    });

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg?.type) {
        case "start":
          await vscode.commands.executeCommand("codeAtlas.startTour");
          break;
        case "startFromAgent":
          await vscode.commands.executeCommand("codeAtlas.startFromAgent");
          break;
        case "runSample":
          await vscode.commands.executeCommand("codeAtlas.runSampleTour");
          break;
        case "importTour":
          await vscode.commands.executeCommand("codeAtlas.importTour");
          break;
        case "exportTour":
          await vscode.commands.executeCommand("codeAtlas.exportTour");
          break;
        case "next":
          await this.controller.next();
          break;
        case "back":
          await this.controller.back();
          break;
        case "showStep":
          if (typeof msg.index === "number") await this.controller.showStep(msg.index);
          break;
        case "revealCurrent":
          await this.controller.revealCurrent();
          break;
        case "dismissBridge":
          this.bridge = null;
          await this.render();
          break;
        case "deeper":
          await vscode.commands.executeCommand("codeAtlas.deeper");
          break;
        case "followUp":
          if (typeof msg.question === "string" && msg.question.trim()) {
            await vscode.commands.executeCommand("codeAtlas.followUp", msg.question);
          }
          break;
        case "stop":
          this.controller.stop();
          break;
        case "speakCurrent":
          await vscode.commands.executeCommand("codeAtlas.speakCurrent");
          break;
        case "stopTts":
          await vscode.commands.executeCommand("codeAtlas.stopTts");
          break;
        case "openTtsSettings":
          await vscode.commands.executeCommand("workbench.action.openSettings", "codeAtlas.tts.provider");
          break;
        case "tts.log":
          if (typeof msg.message === "string") {
            this.log.appendLine(`[tts:webview] ${msg.message}`);
            if (msg.kokoroFellBack && !this.warnedKokoroFallback) {
              this.warnedKokoroFallback = true;
              void vscode.window
                .showWarningMessage(
                  "Code Atlas: the Kokoro neural voice failed to load — using the system voice instead.",
                  "Show Details",
                )
                .then((c) => {
                  if (c === "Show Details") this.log.show(true);
                });
            }
            if (msg.audioFailed) {
              const detail = msg.autoplayBlocked
                ? "the sidebar blocked audio autoplay. Tell me and I'll route playback through an unlocked AudioContext."
                : "the audio could not be played in the sidebar. See the Code Atlas output log.";
              void vscode.window
                .showWarningMessage(`Code Atlas: ${detail}`, "Show Log")
                .then((c) => {
                  if (c === "Show Log") this.log.show(true);
                });
            }
          }
          break;
        case "resumeTour":
          if (typeof msg.id === "string") {
            await vscode.commands.executeCommand("codeAtlas.resumeTour", msg.id);
          }
          break;
        case "resumeRepoTour":
          if (typeof msg.file === "string") {
            await vscode.commands.executeCommand("codeAtlas.resumeRepoTour", msg.file);
          }
          break;
        case "deleteTour":
          if (typeof msg.id === "string") {
            await vscode.commands.executeCommand("codeAtlas.deleteTour", msg.id);
          }
          break;
        case "refreshTours":
          await this.render();
          break;
      }
    });

    this.onSinkChange?.((msg) => view.webview.postMessage(msg));
    void this.render();
  }

  private async render(): Promise<void> {
    if (!this.view) return;
    const snap = this.controller.snapshot();
    const provider = vscode.workspace.getConfiguration("codeAtlas").get<string>("tts.provider", "system");
    const tours = snap.plan ? [] : await this.loadTours();
    const repoTours = snap.plan ? [] : await this.loadRepoTours();

    const total = snap.plan?.steps.length ?? 0;
    const tourId = this.controller.activeTourId;

    // "Steps added" banner: only when the agent spliced steps into a tour the
    // user is already on (insert) — not during initial emission or navigation.
    let addedBanner = 0;
    if (
      tourId &&
      tourId === this.lastTourId &&
      this.controller.lastMutation === "insert" &&
      total > this.lastTotal
    ) {
      addedBanner = total - this.lastTotal;
    }
    this.lastTotal = total;
    this.lastTourId = tourId;

    // A bridge prompt is pinned to one step; drop it once the user moves on.
    if (this.bridge && (!snap.plan || this.bridge.index !== snap.index)) {
      this.bridge = null;
    }

    const mcp = this.mcpStatusLoader?.() ?? { enabled: true, port: null };

    this.view.webview.html = this.html(snap, provider, tours, {
      addedBanner,
      bridge: this.bridge,
      mcp,
      repoTours,
    });
  }

  private async loadTours(): Promise<TourSummary[]> {
    if (!this.tourListLoader) return [];
    try {
      return await this.tourListLoader();
    } catch {
      return [];
    }
  }

  private async loadRepoTours(): Promise<RepoTourSummary[]> {
    if (!this.repoTourLoader) return [];
    try {
      return await this.repoTourLoader();
    } catch {
      return [];
    }
  }

  private html(
    snap: ReturnType<TourController["snapshot"]>,
    ttsProvider: string,
    tours: TourSummary[],
    extra: {
      addedBanner: number;
      bridge: { label: string; prompt: string; index: number } | null;
      mcp: { enabled: boolean; port: number | null };
      repoTours: RepoTourSummary[];
    },
  ): string {
    const { plan, index, current } = snap;
    const total = plan?.steps.length ?? 0;
    const seenSet = new Set(snap.seen);
    const progressPct = total > 0 ? Math.round(((index + 1) / total) * 100) : 0;
    const title = current?.title ?? "No active tour";
    const explanation = current?.explanation ?? "";
    const fileLabel = current?.file ?? "";

    const escape = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    const nonce = randomBytes(16).toString("hex");

    // Ordered list of every stop — the actual "atlas". Click to jump.
    const overview = (() => {
      if (!plan || plan.steps.length === 0) return "";
      const rows = plan.steps
        .map((s, i) => {
          const loc = s.range ? `${s.file}:${s.range.startLine}` : s.file;
          const drift = snap.drift[i];
          const driftIcon = drift === "missing" ? "⚠" : drift === "relocated" ? "↪" : "";
          const driftTitle =
            drift === "missing"
              ? "The anchored code is gone — this stop may be stale."
              : drift === "relocated"
                ? "Code moved since this stop was authored — highlight re-anchored."
                : "";
          const cls = [
            "stop",
            i === index ? "active" : "",
            seenSet.has(i) && i !== index ? "seen" : "",
            drift && drift !== "ok" ? "drift" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return `
            <li class="${cls}" data-index="${i}">
              <span class="stop-num">${i + 1}</span>
              <span class="stop-body">
                <span class="stop-title">${seenSet.has(i) && i !== index ? "✓ " : ""}${driftIcon ? `<span class="drift-mark" title="${escape(driftTitle)}">${driftIcon}</span> ` : ""}${escape(s.title)}</span>
                <span class="stop-loc">${escape(loc)}</span>
              </span>
            </li>`;
        })
        .join("");
      return `
        <details id="routePanel" class="route-panel" open>
          <summary>
            <span class="route-summary-row">
              <span>Route · ${total} stop${total === 1 ? "" : "s"}</span>
              <span class="route-current">current ${index + 1}/${total}</span>
            </span>
          </summary>
          <ol class="stops">${rows}</ol>
        </details>`;
    })();

    // Banner shown when the agent spliced new steps into the active tour.
    const banner =
      extra.addedBanner > 0
        ? `<div class="banner">▲ ${extra.addedBanner} step${extra.addedBanner === 1 ? "" : "s"} added by the agent — click <strong>Next →</strong> or pick one from the route below.</div>`
        : "";

    // Drift notice: the code this stop points at changed since the tour was
    // authored. "relocated" = we found it and re-anchored; "missing" = gone.
    const driftBadge =
      snap.currentDrift === "relocated"
        ? `<div class="drift-badge relocated">↪ The code for this stop moved since the tour was authored — the highlight was re-anchored to where it is now.</div>`
        : snap.currentDrift === "missing"
          ? `<div class="drift-badge missing">⚠ The code this stop described is no longer in the file — the highlight may be stale. The tour may need updating.</div>`
          : "";

    // The exact prompt a deepen/follow-up just copied, so the user sees what to
    // paste rather than getting a blind "copied to clipboard" toast.
    const bridgeBlock = extra.bridge
      ? `
        <div class="bridge">
          <div class="bridge-head">
            <span>📋 ${escape(extra.bridge.label)} — paste into Claude Code</span>
            <button id="dismissBridge" class="link">dismiss</button>
          </div>
          <pre class="bridge-prompt">${escape(extra.bridge.prompt)}</pre>
          <div class="meta">Copied to your clipboard. Paste it into your Claude Code session; the agent will mutate the tour and you'll see a banner here when steps land.</div>
        </div>`
      : "";

    // Empty state: be honest that tours are generated by the agent over MCP.
    const mcpLine = (() => {
      if (!extra.mcp.enabled) return `MCP server off — enable <code>codeAtlas.mcpEnabled</code> so your agent can connect.`;
      if (extra.mcp.port) return `MCP listening on <code>127.0.0.1:${extra.mcp.port}</code> — your agent can drive tours.`;
      return `MCP server starting…`;
    })();

    const emptyState = plan
      ? ""
      : `
        <h2>No active tour</h2>
        <div class="explanation">Code Atlas tours are generated by your AI agent (Claude Code) over MCP, then you navigate them here. Ask it for <em>"a Code Atlas tour of this repo"</em> — or kick the tires with a sample.</div>
        <div class="controls">
          <button id="startFromAgent">Start a tour from Claude Code</button>
          <button id="runSample" class="secondary">Run sample tour</button>
          <button id="importTour" class="secondary">Import tour…</button>
        </div>
        <div class="meta">${mcpLine}</div>`;

    const tourList = (() => {
      if (snap.plan || tours.length === 0) return "";
      const rows = tours
        .map((t) => {
          const updated = new Date(t.updatedAt).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          });
          return `
            <li class="tour-item">
              <div class="tour-row">
                <div class="tour-title" title="${escape(t.title)}">${escape(t.title || "(untitled)")}</div>
                <div class="tour-meta">${escape(t.kind)} · ${t.stepCount} stops · step ${t.lastIndex + 1} · ${escape(updated)}</div>
              </div>
              <div class="tour-actions">
                <button class="resume" data-id="${escape(t.id)}">Resume</button>
                <button class="del secondary" data-id="${escape(t.id)}" title="Delete this saved tour">🗑</button>
              </div>
            </li>`;
        })
        .join("");
      return `
        <h3 class="section-h">Saved tours</h3>
        <ul class="tour-list">${rows}</ul>`;
    })();

    // Tours committed into the repo (.codeatlas/) — the team-shared artifact.
    const repoTourList = (() => {
      if (snap.plan || extra.repoTours.length === 0) return "";
      const rows = extra.repoTours
        .map(
          (t) => `
            <li class="tour-item">
              <div class="tour-row">
                <div class="tour-title" title="${escape(t.title)}">${escape(t.title || "(untitled)")}</div>
                <div class="tour-meta">${escape(t.kind)} · ${t.stepCount} stops · ${escape(t.file)}</div>
              </div>
              <div class="tour-actions">
                <button class="repo-resume" data-file="${escape(t.file)}">Open</button>
              </div>
            </li>`,
        )
        .join("");
      return `
        <h3 class="section-h">Tours in this repo</h3>
        <ul class="tour-list">${rows}</ul>`;
    })();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval' https://esm.sh https://cdn.jsdelivr.net; style-src 'unsafe-inline'; connect-src https: data: blob:; media-src blob: data:; img-src https: data:; font-src https: data:; worker-src blob:; child-src blob:;" />
<style>
  html, body { height: 100%; }
  body { box-sizing: border-box; margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: 13px; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  body.empty { padding: 12px; overflow: auto; }
  body.active { overflow: hidden; }
  h2 { margin: 0 0 4px 0; font-size: 14px; line-height: 1.35; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 12px; }
  .tour-shell { height: 100vh; min-height: 0; display: flex; flex-direction: column; }
  .nav-dock { flex: 0 0 auto; padding: 10px 12px 8px; border-bottom: 1px solid var(--vscode-panel-border, transparent); background: var(--vscode-sideBar-background, var(--vscode-editor-background)); box-shadow: 0 1px 0 rgba(0, 0, 0, 0.08); z-index: 1; }
  .stop-kicker { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .step-count { flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .file-chip { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nav-title { margin-bottom: 8px; }
  .tour-main { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 10px 12px 14px; }
  .explanation { white-space: pre-wrap; line-height: 1.5; margin-bottom: 16px; }
  .controls { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
  .nav-dock .controls { margin-bottom: 8px; }
  .nav-dock .follow-up { margin: 8px 0 4px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 10px; cursor: pointer; border-radius: 2px; font-size: 12px; line-height: 1.2; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:focus-visible, input:focus-visible, summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  button:disabled { opacity: 0.5; cursor: default; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  input { width: 100%; box-sizing: border-box; padding: 5px 7px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
  .answer { margin-top: 8px; padding: 8px; background: var(--vscode-textCodeBlock-background); border-radius: 2px; white-space: pre-wrap; }
  .section-h { margin: 20px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground); }
  .tour-list { list-style: none; margin: 0; padding: 0; }
  .tour-item { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
  .tour-row { flex: 1; min-width: 0; }
  .tour-title { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tour-meta { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 2px; }
  .tour-actions { display: flex; gap: 4px; flex-shrink: 0; }
  .tour-actions button { padding: 3px 8px; font-size: 11px; }
  .banner { background: var(--vscode-inputValidation-infoBackground, var(--vscode-textBlockQuote-background)); border: 1px solid var(--vscode-inputValidation-infoBorder, var(--vscode-focusBorder)); border-radius: 3px; padding: 6px 8px; margin-bottom: 10px; font-size: 12px; line-height: 1.4; }
  .bridge { border: 1px solid var(--vscode-panel-border, var(--vscode-focusBorder)); border-radius: 3px; padding: 8px; margin-bottom: 12px; background: var(--vscode-textCodeBlock-background); }
  .bridge-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
  .bridge-prompt { white-space: pre-wrap; word-break: break-word; margin: 0 0 6px 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.4; max-height: 180px; overflow: auto; }
  button.link { background: none; border: none; color: var(--vscode-textLink-foreground); padding: 0; cursor: pointer; font-size: 11px; }
  button.link:hover { text-decoration: underline; background: none; }
  .route-panel { margin-top: 8px; border: 1px solid var(--vscode-panel-border, transparent); border-radius: 3px; background: var(--vscode-editorWidget-background, var(--vscode-sideBarSectionHeader-background, transparent)); }
  .route-panel summary { padding: 6px 8px; cursor: pointer; color: var(--vscode-foreground); font-size: 12px; user-select: none; }
  .route-panel summary::marker { color: var(--vscode-descriptionForeground); }
  .route-summary-row { display: inline-flex; align-items: center; justify-content: space-between; gap: 8px; width: calc(100% - 16px); min-width: 0; vertical-align: top; }
  .route-summary-row span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .route-current { flex-shrink: 0; color: var(--vscode-descriptionForeground); font-size: 11px; font-variant-numeric: tabular-nums; }
  .stops { list-style: none; margin: 0; padding: 2px 4px 6px; max-height: min(34vh, 260px); overflow: auto; border-top: 1px solid var(--vscode-panel-border, transparent); }
  .stop { display: flex; gap: 8px; align-items: baseline; padding: 5px 6px; cursor: pointer; border-radius: 3px; border-left: 2px solid transparent; }
  .stop:hover { background: var(--vscode-list-hoverBackground); }
  .stop.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); border-left-color: var(--vscode-focusBorder); }
  .stop-num { flex-shrink: 0; width: 1.4em; text-align: right; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .stop.active .stop-num { color: inherit; }
  .stop-body { display: flex; flex-direction: column; min-width: 0; }
  .stop-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stop-loc { color: var(--vscode-descriptionForeground); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stop.active .stop-loc { color: inherit; opacity: 0.8; }
  .stop.seen:not(.active) .stop-title { opacity: 0.6; }
  .stop.seen:not(.active) .stop-num { opacity: 0.6; }
  .drift-mark { color: var(--vscode-editorWarning-foreground, #cca700); }
  .progress { height: 3px; border-radius: 2px; background: var(--vscode-panel-border, rgba(127,127,127,0.3)); margin-bottom: 8px; overflow: hidden; }
  .progress-fill { height: 100%; background: var(--vscode-progressBar-background, var(--vscode-focusBorder)); transition: width 0.2s ease; }
  .drift-badge { border-radius: 3px; padding: 6px 8px; margin-bottom: 12px; font-size: 12px; line-height: 1.4; }
  .drift-badge.relocated { background: var(--vscode-inputValidation-warningBackground, var(--vscode-textBlockQuote-background)); border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground)); }
  .drift-badge.missing { background: var(--vscode-inputValidation-errorBackground, var(--vscode-textBlockQuote-background)); border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-editorError-foreground)); }
</style>
</head>
<body class="${plan ? "active" : "empty"}">
  ${plan ? `
    <div class="tour-shell">
      <section class="nav-dock" aria-label="Tour navigation">
        <div class="stop-kicker">
          <span class="step-count">Step ${index + 1} of ${total}</span>
          <span class="file-chip" title="${escape(fileLabel)}">${escape(fileLabel)}</span>
        </div>
        <div class="progress" title="${index + 1} of ${total}"><div class="progress-fill" style="width:${progressPct}%"></div></div>
        <h2 class="nav-title">${escape(title)}</h2>
        <div class="controls">
          <button id="back" ${index === 0 ? "disabled" : ""} title="Previous stop">← Back</button>
          <button id="next" ${index >= total - 1 ? "disabled" : ""} title="Next stop">Next →</button>
          <button id="revealCurrent" title="Jump back to this step's selected code">↩ Code</button>
          <button id="deeper" title="Copy a 'deepen this step' prompt to clipboard for your Claude Code session">📋 Deepen</button>
          <button id="stop" title="Stop this tour">Stop</button>
          <button id="playPause" class="secondary" ${ttsProvider === "off" ? "disabled" : ""} title="Read this stop aloud">🔊 Speak</button>
          <button id="playTour" class="secondary" ${ttsProvider === "off" || total < 2 ? "disabled" : ""} title="Play the whole tour: read each stop aloud and auto-advance">▶ Play</button>
          <button id="exportTour" class="secondary" title="Export this tour as Markdown, JSON, or save it into the repo">⤓ Export</button>
        </div>
        <input id="q" class="follow-up" placeholder="Follow-up question — Enter to copy prompt" />
        <div class="meta">Voice: ${escape(ttsProvider)} · <a href="#" id="openTtsSettings">settings</a> · Deepen/follow-up copy prompts for Claude Code.</div>
        ${overview}
      </section>
      <main class="tour-main">
        ${banner}
        ${driftBadge}
        ${bridgeBlock}
        <div class="explanation">${escape(explanation)}</div>
      </main>
    </div>
  ` : `${emptyState}${tourList}${repoTourList}`}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const HAS_TOUR = ${plan ? "true" : "false"};
    const IS_LAST = ${plan ? (index >= total - 1 ? "true" : "false") : "true"};
    const send = (msg) => vscode.postMessage(msg);
    const readState = () => {
      try { return vscode.getState?.() || {}; } catch (e) { return {}; }
    };
    const writeState = (patch) => {
      try { vscode.setState({ ...readState(), ...patch }); } catch (e) {}
    };
    const on = (id, type) => document.getElementById(id)?.addEventListener("click", () => send({ type }));
    on("startFromAgent", "startFromAgent");
    on("runSample", "runSample");
    on("importTour", "importTour");
    on("next", "next");
    on("back", "back");
    on("revealCurrent", "revealCurrent");
    on("deeper", "deeper");
    on("stop", "stop");
    on("exportTour", "exportTour");
    on("dismissBridge", "dismissBridge");
    document.getElementById("openTtsSettings")?.addEventListener("click", (e) => {
      e.preventDefault();
      send({ type: "openTtsSettings" });
    });
    document.querySelectorAll(".stop").forEach((el) => {
      el.addEventListener("click", () => {
        const i = parseInt(el.getAttribute("data-index"), 10);
        if (!Number.isNaN(i)) send({ type: "showStep", index: i });
      });
    });
    const routePanel = document.getElementById("routePanel");
    if (routePanel) {
      const state = readState();
      if (state.routeCollapsed) routePanel.removeAttribute("open");
      routePanel.addEventListener("toggle", () => {
        writeState({ routeCollapsed: !routePanel.open });
      });
    }
    const q = document.getElementById("q");
    q?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && q.value.trim()) {
        send({ type: "followUp", question: q.value });
        q.value = "";
      }
    });
    document.querySelectorAll("button.resume").forEach((b) => {
      b.addEventListener("click", () => send({ type: "resumeTour", id: b.getAttribute("data-id") }));
    });
    document.querySelectorAll("button.repo-resume").forEach((b) => {
      b.addEventListener("click", () => send({ type: "resumeRepoTour", file: b.getAttribute("data-file") }));
    });
    document.querySelectorAll("button.del").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-id");
        if (id && confirm("Delete this saved tour?")) {
          send({ type: "deleteTour", id });
        }
      });
    });
    // ---- TTS playback surface ----------------------------------------------
    // The host picks the provider; this page plays what it receives and owns the
    // Play/Pause button:
    //   tts.speak engine=system  -> SpeechSynthesis (native OS voices)
    //   tts.speak engine=kokoro  -> local Kokoro-82M neural voice (WASM)
    //   tts.audio                -> MP3 bytes from a hosted provider (ElevenLabs/OpenAI)
    // speakToken invalidates stale audio when a new request or cancel arrives, so
    // we never play an old utterance over a newer step. Pause/resume act on the
    // live SpeechSynthesis queue or <audio> element without a host round-trip.
    const btn = document.getElementById("playPause");
    const playBtn = document.getElementById("playTour");
    let audioEl = null;
    let speakToken = 0;
    let mode = null;     // 'synth' | 'audio'
    let state = "idle";  // idle | preparing | playing | paused
    let playMode = false; // continuous "play the tour" auto-advance

    function setState(s) {
      state = s;
      if (!btn) return;
      btn.textContent =
        s === "preparing" ? "⏳ Loading voice…" :
        s === "playing" ? "⏸️ Pause" :
        s === "paused" ? "▶️ Resume" : "🔊 Speak";
    }

    function stopAll() {
      speakToken++;
      try { window.speechSynthesis?.cancel(); } catch (e) {}
      if (audioEl) { try { audioEl.pause(); } catch (e) {} audioEl = null; }
      mode = null;
    }

    btn?.addEventListener("click", () => {
      if (state === "idle") {
        setState("preparing");
        send({ type: "speakCurrent" });
      } else if (state === "playing") {
        if (mode === "synth") { try { window.speechSynthesis?.pause(); } catch (e) {} }
        else if (audioEl) { try { audioEl.pause(); } catch (e) {} }
        setState("paused");
      } else if (state === "paused") {
        if (mode === "synth") { try { window.speechSynthesis?.resume(); } catch (e) {} setState("playing"); }
        else if (audioEl) { audioEl.play().then(() => setState("playing")).catch(() => { stopAll(); setState("idle"); }); }
        else setState("idle");
      } else if (state === "preparing") {
        stopAll();
        setState("idle");
        send({ type: "stopTts" });
      }
    });

    function speakSystem(text, token) {
      try {
        window.speechSynthesis?.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.05;
        mode = "synth";
        u.onstart = () => { if (token === speakToken) setState("playing"); };
        u.onend = () => { if (token === speakToken) { setState("idle"); naturalEnd(); } };
        window.speechSynthesis?.speak(u);
      } catch (err) {
        console.error("[code-atlas tts] system speak failed", err);
        if (token === speakToken) setState("idle");
      }
    }

    // Report a webview-side audio failure to the host so it isn't silent — it
    // lands in the Output channel and raises a toast. autoplayBlocked flags the
    // common case (play() rejected because the click gesture expired during the
    // network round-trip) so the host can word the warning helpfully.
    function reportAudioFailure(detail, autoplayBlocked) {
      try { send({ type: "tts.log", message: "audio playback failed: " + detail, audioFailed: true, autoplayBlocked: !!autoplayBlocked }); } catch (e) {}
    }

    function playBytes(mime, b64, token) {
      try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        playBlob(new Blob([bytes], { type: mime || "audio/mpeg" }), token)
          .then(() => { if (token === speakToken) { setState("idle"); naturalEnd(); } });
      } catch (err) {
        console.error("[code-atlas tts] audio decode failed", err);
        reportAudioFailure("decode failed: " + ((err && err.message) || err), false);
        if (token === speakToken) setState("idle");
      }
    }

    // Plays a Blob; resolves when it finishes (or is superseded). Flips the
    // button to 'playing' only once sound actually starts, so the label reflects
    // reality rather than intent.
    function playBlob(blob, token) {
      return new Promise((resolve) => {
        if (token !== speakToken) { resolve(); return; }
        const url = URL.createObjectURL(blob);
        if (audioEl) { try { audioEl.pause(); } catch (e) {} }
        audioEl = new Audio(url);
        mode = "audio";
        let started = false;
        const done = () => { try { URL.revokeObjectURL(url); } catch (e) {} resolve(); };
        audioEl.onplaying = () => { started = true; if (token === speakToken) setState("playing"); };
        audioEl.onended = done;
        audioEl.onerror = () => {
          const e = audioEl && audioEl.error;
          reportAudioFailure("media error" + (e && e.code ? " code " + e.code : ""), false);
          done();
        };
        audioEl.play()
          .then(() => { if (token === speakToken) setState("playing"); })
          .catch((e) => {
            const blocked = e && (e.name === "NotAllowedError" || /gesture|user activation/i.test(e.message || ""));
            console.error("[code-atlas tts] play failed", e);
            if (!started) reportAudioFailure((e && e.name ? e.name + ": " : "") + ((e && e.message) || e), blocked);
            done();
          });
      });
    }

    // Kokoro runs in a Web Worker — the WASM inference is CPU-heavy and would
    // freeze the renderer if run on the main thread (it did). The worker lazily
    // imports kokoro-js, caches the model, and returns WAV bytes per sentence.
    // A crash, CSP block, or stall rejects the request so we degrade to the
    // system voice instead of hanging.
    let kokoroWorker = null;
    let kokoroReqId = 0;
    const kokoroPending = new Map();

    function getKokoroWorker() {
      if (kokoroWorker) return kokoroWorker;
      const workerSrc = [
        'import { KokoroTTS } from "https://esm.sh/kokoro-js@1";',
        'let modelP = null;',
        'self.onmessage = async (e) => {',
        '  const m = e.data;',
        '  if (!m || m.type !== "generate") return;',
        '  try {',
        '    if (!modelP) modelP = KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "wasm" });',
        '    const tts = await modelP;',
        '    const audio = await tts.generate(m.text, { voice: m.voice || "af_heart" });',
        '    const wav = audio.toWav();',
        '    self.postMessage({ type: "audio", id: m.id, wav: wav }, [wav]);',
        '  } catch (err) {',
        '    self.postMessage({ type: "error", id: m.id, message: String((err && err.message) || err) });',
        '  }',
        '};',
      ].join("\\n");
      const url = URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" }));
      kokoroWorker = new Worker(url, { type: "module" });
      kokoroWorker.onmessage = (e) => {
        const m = e.data; if (!m) return;
        const p = kokoroPending.get(m.id); if (!p) return;
        kokoroPending.delete(m.id);
        if (m.type === "audio") p.resolve(m.wav); else p.reject(new Error(m.message || "kokoro error"));
      };
      kokoroWorker.onerror = (err) => {
        const detail = (err && (err.message || err.filename)) || "unknown worker error";
        console.error("[code-atlas tts] kokoro worker crashed", err);
        send({ type: "tts.log", message: "kokoro worker crashed: " + detail });
        for (const p of kokoroPending.values()) p.reject(new Error("kokoro worker error"));
        kokoroPending.clear();
        try { kokoroWorker.terminate(); } catch (e) {}
        kokoroWorker = null;
      };
      return kokoroWorker;
    }

    function kokoroGenerate(text, voice) {
      return new Promise((resolve, reject) => {
        const id = ++kokoroReqId;
        const w = getKokoroWorker();
        // Generous timeout — the first call also downloads the ~80MB model.
        const timer = setTimeout(() => {
          if (kokoroPending.has(id)) { kokoroPending.delete(id); reject(new Error("kokoro timed out")); }
        }, 90000);
        kokoroPending.set(id, {
          resolve: (wav) => { clearTimeout(timer); resolve(wav); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        w.postMessage({ type: "generate", id: id, text: text, voice: voice });
      });
    }

    function splitSentences(text) {
      const parts = text.match(/[^.!?]+[.!?]*\\s*/g);
      return (parts ? parts.map((s) => s.trim()).filter(Boolean) : [text]);
    }

    async function speakKokoro(text, voice, token) {
      const chunks = splitSentences(text);
      for (let i = 0; i < chunks.length; i++) {
        if (token !== speakToken) return;
        let wav;
        try {
          wav = await kokoroGenerate(chunks[i], voice);
        } catch (e) {
          const detail = (e && (e.message || String(e))) || "unknown error";
          console.error("[code-atlas tts] kokoro unavailable, using system voice", e);
          send({ type: "tts.log", message: "kokoro generate failed: " + detail, kokoroFellBack: true });
          if (token === speakToken) speakSystem(chunks.slice(i).join(" "), token);
          return;
        }
        if (token !== speakToken) return;
        await playBlob(new Blob([wav], { type: "audio/wav" }), token);
      }
      if (token === speakToken) { setState("idle"); naturalEnd(); }
    }

    // ---- Continuous "Play the tour" mode -----------------------------------
    // Narration already auto-plays on each step change (the host speaks the new
    // step). Play mode adds auto-advance: when a stop finishes reading, move to
    // the next one. The flag is persisted so it survives the webview reload that
    // every navigation triggers, keeping the chain going across stops.
    function updatePlayBtn() {
      if (!playBtn) return;
      playBtn.textContent = playMode ? "⏹ Stop play" : "▶ Play";
    }
    function setPlayMode(on) {
      playMode = on;
      writeState({ playMode: on });
      updatePlayBtn();
    }
    function naturalEnd() {
      if (!playMode) return;
      if (IS_LAST) { setPlayMode(false); return; }
      send({ type: "next" }); // host advances + auto-speaks the next stop
    }
    playBtn?.addEventListener("click", () => {
      if (!playMode) {
        setPlayMode(true);
        if (state === "idle") send({ type: "speakCurrent" }); // kick off if not already reading
      } else {
        setPlayMode(false);
        stopAll();
        setState("idle");
        send({ type: "stopTts" });
      }
    });
    // Restore play flag across the reload; clear it once the tour ends.
    (function initPlay() {
      if (!HAS_TOUR) { if (readState().playMode) writeState({ playMode: false }); playMode = false; }
      else { playMode = !!readState().playMode; }
      updatePlayBtn();
    })();

    window.addEventListener("message", (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === "tts.speak" && typeof m.text === "string") {
        stopAll();
        const token = speakToken;
        setState("preparing");
        if (m.engine === "kokoro") speakKokoro(m.text, m.voice, token);
        else speakSystem(m.text, token);
      } else if (m.type === "tts.audio" && typeof m.dataBase64 === "string") {
        stopAll();
        const token = speakToken;
        setState("preparing");
        playBytes(m.mime, m.dataBase64, token);
      } else if (m.type === "tts.cancel") {
        stopAll();
        setState("idle");
        if (playMode) setPlayMode(false);
      } else if (m.type === "tts.togglePlay") {
        playBtn?.click();
      }
    });
  </script>
</body>
</html>`;
  }
}
