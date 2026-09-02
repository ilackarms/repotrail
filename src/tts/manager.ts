import * as childProcess from "node:child_process";
import * as vscode from "vscode";
import { TourController } from "../ux/tourController";
import { narrationTargetKey } from "./playbackPolicy";
import { humanizeForSpeech } from "./speechText";

export type TtsProvider = "off" | "kokoro" | "system" | "say" | "elevenlabs" | "openai";

const ALL_PROVIDERS: TtsProvider[] = ["off", "kokoro", "system", "say", "elevenlabs", "openai"];

/** Message shapes posted to the webview audio surface. */
export type TtsWebviewMsg =
  | { type: "tts.speak"; engine: "system" | "kokoro"; text: string; voice?: string }
  | { type: "tts.audio"; mime: string; dataBase64: string }
  | { type: "tts.cancel" };

/**
 * Coordinates text-to-speech for tour narration across several backends, chosen
 * by the `repoTrail.tts.provider` setting:
 *
 * - "off": no audio.
 * - "kokoro": local Kokoro-82M neural voice. Runs entirely in the sidebar
 *   webview via WASM (downloads the model on first use, then offline). Free,
 *   natural — the default.
 * - "system": webview SpeechSynthesis using native OS voices. Free, robotic.
 * - "say": spawn macOS `say` (override via repoTrail.tts.command on Linux).
 * - "elevenlabs" / "openai": hosted neural voices. Audio is fetched here in the
 *   extension host (keeping the API key out of the webview) and the bytes are
 *   posted to the webview for playback.
 *
 * Narration text is run through humanizeForSpeech() first so identifiers, paths,
 * and operators are spoken naturally regardless of backend.
 *
 * Subscribes to controller.onDidChange only to cancel stale work when the
 * current narration target changes or the tour ends. Speech starts from
 * speakCurrent().
 */
export class TtsManager implements vscode.Disposable {
  private subscription: vscode.Disposable | null = null;
  private currentChild: childProcess.ChildProcess | null = null;
  private webviewSink: ((msg: TtsWebviewMsg) => void) | null = null;
  private observedTargetKey: string | null = null;
  private fetchAbort: AbortController | null = null;
  private requestSeq = 0;
  private warnedMissing = new Set<string>();
  private lastHostedWarn = 0;

  constructor(
    private readonly controller: TourController,
    private readonly log: vscode.OutputChannel,
  ) {
    this.subscription = controller.onDidChange(() => this.onChange());
  }

  setWebviewSink(sink: ((msg: TtsWebviewMsg) => void) | null): void {
    this.webviewSink = sink;
  }

  /** Speak the active step now (used by the toggle button). */
  speakCurrent(): void {
    const snap = this.controller.snapshot();
    if (!snap.current) return;
    this.observedTargetKey = narrationTargetKey(this.controller.activeTourId, snap.current);
    this.dispatch(humanizeForSpeech(`${snap.current.title}. ${snap.current.explanation}`));
  }

  /** Full stop: halt host-side work AND tell the webview to stop narration + reset
   *  the Speak button to idle. Use for explicit stop / provider-off. */
  cancel(): void {
    this.cancelHostWork();
    this.webviewSink?.({ type: "tts.cancel" });
  }

  /** Halt only host-side work (say child, hosted fetch) and invalidate in-flight
   *  responses. Does NOT post tts.cancel — so it won't flash the webview button
   *  to idle when we're about to immediately send a new tts.speak. The webview's
   *  own stopAll() (run on tts.speak/tts.audio) stops any prior playback. */
  private cancelHostWork(): void {
    if (this.currentChild && !this.currentChild.killed) {
      this.currentChild.kill();
    }
    this.currentChild = null;
    if (this.fetchAbort) {
      this.fetchAbort.abort();
      this.fetchAbort = null;
    }
    this.requestSeq++;
  }

  dispose(): void {
    this.cancel();
    this.subscription?.dispose();
    this.subscription = null;
  }

