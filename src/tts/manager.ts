import * as childProcess from "node:child_process";
import * as vscode from "vscode";
import { TourController } from "../ux/tourController";

export type TtsMode = "off" | "webview" | "say";

/**
 * Coordinates text-to-speech for tour narration.
 *
 * - "off": no audio.
 * - "webview": send the cleaned narration to the sidebar webview which calls
 *   `speechSynthesis.speak`. Uses native OS voices, multi-platform, no shell.
 *   Stops if the webview isn't alive — `retainContextWhenHidden` keeps it
 *   warm while collapsed.
 * - "say": spawn macOS `say` (override with codeAtlas.tts.command on Linux,
 *   e.g. `espeak`, `spd-say`). Kills the prior child when a new step arrives.
 *
 * Subscribes to controller.onDidChange and speaks the active step on every
 * change. Stale subscriptions are cleaned up via dispose().
 */
export class TtsManager implements vscode.Disposable {
  private subscription: vscode.Disposable | null = null;
  private currentChild: childProcess.ChildProcess | null = null;
  private webviewSink: ((msg: { type: string; text?: string }) => void) | null = null;
  private lastSpokenIndex = -1;

  constructor(
    private readonly controller: TourController,
    private readonly log: vscode.OutputChannel,
  ) {
    this.subscription = controller.onDidChange(() => this.onChange());
  }

  setWebviewSink(sink: ((msg: { type: string; text?: string }) => void) | null): void {
    this.webviewSink = sink;
  }

  /** Speak the active step now (used by the toggle button). */
  speakCurrent(): void {
    const snap = this.controller.snapshot();
    if (!snap.current) return;
    const text = stripMarkdown(`${snap.current.title}. ${snap.current.explanation}`);
    this.dispatch(text);
  }

  cancel(): void {
    if (this.currentChild && !this.currentChild.killed) {
      this.currentChild.kill();
    }
    this.currentChild = null;
    this.webviewSink?.({ type: "tts.cancel" });
  }

  dispose(): void {
    this.cancel();
    this.subscription?.dispose();
    this.subscription = null;
  }

  private onChange(): void {
    const mode = currentMode();
    if (mode === "off") {
      this.cancel();
      this.lastSpokenIndex = -1;
      return;
    }
    const snap = this.controller.snapshot();
    if (!snap.current) {
      this.cancel();
      this.lastSpokenIndex = -1;
      return;
    }
    // Avoid re-speaking on no-op redraws (back/next-without-change).
    if (snap.index === this.lastSpokenIndex) return;
    this.lastSpokenIndex = snap.index;

    const text = stripMarkdown(`${snap.current.title}. ${snap.current.explanation}`);
    this.dispatch(text);
  }

  private dispatch(text: string): void {
    const mode = currentMode();
    this.cancel();
    if (mode === "webview") {
      if (this.webviewSink) {
        this.webviewSink({ type: "tts.speak", text });
      } else {
        this.log.appendLine("[tts] webview sink unavailable (sidebar not open?)");
      }
      return;
    }
    if (mode === "say") {
      const cfg = vscode.workspace.getConfiguration("codeAtlas");
      const cmd = cfg.get<string>("tts.command", "say");
      try {
        const child = childProcess.spawn(cmd, [text], { stdio: "ignore", detached: false });
        child.on("error", (err) =>
          this.log.appendLine(`[tts] ${cmd} failed: ${err instanceof Error ? err.message : String(err)}`),
        );
        this.currentChild = child;
      } catch (err) {
        this.log.appendLine(`[tts] spawn ${cmd} threw: ${String(err)}`);
      }
    }
  }
}

function currentMode(): TtsMode {
  const raw = vscode.workspace.getConfiguration("codeAtlas").get<string>("tts.mode", "off");
  if (raw === "webview" || raw === "say") return raw;
  return "off";
}

/**
 * Strip markdown so TTS doesn't read "asterisk asterisk bold asterisk asterisk".
 * Best-effort — drops code fences, backticks, links/images keep the label,
 * heading markers, emphasis, list markers, blockquote markers.
 */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
