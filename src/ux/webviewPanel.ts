import * as vscode from "vscode";
import { TourSummary } from "../storage/tourStore";
import { TourController } from "./tourController";

type WebviewSink = (msg: { type: string; text?: string }) => void;

/**
 * Narration WebviewViewProvider. Renders the current step's title +
 * explanation and exposes next/back/deeper/follow-up controls.
 *
 * Also hosts a tiny TTS engine in the webview: when the extension host posts
 * `{ type: 'tts.speak', text }` the page calls `speechSynthesis.speak`. Set
 * `retainContextWhenHidden: true` so playback continues if the user collapses
 * the sidebar mid-utterance.
 */
export class TourViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "codeAtlas.tour";

  private view: vscode.WebviewView | undefined;
  private onSinkChange: ((sink: WebviewSink | null) => void) | null = null;
  private tourListLoader: (() => Promise<TourSummary[]>) | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: TourController,
  ) {
    controller.onDidChange(() => void this.render());
  }

  /** Lets the extension supply a function that returns saved tours. */
  setTourListLoader(fn: () => Promise<TourSummary[]>): void {
    this.tourListLoader = fn;
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
        case "next":
          await this.controller.next();
          break;
        case "back":
          await this.controller.back();
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
        case "toggleTts":
          await vscode.commands.executeCommand("codeAtlas.cycleTts");
          break;
        case "speakCurrent":
          await vscode.commands.executeCommand("codeAtlas.speakCurrent");
          break;
        case "resumeTour":
          if (typeof msg.id === "string") {
            await vscode.commands.executeCommand("codeAtlas.resumeTour", msg.id);
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
    const mode = vscode.workspace.getConfiguration("codeAtlas").get<string>("tts.mode", "off");
    const tours = snap.plan ? [] : await this.loadTours();
    this.view.webview.html = this.html(snap, mode, tours);
  }

  private async loadTours(): Promise<TourSummary[]> {
    if (!this.tourListLoader) return [];
    try {
      return await this.tourListLoader();
    } catch {
      return [];
    }
  }

  private html(
    snap: ReturnType<TourController["snapshot"]>,
    ttsMode: string,
    tours: TourSummary[],
  ): string {
    const { plan, index, current } = snap;
    const total = plan?.steps.length ?? 0;
    const title = current?.title ?? "No active tour";
    const explanation = current?.explanation ?? "Run **Code Atlas: Start Tour** to begin.";
    const fileLabel = current?.file ?? "";

    const escape = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const ttsLabel = ttsMode === "off" ? "🔇 TTS off" : `🔊 TTS: ${escape(ttsMode)}`;

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

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; font-size: 13px; }
  h2 { margin: 0 0 4px 0; font-size: 14px; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 12px; }
  .explanation { white-space: pre-wrap; line-height: 1.5; margin-bottom: 16px; }
  .controls { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 10px; cursor: pointer; border-radius: 2px; font-size: 12px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  input { width: 100%; box-sizing: border-box; padding: 4px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
  .answer { margin-top: 8px; padding: 8px; background: var(--vscode-textCodeBlock-background); border-radius: 2px; white-space: pre-wrap; }
  .section-h { margin: 20px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground); }
  .tour-list { list-style: none; margin: 0; padding: 0; }
  .tour-item { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
  .tour-row { flex: 1; min-width: 0; }
  .tour-title { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tour-meta { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 2px; }
  .tour-actions { display: flex; gap: 4px; flex-shrink: 0; }
  .tour-actions button { padding: 3px 8px; font-size: 11px; }
</style>
</head>
<body>
  <h2>${escape(title)}</h2>
  <div class="meta">${plan ? `Step ${index + 1} of ${total} · ${escape(fileLabel)}` : "&nbsp;"}</div>
  <div class="explanation">${escape(explanation)}</div>
  <div class="controls">
    ${plan ? `
      <button id="back" ${index === 0 ? "disabled" : ""}>← Back</button>
      <button id="next" ${index >= total - 1 ? "disabled" : ""}>Next →</button>
      <button id="deeper" title="Copy a 'deepen this step' prompt to clipboard for your Claude Code session">📋 Deepen (copy prompt)</button>
      <button id="stop">Stop</button>
      <button id="speakCurrent" class="secondary">🔊 Speak</button>
    ` : `<button id="start">Start tour</button>`}
    <button id="toggleTts" class="secondary">${ttsLabel}</button>
  </div>
  ${plan ? `
    <input id="q" placeholder="Follow-up question — Enter to copy as prompt" />
    <div class="meta" style="margin-top:6px">Deepen + follow-up copy a prompt to your clipboard. Paste it into your Claude Code session; the agent will mutate the tour.</div>
  ` : tourList}
  <script>
    const vscode = acquireVsCodeApi();
    const send = (msg) => vscode.postMessage(msg);
    document.getElementById("start")?.addEventListener("click", () => send({ type: "start" }));
    document.getElementById("next")?.addEventListener("click", () => send({ type: "next" }));
    document.getElementById("back")?.addEventListener("click", () => send({ type: "back" }));
    document.getElementById("deeper")?.addEventListener("click", () => send({ type: "deeper" }));
    document.getElementById("stop")?.addEventListener("click", () => send({ type: "stop" }));
    document.getElementById("toggleTts")?.addEventListener("click", () => send({ type: "toggleTts" }));
    document.getElementById("speakCurrent")?.addEventListener("click", () => send({ type: "speakCurrent" }));
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
    document.querySelectorAll("button.del").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-id");
        if (id && confirm("Delete this saved tour?")) {
          send({ type: "deleteTour", id });
        }
      });
    });
    window.addEventListener("message", (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === "tts.speak" && typeof m.text === "string") {
        try {
          window.speechSynthesis?.cancel();
          const u = new SpeechSynthesisUtterance(m.text);
          u.rate = 1.05;
          window.speechSynthesis?.speak(u);
        } catch (err) {
          console.error("[code-atlas tts] speak failed", err);
        }
      } else if (m.type === "tts.cancel") {
        try { window.speechSynthesis?.cancel(); } catch {}
      }
    });
  </script>
</body>
</html>`;
  }
}