  private onChange(): void {
    const provider = currentProvider();
    const snap = this.controller.snapshot();
    const targetKey = narrationTargetKey(this.controller.activeTourId, snap.current);
    if (provider === "off" || !snap.current) {
      this.cancel();
      this.observedTargetKey = targetKey;
      return;
    }
    if (targetKey !== this.observedTargetKey) {
      this.cancel();
      this.observedTargetKey = targetKey;
    }
  }

  private dispatch(text: string): void {
    const provider = currentProvider();
    this.cancelHostWork();
    if (provider === "off" || !text.trim()) {
      // Nothing will be spoken — make sure the webview button doesn't sit on a
      // stale "preparing" state from the click.
      this.webviewSink?.({ type: "tts.cancel" });
      return;
    }
    const cfg = vscode.workspace.getConfiguration("repoTrail");
    switch (provider) {
      case "system":
        this.sendToWebview({ type: "tts.speak", engine: "system", text });
        return;
      case "kokoro":
        this.sendToWebview({
          type: "tts.speak",
          engine: "kokoro",
          text,
          voice: cfg.get<string>("tts.kokoroVoice", "af_heart"),
        });
        return;
      case "say":
        this.speakViaCommand(text, cfg);
        return;
      case "elevenlabs":
        void this.speakViaElevenLabs(text, cfg);
        return;
      case "openai":
        void this.speakViaOpenAi(text, cfg);
        return;
    }
  }

  private sendToWebview(msg: TtsWebviewMsg): void {
    if (this.webviewSink) {
      this.webviewSink(msg);
    } else {
      this.log.appendLine("[tts] webview sink unavailable — open the RepoTrail sidebar to hear narration.");
    }
  }

