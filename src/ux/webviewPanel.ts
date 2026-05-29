import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
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

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: TourController,
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
        case "speakCurrent":
          await vscode.commands.executeCommand("codeAtlas.speakCurrent");
          break;
        case "stopTts":
          await vscode.commands.executeCommand("codeAtlas.stopTts");
          break;
        case "openTtsSettings":
          await vscode.commands.executeCommand("workbench.action.openSettings", "codeAtlas.tts.provider");
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
    const provider = vscode.workspace.getConfiguration("codeAtlas").get<string>("tts.provider", "system");
    const tours = snap.plan ? [] : await this.loadTours();
    this.view.webview.html = this.html(snap, provider, tours);
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
    ttsProvider: string,
    tours: TourSummary[],
  ): string {
    const { plan, index, current } = snap;
    const total = plan?.steps.length ?? 0;
    const title = current?.title ?? "No active tour";
    const explanation = current?.explanation ?? "Run **Code Atlas: Start Tour** to begin.";
    const fileLabel = current?.file ?? "";

    const escape = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const nonce = randomBytes(16).toString("hex");

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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval' https://esm.sh https://cdn.jsdelivr.net; style-src 'unsafe-inline'; connect-src https: data: blob:; media-src blob: data:; img-src https: data:; font-src https: data:; worker-src blob:; child-src blob:;" />
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
      <button id="playPause" class="secondary" ${ttsProvider === "off" ? "disabled" : ""}>🔊 Speak</button>
    ` : `<button id="start">Start tour</button>`}
  </div>
  ${plan ? `<div class="meta">Voice: ${escape(ttsProvider)} · change in <a href="#" id="openTtsSettings">settings</a></div>` : ""}
  ${plan ? `
    <input id="q" placeholder="Follow-up question — Enter to copy as prompt" />
    <div class="meta" style="margin-top:6px">Deepen + follow-up copy a prompt to your clipboard. Paste it into your Claude Code session; the agent will mutate the tour.</div>
  ` : tourList}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const send = (msg) => vscode.postMessage(msg);
    document.getElementById("start")?.addEventListener("click", () => send({ type: "start" }));
    document.getElementById("next")?.addEventListener("click", () => send({ type: "next" }));
    document.getElementById("back")?.addEventListener("click", () => send({ type: "back" }));
    document.getElementById("deeper")?.addEventListener("click", () => send({ type: "deeper" }));
    document.getElementById("stop")?.addEventListener("click", () => send({ type: "stop" }));
    document.getElementById("openTtsSettings")?.addEventListener("click", (e) => {
      e.preventDefault();
      send({ type: "openTtsSettings" });
    });
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
    let audioEl = null;
    let speakToken = 0;
    let mode = null;     // 'synth' | 'audio'
    let state = "idle";  // idle | preparing | playing | paused

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
        u.onend = () => { if (token === speakToken) setState("idle"); };
        window.speechSynthesis?.speak(u);
      } catch (err) {
        console.error("[code-atlas tts] system speak failed", err);
        if (token === speakToken) setState("idle");
      }
    }

    function playBytes(mime, b64, token) {
      try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        playBlob(new Blob([bytes], { type: mime || "audio/mpeg" }), token)
          .then(() => { if (token === speakToken) setState("idle"); });
      } catch (err) {
        console.error("[code-atlas tts] audio decode failed", err);
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
        const done = () => { try { URL.revokeObjectURL(url); } catch (e) {} resolve(); };
        audioEl.onended = done;
        audioEl.onerror = done;
        audioEl.play()
          .then(() => { if (token === speakToken) setState("playing"); })
          .catch((e) => { console.error("[code-atlas tts] play failed", e); done(); });
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
        console.error("[code-atlas tts] kokoro worker crashed", err);
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
          console.error("[code-atlas tts] kokoro unavailable, using system voice", e);
          if (token === speakToken) speakSystem(chunks.slice(i).join(" "), token);
          return;
        }
        if (token !== speakToken) return;
        await playBlob(new Blob([wav], { type: "audio/wav" }), token);
      }
      if (token === speakToken) setState("idle");
    }

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
      }
    });
  </script>
</body>
</html>`;
  }
}
