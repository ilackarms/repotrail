import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { SlideHostMessage, SlideViewPayload, SlideWebviewMessage } from "../engine/slides/payload";

export interface SlidePanelHandlers {
  next(): void;
  back(): void;
  nextStop(): void;
  openSource(): void;
  exitPresent(): void;
  toggleAutoplay(): void;
  openRef(ref: unknown, slideIndex: number): void;
}

/**
 * The RepoTrail Slides panel: one webview in the editor area that shows the
 * current slide stop. Created on the first slide, revealed on later ones, and
 * disposed when the tour stops. Only editorActions drives it.
 */
export class SlidePanel {
  private static readonly viewType = "repoTrail.slides";
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private pending: SlideHostMessage | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly handlers: SlidePanelHandlers,
    private readonly log: vscode.OutputChannel,
  ) {}

  /** Show a slide in `column`, creating the panel if needed. Returns where it is. */
  show(payload: SlideViewPayload, column: vscode.ViewColumn): vscode.ViewColumn | undefined {
    const title = payload.title.length > 48 ? `${payload.title.slice(0, 47)}…` : payload.title;
    if (!this.panel) {
      this.panel = this.create(column, title);
    } else {
      this.panel.title = title;
      if (!this.panel.visible || this.panel.viewColumn !== column) this.panel.reveal(column, false);
    }
    const fresh = this.pending?.payload.index !== payload.index || this.pending.payload.slide !== payload.slide;
    this.post({ type: "slide", payload });
    if (fresh) {
      for (const warning of payload.slide.warnings ?? []) {
        this.log.appendLine(`[slides] stop ${payload.index + 1} "${payload.title}": ${warning}`);
      }
    }
    return this.panel.viewColumn;
  }

  close(): void {
    this.panel?.dispose();
  }

  private create(column: vscode.ViewColumn, title: string): vscode.WebviewPanel {
    const outDir = vscode.Uri.joinPath(this.extensionUri, "out");
    const panel = vscode.window.createWebviewPanel(
      SlidePanel.viewType,
      title,
      { viewColumn: column, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [outDir] },
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "activity-icon.svg");
    panel.webview.html = this.html(panel.webview, outDir);
    panel.webview.onDidReceiveMessage((message: SlideWebviewMessage) => {
      switch (message?.type) {
        case "ready":
          this.ready = true;
          if (this.pending) void panel.webview.postMessage(this.pending);
          break;
        case "next":
          this.handlers.next();
          break;
        case "back":
          this.handlers.back();
          break;
        case "nextStop":
          this.handlers.nextStop();
          break;
        case "exitPresent":
          this.handlers.exitPresent();
          break;
        case "toggleAutoplay":
          this.handlers.toggleAutoplay();
          break;
        case "openRef":
          if (this.pending) this.handlers.openRef(message.ref, this.pending.payload.index);
          break;
        case "openSource":
          this.handlers.openSource();
          break;
      }
    });
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
        this.ready = false;
        this.pending = undefined;
      }
    });
    return panel;
  }

  private post(message: SlideHostMessage): void {
    this.pending = message;
    if (this.panel && this.ready) void this.panel.webview.postMessage(message);
  }

  private html(webview: vscode.Webview, outDir: vscode.Uri): string {
    const nonce = randomBytes(16).toString("hex");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(outDir, "slides.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(outDir, "slides.css"));
    // No network, no inline script, and no agent-supplied markup: the runtime
    // builds the slide from data posted by the extension.
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join("; ");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style}">
<title>RepoTrail Slides</title>
</head>
<body class="rt-panel">
<div id="stage" tabindex="-1"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