  private speakViaCommand(text: string, cfg: vscode.WorkspaceConfiguration): void {
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

  private async speakViaElevenLabs(text: string, cfg: vscode.WorkspaceConfiguration): Promise<void> {
    const key = (cfg.get<string>("tts.elevenLabsApiKey", "") || process.env.ELEVENLABS_API_KEY || "").trim();
    if (!key) {
      this.warnMissingKey("ElevenLabs", "repoTrail.tts.elevenLabsApiKey");
      return;
    }
    const voiceId = cfg.get<string>("tts.elevenLabsVoiceId", "21m00Tcm4TlvDq8ikWAM");
    const model = cfg.get<string>("tts.elevenLabsModel", "eleven_flash_v2_5");
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
    await this.fetchAndPlay(
      url,
      {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: model }),
      },
      "audio/mpeg",
      "ElevenLabs",
      "repoTrail.tts.elevenLabsApiKey",
    );
  }

  private async speakViaOpenAi(text: string, cfg: vscode.WorkspaceConfiguration): Promise<void> {
    const key = (cfg.get<string>("tts.openAiApiKey", "") || process.env.OPENAI_API_KEY || "").trim();
    if (!key) {
      this.warnMissingKey("OpenAI", "repoTrail.tts.openAiApiKey");
      return;
    }
    const model = cfg.get<string>("tts.openAiModel", "gpt-4o-mini-tts");
    const voice = cfg.get<string>("tts.openAiVoice", "ash");
    const instructions = cfg.get<string>("tts.openAiInstructions", "").trim();
    // Only gpt-4o-mini-tts accepts `instructions`; sending it to tts-1/tts-1-hd
    // is a 400.
    const steerable = model.startsWith("gpt-4o");
    await this.fetchAndPlay(
      "https://api.openai.com/v1/audio/speech",
      {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          voice,
          input: text,
          response_format: "mp3",
          ...(steerable && instructions ? { instructions } : {}),
        }),
      },
      "audio/mpeg",
      "OpenAI",
      "repoTrail.tts.openAiApiKey",
    );
  }

  /**
   * Fetch synthesized audio in the extension host and hand the bytes to the
   * webview to play. Guarded by an AbortController (so cancel() stops the
   * request) and a sequence number (so a response that arrives after the user
   * advanced steps is dropped instead of played over the new step).
   */
  private async fetchAndPlay(
    url: string,
    init: RequestInit,
    mime: string,
    label: string,
    settingId: string,
  ): Promise<void> {
    const seq = ++this.requestSeq;
    const ac = new AbortController();
    this.fetchAbort = ac;
    try {
      const res = await fetch(url, { ...init, signal: ac.signal });
      if (seq !== this.requestSeq) return; // superseded or cancelled — a newer request owns the button
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        this.log.appendLine(`[tts] ${label} HTTP ${res.status}: ${body.slice(0, 500)}`);
        const hint =
          res.status === 401 || res.status === 403
            ? "rejected the API key"
            : res.status === 404
              ? "model not found for this key — try a different repoTrail.tts.*Model"
              : `HTTP ${res.status}`;
        this.failHosted(label, `${hint}. ${summarizeApiError(body)}`.trim(), settingId);
        return;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (seq !== this.requestSeq) return; // superseded or cancelled
      this.sendToWebview({ type: "tts.audio", mime, dataBase64: buf.toString("base64") });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      if (seq !== this.requestSeq) return;
      this.failHosted(label, err instanceof Error ? err.message : String(err), settingId);
    } finally {
      if (this.fetchAbort === ac) this.fetchAbort = null;
    }
  }

  /** A hosted request failed: log it, reset the webview button out of its
   *  "Loading voice…" state, and show an actionable warning. Throttled by time
   *  (not a permanent dedup) so a deliberate Speak click always surfaces the
   *  error, while repeated failures don't spam toasts. */
  private failHosted(label: string, detail: string, settingId: string): void {
    this.log.appendLine(`[tts] ${label} failed: ${detail}`);
    this.webviewSink?.({ type: "tts.cancel" });
    const now = Date.now();
    if (now - this.lastHostedWarn < 8000) return;
    this.lastHostedWarn = now;
    void vscode.window
      .showWarningMessage(`RepoTrail: ${label} TTS failed — ${detail}`, "Open Settings", "Show Log")
      .then((choice) => {
        if (choice === "Open Settings") {
          void vscode.commands.executeCommand("workbench.action.openSettings", settingId);
        } else if (choice === "Show Log") {
          this.log.show(true);
        }
      });
  }

  private warnMissingKey(label: string, settingId: string, reason = "needs an API key"): void {
    this.log.appendLine(`[tts] ${label} ${reason} (${settingId}).`);
    if (this.warnedMissing.has(settingId)) return;
    this.warnedMissing.add(settingId);
    void vscode.window
      .showWarningMessage(`RepoTrail: ${label} TTS ${reason}.`, "Open Settings")
      .then((choice) => {
        if (choice === "Open Settings") {
          void vscode.commands.executeCommand("workbench.action.openSettings", settingId);
        }
      });
  }
}

/** Pull the human-readable message out of an OpenAI/ElevenLabs JSON error body. */
function summarizeApiError(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; detail?: { message?: string } | string };
    const e = j.error ?? j.detail;
    if (typeof e === "string") return e;
    if (e && typeof e.message === "string") return e.message;
  } catch {
    /* not JSON */
  }
  return "";
}

export function currentProvider(): TtsProvider {
  const raw = vscode.workspace.getConfiguration("repoTrail").get<string>("tts.provider", "system");
  return (ALL_PROVIDERS as string[]).includes(raw) ? (raw as TtsProvider) : "system";
}

/**
 * Providers the cycle command should rotate through: the local engines are
 * always available; the hosted ones only appear once their API key is set
 * (config or env) so cycling can't land on a silent, key-less provider.
 */
export function availableProviders(): TtsProvider[] {
  const cfg = vscode.workspace.getConfiguration("repoTrail");
  const list: TtsProvider[] = ["off", "kokoro", "system", "say"];
  if ((cfg.get<string>("tts.elevenLabsApiKey", "") || process.env.ELEVENLABS_API_KEY || "").trim()) {
    list.push("elevenlabs");
  }
  if ((cfg.get<string>("tts.openAiApiKey", "") || process.env.OPENAI_API_KEY || "").trim()) {
    list.push("openai");
  }
  return list;
}
