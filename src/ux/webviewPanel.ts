import * as vscode from "vscode";
import { TourController } from "./tourController";

/**
 * Narration WebviewViewProvider. Renders the current step's title +
 * explanation and exposes next/back/deeper/follow-up controls.
 *
 * The webview posts messages back to the extension host; the controller
 * handles state changes and we re-render on `onDidChange`.
 */
export class TourViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "codeAtlas.tour";

  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: TourController,
  ) {
    controller.onDidChange(() => this.render());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
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
          await this.controller.deeper();
          break;
        case "followUp":
          if (typeof msg.question === "string" && msg.question.trim()) {
            const answer = await this.controller.followUp(msg.question);
            view.webview.postMessage({ type: "followUpAnswer", answer });
          }
          break;
        case "stop":
          this.controller.stop();
          break;
      }
    });
    this.render();
  }

  private render(): void {
    if (!this.view) return;
    const snap = this.controller.snapshot();
    this.view.webview.html = this.html(snap);
  }

  private html(snap: ReturnType<TourController["snapshot"]>): string {
    const { plan, index, current } = snap;
    const total = plan?.steps.length ?? 0;
    const title = current?.title ?? "No active tour";
    const explanation = current?.explanation ?? "Run **Code Atlas: Start Tour** to begin.";
    const fileLabel = current?.file ?? "";

    const escape = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 10px; cursor: pointer; border-radius: 2px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  input { width: 100%; box-sizing: border-box; padding: 4px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
  .answer { margin-top: 8px; padding: 8px; background: var(--vscode-textCodeBlock-background); border-radius: 2px; white-space: pre-wrap; }
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
      <button id="deeper">Go deeper</button>
      <button id="stop">Stop</button>
    ` : `<button id="start">Start tour</button>`}
  </div>
  ${plan ? `
    <input id="q" placeholder="Ask a follow-up about this step…" />
    <div id="answer" class="answer" style="display:none"></div>
  ` : ""}
  <script>
    const vscode = acquireVsCodeApi();
    const send = (msg) => vscode.postMessage(msg);
    document.getElementById("start")?.addEventListener("click", () => send({ type: "start" }));
    document.getElementById("next")?.addEventListener("click", () => send({ type: "next" }));
    document.getElementById("back")?.addEventListener("click", () => send({ type: "back" }));
    document.getElementById("deeper")?.addEventListener("click", () => send({ type: "deeper" }));
    document.getElementById("stop")?.addEventListener("click", () => send({ type: "stop" }));
    const q = document.getElementById("q");
    q?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && q.value.trim()) {
        send({ type: "followUp", question: q.value });
        q.value = "";
      }
    });
    window.addEventListener("message", (e) => {
      const m = e.data;
      if (m?.type === "followUpAnswer") {
        const a = document.getElementById("answer");
        if (a) { a.style.display = "block"; a.textContent = m.answer; }
      }
    });
  </script>
</body>
</html>`;
  }
}
