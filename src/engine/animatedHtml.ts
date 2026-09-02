import { TourPlan } from "./types";
import {
  BROWSER_TTS_PROVIDERS,
  TTS_DEFAULTS,
  type BrowserTtsProvider,
} from "../tts/config";

export interface AnimatedTourCodeFrame {
  text: string;
  startLine: number;
  highlightStartLine?: number;
  highlightEndLine?: number;
  languageId?: string;
  truncated?: boolean;
}

export interface AnimatedTourDiffRow {
  before?: string;
  after?: string;
  type: "equal" | "delete" | "insert";
}

export interface AnimatedTourDiffFrame {
  beforeLabel: string;
  afterLabel: string;
  beforeText: string;
  afterText: string;
  languageId?: string;
  rows: AnimatedTourDiffRow[];
  truncated?: boolean;
}

export interface AnimatedTourFrame {
  index: number;
  title: string;
  location: string;
  explanation: string;
  viewLabel: string;
  code?: AnimatedTourCodeFrame;
  diff?: AnimatedTourDiffFrame;
  warnings: string[];
}

export interface AnimatedTourHtmlInput {
  plan: TourPlan;
  exportedAt: string;
  frames: AnimatedTourFrame[];
  tts?: AnimatedTourTtsDefaults;
}

export interface AnimatedTourTtsDefaults {
  provider?: BrowserTtsProvider;
  kokoroVoice?: string;
  elevenLabsVoiceId?: string;
  elevenLabsModel?: string;
  openAiModel?: string;
  openAiVoice?: string;
  openAiInstructions?: string;
}

const MAX_DIFF_LINES = 140;

export function buildAnimatedDiffFrame(input: {
  beforeText: string;
  afterText: string;
  beforeLabel?: string;
  afterLabel?: string;
  languageId?: string;
}): AnimatedTourDiffFrame {
  const beforeLines = splitLines(input.beforeText);
  const afterLines = splitLines(input.afterText);
  const truncated = beforeLines.length > MAX_DIFF_LINES || afterLines.length > MAX_DIFF_LINES;
  const before = beforeLines.slice(0, MAX_DIFF_LINES);
  const after = afterLines.slice(0, MAX_DIFF_LINES);
  return {
    beforeLabel: input.beforeLabel ?? "Before",
    afterLabel: input.afterLabel ?? "After",
    beforeText: before.join("\n"),
    afterText: after.join("\n"),
    languageId: input.languageId,
    rows: diffRows(before, after),
    truncated,
  };
}

export function planToAnimatedHtml(input: AnimatedTourHtmlInput): string {
  const data = JSON.stringify({
    title: input.plan.title || "RepoTrail tour",
    kind: input.plan.kind,
    summary: input.plan.summary,
    exportedAt: input.exportedAt,
    frames: input.frames,
    tts: input.tts ?? {},
  }).replace(/</g, "\\u003c");
  const browserTtsDefaults = JSON.stringify({
    provider: TTS_DEFAULTS.provider,
    kokoroVoice: TTS_DEFAULTS.kokoroVoice,
    elevenLabsVoiceId: TTS_DEFAULTS.elevenLabsVoiceId,
    elevenLabsModel: TTS_DEFAULTS.elevenLabsModel,
    openAiModel: TTS_DEFAULTS.openAiModel,
    openAiVoice: TTS_DEFAULTS.openAiVoice,
    openAiInstructions: TTS_DEFAULTS.openAiInstructions,
  });
  const browserTtsProviders = JSON.stringify(BROWSER_TTS_PROVIDERS);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>${escapeHtml(input.plan.title || "RepoTrail tour")}</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #171717;
    --panel: #232323;
    --panel-2: #2d2a25;
    --line: #403d38;
    --text: #f4f0e8;
    --muted: #afa89e;
    --accent: #2fb7a3;
    --accent-2: #f0b84d;
    --danger: #ef7466;
    --code-bg: #101010;
    --code-line: #262626;
    --code-hi: rgba(47, 183, 163, 0.2);
    --delete-bg: rgba(239, 116, 102, 0.16);
    --insert-bg: rgba(47, 183, 163, 0.16);
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    min-height: 100vh;
    background: var(--bg);
    color: var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    letter-spacing: 0;
  }

  button {
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--panel);
    color: var(--text);
    padding: 8px 10px;
    font: inherit;
    cursor: pointer;
  }

  button:hover { border-color: var(--accent); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #071412; font-weight: 700; }
  button.secondary { background: #1d1d1c; }

  .app {
    min-height: 100vh;
    display: grid;
    grid-template-rows: auto 1fr;
  }

  .topbar {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 16px;
    align-items: center;
    padding: 18px 22px 12px;
    border-bottom: 1px solid var(--line);
    background: #1c1b19;
  }

  .eyebrow {
    color: var(--accent-2);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
  }

  h1 {
    margin: 3px 0 6px;
    font-size: 24px;
    line-height: 1.15;
  }

  .summary {
    max-width: 920px;
    color: var(--muted);
    line-height: 1.45;
    white-space: pre-wrap;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .layout {
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(210px, 290px) 1fr;
  }

  .rail {
    border-right: 1px solid var(--line);
    background: #1d1d1c;
    min-height: 0;
    overflow: auto;
    padding: 12px;
  }

  .rail-meta {
    color: var(--muted);
    font-size: 12px;
    margin: 0 0 10px;
  }

  .stop-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }

  .stop-button {
    width: 100%;
    display: grid;
    grid-template-columns: 30px 1fr;
    gap: 8px;
    text-align: left;
    background: transparent;
  }

  .stop-button.active {
    background: var(--panel-2);
    border-color: var(--accent);
  }

  .stop-num {
    color: var(--accent-2);
    font-variant-numeric: tabular-nums;
  }

  .stop-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stop-loc {
    grid-column: 2;
    min-width: 0;
    color: var(--muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stage {
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-rows: auto 1fr;
  }

  .progress {
    height: 4px;
    background: #2a2927;
    overflow: hidden;
  }

  .progress-fill {
    width: 0;
    height: 100%;
    background: var(--accent);
    transition: width 260ms ease;
  }

  .frame {
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1.45fr) minmax(280px, 0.75fr);
    gap: 18px;
    padding: 18px;
  }

  .frame.is-entering {
    animation: enter 240ms ease both;
  }

  @keyframes enter {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .code-surface,
  .story {
    min-width: 0;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel);
    overflow: hidden;
  }

  .surface-head,
  .story-head {
    min-height: 42px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
  }

  .surface-title,
  .story-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 700;
  }

  .pill {
    flex: 0 0 auto;
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 3px 8px;
    color: var(--accent-2);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
  }

  .code-body {
    background: var(--code-bg);
    overflow: auto;
    max-height: calc(100vh - 190px);
  }

  .code-line,
  .diff-row {
    display: grid;
    grid-template-columns: 58px minmax(0, 1fr);
    min-height: 22px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.03);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    font-size: 12px;
    line-height: 1.45;
  }

  .line-no {
    padding: 2px 10px;
    color: #7c776f;
    text-align: right;
    user-select: none;
    background: #151515;
  }

  .line-code {
    padding: 2px 12px;
    white-space: pre;
  }

  .code-line.highlight .line-code {
    background: var(--code-hi);
    box-shadow: inset 3px 0 0 var(--accent);
  }

  .diff {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    min-height: 0;
    min-width: 0;
    overflow: auto;
  }

  .diff-head,
  .diff-row-pair {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    min-width: 0;
  }

  .diff-head {
    position: sticky;
    top: 0;
    z-index: 1;
    background: #151515;
    border-bottom: 1px solid var(--line);
  }

  .diff-label {
    min-width: 0;
    padding: 8px 12px;
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
    overflow-wrap: anywhere;
  }

  .diff-label:first-child,
  .diff-cell:first-child {
    border-right: 1px solid var(--line);
  }

  .diff-cell {
    min-width: 0;
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr);
    border-bottom: 1px solid rgba(255, 255, 255, 0.03);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    font-size: 12px;
    line-height: 1.45;
    tab-size: 2;
  }

  .diff-mark {
    padding: 2px 8px;
    color: #8f887d;
    text-align: center;
    user-select: none;
    background: #151515;
  }

  .diff-code {
    padding: 2px 10px;
    min-width: 0;
    min-height: 22px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .diff-cell.delete .diff-code { background: var(--delete-bg); }
  .diff-cell.insert .diff-code { background: var(--insert-bg); }

  .story {
    display: grid;
    grid-template-rows: auto 1fr auto;
  }

  .story-body {
    padding: 14px;
    overflow: auto;
  }

  h2 {
    margin: 0 0 10px;
    font-size: 22px;
    line-height: 1.18;
  }

  .location {
    color: var(--muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .narration {
    margin-top: 14px;
    color: #dfd8ce;
    line-height: 1.55;
    white-space: pre-wrap;
  }

  .warnings {
    display: grid;
    gap: 6px;
    padding: 0 14px 14px;
  }

  .warning {
    border: 1px solid rgba(239, 116, 102, 0.45);
    border-radius: 6px;
    padding: 8px 10px;
    color: #f6c8c1;
    background: rgba(239, 116, 102, 0.12);
    font-size: 12px;
  }

  .tts-panel {
    position: absolute;
    right: 22px;
    top: 80px;
    z-index: 5;
    width: min(420px, calc(100vw - 44px));
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel);
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.42);
    padding: 12px;
  }

  .tts-panel[hidden] { display: none; }

  .tts-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .tts-field {
    min-width: 0;
    display: grid;
    gap: 4px;
    color: var(--muted);
    font-size: 11px;
  }

  .tts-field.full { grid-column: 1 / -1; }

  .tts-field input,
  .tts-field select,
  .tts-field textarea {
    min-width: 0;
    width: 100%;
    border: 1px solid var(--line);
    border-radius: 5px;
    background: #171717;
    color: var(--text);
    padding: 7px 8px;
    font: inherit;
    font-size: 12px;
  }

  .tts-field textarea {
    resize: vertical;
    min-height: 62px;
  }

  .tts-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 10px;
  }

  .tts-note,
  .tts-status {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.4;
  }

  .empty {
    padding: 28px;
    color: var(--muted);
  }

  @media (max-width: 900px) {
    .topbar { grid-template-columns: 1fr; }
    .controls { justify-content: flex-start; }
    .tts-panel { position: static; width: auto; margin: 0 22px 14px; }
    .layout { grid-template-columns: 1fr; }
    .rail { border-right: none; border-bottom: 1px solid var(--line); }
    .stop-list { grid-auto-flow: column; grid-auto-columns: minmax(220px, 1fr); overflow-x: auto; }
    .frame { grid-template-columns: 1fr; }
    .code-body { max-height: 54vh; }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 1ms !important; transition-duration: 1ms !important; }
  }
</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <div>
      <div class="eyebrow">RepoTrail animated export</div>
      <h1 id="tourTitle"></h1>
      <div id="tourSummary" class="summary"></div>
    </div>
    <div class="controls">
      <button id="prevBtn" title="Previous stop">Back</button>
      <button id="nextBtn" title="Next stop">Next</button>
      <button id="speakBtn" title="Read the current stop aloud">Speak</button>
      <button id="ttsSettingsBtn" class="secondary" title="Configure speech for this exported tour">TTS</button>
    </div>
  </header>
  <section id="ttsPanel" class="tts-panel" aria-label="Text to speech settings" hidden>
    <form id="ttsForm" autocomplete="off">
    <div class="tts-grid">
      <label class="tts-field">
        Provider
        <select id="ttsProvider">
          <option value="off">Off</option>
          <option value="system">System browser voice</option>
          <option value="kokoro">Kokoro local neural voice</option>
          <option value="elevenlabs">ElevenLabs hosted voice</option>
          <option value="openai">OpenAI hosted voice</option>
          <option value="say" disabled>Command voice unavailable in browser</option>
        </select>
      </label>
      <label class="tts-field">
        Kokoro voice
        <input id="kokoroVoice" autocomplete="off" placeholder="af_heart">
      </label>
      <label class="tts-field">
        ElevenLabs voice id
        <input id="elevenLabsVoiceId" autocomplete="off" placeholder="21m00Tcm4TlvDq8ikWAM">
      </label>
      <label class="tts-field">
        ElevenLabs model
        <input id="elevenLabsModel" autocomplete="off" placeholder="eleven_flash_v2_5">
      </label>
      <label class="tts-field">
        OpenAI model
        <input id="openAiModel" autocomplete="off" placeholder="gpt-4o-mini-tts">
      </label>
      <label class="tts-field">
        OpenAI voice
        <input id="openAiVoice" autocomplete="off" placeholder="ash">
      </label>
      <label class="tts-field full">
        OpenAI instructions
        <textarea id="openAiInstructions" placeholder="Read this like a friendly senior engineer."></textarea>
      </label>
      <label class="tts-field full">
        OpenAI API key for this browser
        <input id="openAiApiKey" type="password" autocomplete="off" placeholder="Not exported; stored locally in this browser only">
      </label>
      <label class="tts-field full">
        ElevenLabs API key for this browser
        <input id="elevenLabsApiKey" type="password" autocomplete="off" placeholder="Not exported; stored locally in this browser only">
      </label>
    </div>
    <div class="tts-actions">
      <button id="saveTtsBtn" class="primary" type="button">Save TTS settings</button>
      <button id="clearTtsKeysBtn" class="secondary" type="button">Clear keys</button>
    </div>
    <p id="ttsStatus" class="tts-status"></p>
    </form>
    <p class="tts-note">System and Kokoro run in the browser. Hosted voices need your API key here because exported HTML cannot safely carry VS Code secrets. Command-based voices such as macOS say cannot run from a browser page.</p>
  </section>
  <div class="layout">
    <aside class="rail">
      <p id="railMeta" class="rail-meta"></p>
      <ol id="stopList" class="stop-list"></ol>
    </aside>
    <main class="stage">
      <div class="progress"><div id="progressFill" class="progress-fill"></div></div>
      <section id="frame" class="frame" aria-live="polite">
        <section class="code-surface">
          <div class="surface-head">
            <div id="surfaceTitle" class="surface-title"></div>
            <div id="surfaceMode" class="pill"></div>
          </div>
          <div id="codeBody" class="code-body"></div>
        </section>
        <aside class="story">
          <div class="story-head">
            <div class="story-title">Narration</div>
            <div id="stepCount" class="pill"></div>
          </div>
          <div class="story-body">
            <h2 id="stepTitle"></h2>
            <div id="location" class="location"></div>
            <div id="narration" class="narration"></div>
          </div>
          <div id="warnings" class="warnings"></div>
        </aside>
      </section>
    </main>
  </div>
</div>
<script id="tour-data" type="application/json">${data}</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById("tour-data").textContent || "{}");
  const defaultTts = ${browserTtsDefaults};
  const browserTtsProviders = ${browserTtsProviders};
  const frames = Array.isArray(data.frames) ? data.frames : [];
  let index = 0;

  const byId = (id) => document.getElementById(id);
  const setText = (id, value) => { const el = byId(id); if (el) el.textContent = value || ""; };
  const stopList = byId("stopList");
  const codeBody = byId("codeBody");
  const frameEl = byId("frame");
  const speakBtn = byId("speakBtn");
  const ttsPanel = byId("ttsPanel");
  const ttsSettingsBtn = byId("ttsSettingsBtn");
  const ttsStatus = byId("ttsStatus");
  const ttsStorageKey = "repotrail:animated:tts:v1";
  let ttsSettings = loadTtsSettings();
  let speechState = "idle"; // idle | loading | speaking | paused
  let speakToken = 0;
  let audioEl = null;
  let activeUtterance = null;
  let kokoroWorker = null;
  let kokoroReqId = 0;
  const kokoroPending = new Map();

  setText("tourTitle", data.title || "RepoTrail tour");
  setText("tourSummary", data.summary || "");
  setText("railMeta", (data.kind || "tour") + " - " + frames.length + " stops - exported " + (data.exportedAt || ""));

  function loadTtsSettings() {
    const defaults = {
      provider: normalizeProvider(data.tts?.provider || defaultTts.provider),
      kokoroVoice: data.tts?.kokoroVoice || defaultTts.kokoroVoice,
      elevenLabsVoiceId: data.tts?.elevenLabsVoiceId || defaultTts.elevenLabsVoiceId,
      elevenLabsModel: data.tts?.elevenLabsModel || defaultTts.elevenLabsModel,
      openAiModel: data.tts?.openAiModel || defaultTts.openAiModel,
      openAiVoice: data.tts?.openAiVoice || defaultTts.openAiVoice,
      openAiInstructions: data.tts?.openAiInstructions || defaultTts.openAiInstructions,
      openAiApiKey: "",
      elevenLabsApiKey: "",
    };
    try {
      const saved = JSON.parse(localStorage.getItem(ttsStorageKey) || "{}");
      return { ...defaults, ...saved, provider: normalizeProvider(saved.provider || defaults.provider) };
    } catch {
      return defaults;
    }
  }

  function normalizeProvider(provider) {
    return browserTtsProviders.includes(provider) ? provider : defaultTts.provider;
  }

  function saveTtsSettings(next) {
    ttsSettings = { ...ttsSettings, ...next, provider: normalizeProvider(next.provider || ttsSettings.provider) };
    try { localStorage.setItem(ttsStorageKey, JSON.stringify(ttsSettings)); } catch (e) {}
    syncTtsForm();
  }

  function syncTtsForm() {
    const ids = [
      "ttsProvider",
      "kokoroVoice",
      "elevenLabsVoiceId",
      "elevenLabsModel",
      "openAiModel",
      "openAiVoice",
      "openAiInstructions",
      "openAiApiKey",
      "elevenLabsApiKey",
    ];
    ids.forEach((id) => {
      const el = byId(id);
      if (!el) return;
      const key = id === "ttsProvider" ? "provider" : id;
      el.value = ttsSettings[key] || "";
    });
    updateSpeechButtons();
  }

  function readTtsForm() {
    const value = (id) => byId(id)?.value?.trim?.() || "";
    return {
      provider: value("ttsProvider"),
      kokoroVoice: value("kokoroVoice") || defaultTts.kokoroVoice,
      elevenLabsVoiceId: value("elevenLabsVoiceId") || defaultTts.elevenLabsVoiceId,
      elevenLabsModel: value("elevenLabsModel") || defaultTts.elevenLabsModel,
      openAiModel: value("openAiModel") || defaultTts.openAiModel,
      openAiVoice: value("openAiVoice") || defaultTts.openAiVoice,
      openAiInstructions: value("openAiInstructions"),
      openAiApiKey: value("openAiApiKey"),
      elevenLabsApiKey: value("elevenLabsApiKey"),
    };
  }

  function setTtsStatus(message) {
    if (ttsStatus) ttsStatus.textContent = message || "";
  }

  function canSpeak() {
    return ttsSettings.provider !== "off";
  }

  function setSpeechState(next) {
    speechState = next;
    updateSpeechButtons();
  }

  function updateSpeechButtons() {
    if (speakBtn) {
      speakBtn.textContent =
        speechState === "loading" ? "Loading voice..." :
        speechState === "speaking" ? "Pause speech" :
        speechState === "paused" ? "Resume speech" :
        "Speak";
    }
  }

  function stopSpeech(clearStatus = false) {
    speakToken++;
    activeUtterance = null;
    try { window.speechSynthesis?.cancel(); } catch (e) {}
    if (audioEl) {
      try { audioEl.pause(); } catch (e) {}
      audioEl = null;
    }
    setSpeechState("idle");
    if (clearStatus) setTtsStatus("");
  }

  function pauseSpeech() {
    if (speechState !== "speaking") return;
    try { window.speechSynthesis?.pause(); } catch (e) {}
    if (audioEl) {
      try { audioEl.pause(); } catch (e) {}
    }
    setSpeechState("paused");
  }

  function resumeSpeech() {
    if (speechState !== "paused") return;
    if (audioEl) {
      audioEl.play().then(() => setSpeechState("speaking")).catch((err) => {
        setTtsStatus("Audio resume failed: " + ((err && err.message) || err));
        setSpeechState("idle");
      });
      return;
    }
    try { window.speechSynthesis?.resume(); setSpeechState("speaking"); } catch (e) { setSpeechState("idle"); }
  }

  function currentSpeechText() {
    const frame = frames[index];
    if (!frame) return "";
    return humanizeForSpeech((frame.title || "") + ". " + (frame.explanation || ""));
  }

  function startSpeech() {
    const text = currentSpeechText();
    if (!text.trim()) return;
    if (speechState === "loading" || speechState === "speaking") stopSpeech(false);
    const token = ++speakToken;
    setSpeechState("loading");
    setTtsStatus("");
    const provider = ttsSettings.provider;
    if (provider === "off") {
      setSpeechState("idle");
      setTtsStatus("Speech is off. Open TTS settings to choose a provider.");
    } else if (provider === "kokoro") {
      speakKokoro(text, token);
    } else if (provider === "openai") {
      speakOpenAi(text, token);
    } else if (provider === "elevenlabs") {
      speakElevenLabs(text, token);
    } else {
      speakSystem(text, token);
    }
  }

  function speechEnded(token) {
    if (token !== speakToken) return;
    setSpeechState("idle");
  }

  function speakSystem(text, token) {
    try {
      if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === "undefined") {
        setTtsStatus("System speech is not available in this browser.");
        setSpeechState("idle");
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.04;
      activeUtterance = utterance;
      utterance.onstart = () => { if (token === speakToken) setSpeechState("speaking"); };
      utterance.onend = () => speechEnded(token);
      utterance.onerror = (event) => {
        if (token !== speakToken) return;
        setTtsStatus("System speech failed: " + (event.error || "unknown error"));
        setSpeechState("idle");
      };
      window.speechSynthesis.speak(utterance);
    } catch (err) {
      setTtsStatus("System speech failed: " + ((err && err.message) || err));
      setSpeechState("idle");
    }
  }

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
      '    const audio = await tts.generate(m.text, { voice: m.voice || ' + JSON.stringify(defaultTts.kokoroVoice) + ' });',
      '    const wav = audio.toWav();',
      '    self.postMessage({ type: "audio", id: m.id, wav: wav }, [wav]);',
      '  } catch (err) {',
      '    self.postMessage({ type: "error", id: m.id, message: String((err && err.message) || err) });',
      '  }',
      '};',
    ].join("\\n");
    const url = URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" }));
    kokoroWorker = new Worker(url, { type: "module" });
    kokoroWorker.onmessage = (event) => {
      const msg = event.data;
      const pending = msg && kokoroPending.get(msg.id);
      if (!pending) return;
      kokoroPending.delete(msg.id);
      if (msg.type === "audio") pending.resolve(msg.wav);
      else pending.reject(new Error(msg.message || "kokoro error"));
    };
    kokoroWorker.onerror = (err) => {
      setTtsStatus("Kokoro failed to load; using system speech for this stop.");
      for (const pending of kokoroPending.values()) pending.reject(new Error("kokoro worker error"));
      kokoroPending.clear();
      try { kokoroWorker.terminate(); } catch (e) {}
      kokoroWorker = null;
    };
    return kokoroWorker;
  }

  function kokoroGenerate(text) {
    return new Promise((resolve, reject) => {
      const id = ++kokoroReqId;
      const timer = window.setTimeout(() => {
        if (!kokoroPending.has(id)) return;
        kokoroPending.delete(id);
        reject(new Error("kokoro timed out"));
      }, 90000);
      kokoroPending.set(id, {
        resolve: (wav) => { window.clearTimeout(timer); resolve(wav); },
        reject: (err) => { window.clearTimeout(timer); reject(err); },
      });
      getKokoroWorker().postMessage({ type: "generate", id, text, voice: ttsSettings.kokoroVoice || defaultTts.kokoroVoice });
    });
  }

  async function speakKokoro(text, token) {
    const chunks = splitSentences(text);
    for (let i = 0; i < chunks.length; i++) {
      if (token !== speakToken) return;
      try {
        const wav = await kokoroGenerate(chunks[i]);
        if (token !== speakToken) return;
        await playBlob(new Blob([wav], { type: "audio/wav" }), token, false);
      } catch (err) {
        if (token !== speakToken) return;
        setTtsStatus("Kokoro unavailable; falling back to system speech.");
        speakSystem(chunks.slice(i).join(" "), token);
        return;
      }
    }
    speechEnded(token);
  }

  async function speakOpenAi(text, token) {
    const key = ttsSettings.openAiApiKey || "";
    if (!key) {
      setTtsStatus("OpenAI needs an API key in TTS settings. Keys are stored only in this browser.");
      setSpeechState("idle");
      return;
    }
    const model = ttsSettings.openAiModel || defaultTts.openAiModel;
    const steerable = model.startsWith("gpt-4o");
    await fetchSpeech(
      "https://api.openai.com/v1/audio/speech",
      {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          voice: ttsSettings.openAiVoice || defaultTts.openAiVoice,
          input: text,
          response_format: "mp3",
          ...(steerable && ttsSettings.openAiInstructions ? { instructions: ttsSettings.openAiInstructions } : {}),
        }),
      },
      token,
      "OpenAI",
    );
  }

  async function speakElevenLabs(text, token) {
    const key = ttsSettings.elevenLabsApiKey || "";
    if (!key) {
      setTtsStatus("ElevenLabs needs an API key in TTS settings. Keys are stored only in this browser.");
      setSpeechState("idle");
      return;
    }
    const voiceId = encodeURIComponent(ttsSettings.elevenLabsVoiceId || defaultTts.elevenLabsVoiceId);
    await fetchSpeech(
      "https://api.elevenlabs.io/v1/text-to-speech/" + voiceId + "?output_format=mp3_44100_128",
      {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: ttsSettings.elevenLabsModel || defaultTts.elevenLabsModel }),
      },
      token,
      "ElevenLabs",
    );
  }

  async function fetchSpeech(url, init, token, label) {
    try {
      const res = await fetch(url, init);
      if (token !== speakToken) return;
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error("HTTP " + res.status + (body ? ": " + body.slice(0, 180) : ""));
      }
      await playBlob(await res.blob(), token, true);
    } catch (err) {
      if (token !== speakToken) return;
      setTtsStatus(label + " speech failed. Browser CORS or API key permissions may block direct hosted TTS: " + ((err && err.message) || err));
      setSpeechState("idle");
    }
  }

  function playBlob(blob, token, finishOnEnd) {
    return new Promise((resolve) => {
      if (token !== speakToken) { resolve(); return; }
      const url = URL.createObjectURL(blob);
      if (audioEl) {
        try { audioEl.pause(); } catch (e) {}
      }
      audioEl = new Audio(url);
      audioEl.onplaying = () => { if (token === speakToken) setSpeechState("speaking"); };
      audioEl.onended = () => {
        try { URL.revokeObjectURL(url); } catch (e) {}
        if (finishOnEnd) speechEnded(token);
        resolve();
      };
      audioEl.onerror = () => {
        try { URL.revokeObjectURL(url); } catch (e) {}
        if (token === speakToken) {
          setTtsStatus("Audio playback failed.");
          setSpeechState("idle");
        }
        resolve();
      };
      audioEl.play().catch((err) => {
        try { URL.revokeObjectURL(url); } catch (e) {}
        if (token === speakToken) {
          setTtsStatus("Audio playback failed: " + ((err && err.message) || err));
          setSpeechState("idle");
        }
        resolve();
      });
    });
  }

  function splitSentences(text) {
    const parts = text.match(/[^.!?]+[.!?]*\\s*/g);
    return (parts ? parts.map((s) => s.trim()).filter(Boolean) : [text]);
  }

  function humanizeForSpeech(text) {
    let out = stripMarkdown(text);
    const operators = [
      [/===/g, " strictly equals "],
      [/!==/g, " strictly not equals "],
      [/=>/g, " arrow "],
      [/->/g, " arrow "],
      [/==/g, " equals "],
      [/!=/g, " not equals "],
      [/>=/g, " greater than or equal to "],
      [/<=/g, " less than or equal to "],
      [/&&/g, " and "],
      [/\\|\\|/g, " or "],
      [/::/g, " "],
      [/\\+\\+/g, " plus plus "],
      [/--/g, " minus minus "],
    ];
    operators.forEach(([re, word]) => { out = out.replace(re, word); });
    out = out.replace(/([A-Za-z0-9_$]+)\\.([A-Za-z0-9_$]+)(?=\\.[A-Za-z0-9_$]+|\\b)/g, "$1 dot $2");
    out = out.replace(/[A-Za-z][A-Za-z0-9_$-]*[A-Za-z0-9]/g, (tok) => {
      const looksLikeCode = /[_-]/.test(tok) || /[a-z][A-Z]/.test(tok) || /[A-Za-z][0-9]|[0-9][A-Za-z]/.test(tok);
      return looksLikeCode ? splitIdentifier(tok) : tok;
    });
    return out.replace(/\\s+/g, " ").trim();
  }

  function stripMarkdown(md) {
    return String(md || "")
      .replace(new RegExp("\\\\x60\\\\x60\\\\x60[\\\\s\\\\S]*?\\\\x60\\\\x60\\\\x60", "g"), "")
      .replace(new RegExp("\\\\x60([^\\\\x60]+)\\\\x60", "g"), "$1")
      .replace(/!\\[[^\\]]*\\]\\([^)]*\\)/g, "")
      .replace(/\\[([^\\]]+)\\]\\([^)]*\\)/g, "$1")
      .replace(/^\\s{0,3}#{1,6}\\s+/gm, "")
      .replace(/^\\s*[-*+]\\s+/gm, "")
      .replace(/^\\s*>\\s+/gm, "")
      .replace(/\\*\\*([^*]+)\\*\\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\\*([^*]+)\\*/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      .replace(/\\s+/g, " ")
      .trim();
  }

  function splitIdentifier(tok) {
    return tok
      .replace(/[_-]+/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/([A-Za-z])([0-9])/g, "$1 $2")
      .replace(/([0-9])([A-Za-z])/g, "$1 $2")
      .toLowerCase()
      .trim();
  }

  function renderRoute() {
    if (!stopList) return;
    stopList.textContent = "";
    frames.forEach((frame, i) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.className = "stop-button" + (i === index ? " active" : "");
      btn.type = "button";
      btn.addEventListener("click", () => go(i));

      const num = document.createElement("span");
      num.className = "stop-num";
      num.textContent = String(i + 1).padStart(2, "0");
      const title = document.createElement("span");
      title.className = "stop-title";
      title.textContent = frame.title || "Untitled stop";
      const loc = document.createElement("span");
      loc.className = "stop-loc";
      loc.textContent = frame.location || "";

      btn.append(num, title, loc);
      li.appendChild(btn);
      stopList.appendChild(li);
    });
  }

  function renderCode(frame) {
    if (!codeBody) return;
    codeBody.textContent = "";
    if (frame.diff) {
      renderDiff(frame.diff);
      return;
    }
    const code = frame.code;
    if (!code || !code.text) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No code snapshot was available for this stop.";
      codeBody.appendChild(empty);
      return;
    }
    const lines = code.text.split(/\\r?\\n/);
    lines.forEach((line, i) => {
      const lineNo = (code.startLine || 1) + i;
      const row = document.createElement("div");
      row.className = "code-line" +
        (code.highlightStartLine && lineNo >= code.highlightStartLine && lineNo <= code.highlightEndLine ? " highlight" : "");
      const num = document.createElement("span");
      num.className = "line-no";
      num.textContent = String(lineNo);
      const body = document.createElement("span");
      body.className = "line-code";
      body.textContent = line || " ";
      row.append(num, body);
      codeBody.appendChild(row);
    });
  }

  function renderDiff(diff) {
    const wrap = document.createElement("div");
    wrap.className = "diff";
    const head = document.createElement("div");
    head.className = "diff-head";
    head.append(label(diff.beforeLabel || "Before"), label(diff.afterLabel || "After"));
    wrap.appendChild(head);

    (diff.rows || []).forEach((row) => {
      const pair = document.createElement("div");
      pair.className = "diff-row-pair";
      pair.append(
        diffCell(row.before, row.type === "delete" ? "delete" : "equal", row.type === "delete" ? "-" : ""),
        diffCell(row.after, row.type === "insert" ? "insert" : "equal", row.type === "insert" ? "+" : ""),
      );
      wrap.appendChild(pair);
    });
    codeBody.appendChild(wrap);
  }

  function label(text) {
    const el = document.createElement("div");
    el.className = "diff-label";
    el.textContent = text;
    return el;
  }

  function diffCell(text, cls, mark) {
    const row = document.createElement("div");
    row.className = "diff-cell " + cls;
    const marker = document.createElement("span");
    marker.className = "diff-mark";
    marker.textContent = mark;
    const code = document.createElement("span");
    code.className = "diff-code";
    code.textContent = text || " ";
    row.append(marker, code);
    return row;
  }

  function renderWarnings(frame) {
    const root = byId("warnings");
    if (!root) return;
    root.textContent = "";
    (frame.warnings || []).forEach((warning) => {
      const el = document.createElement("div");
      el.className = "warning";
      el.textContent = warning;
      root.appendChild(el);
    });
  }

  function render() {
    const frame = frames[index];
    if (!frame) return;
    setText("surfaceTitle", frame.location || frame.title || "");
    setText("surfaceMode", frame.viewLabel || (frame.diff ? "Diff" : "Code"));
    setText("stepCount", (index + 1) + " / " + frames.length);
    setText("stepTitle", frame.title || "Untitled stop");
    setText("location", frame.location || "");
    setText("narration", frame.explanation || "");
    const progress = frames.length ? ((index + 1) / frames.length) * 100 : 0;
    const fill = byId("progressFill");
    if (fill) fill.style.width = progress + "%";
    updateSpeechButtons();
    renderRoute();
    renderCode(frame);
    renderWarnings(frame);
    if (frameEl) {
      frameEl.classList.remove("is-entering");
      void frameEl.offsetWidth;
      frameEl.classList.add("is-entering");
    }
  }

  function go(next) {
    if (!frames.length) return;
    stopSpeech(true);
    index = Math.max(0, Math.min(frames.length - 1, next));
    render();
  }

  byId("prevBtn")?.addEventListener("click", () => go(index - 1));
  byId("nextBtn")?.addEventListener("click", () => go(index + 1));
  speakBtn?.addEventListener("click", () => {
    if (speechState === "speaking") pauseSpeech();
    else if (speechState === "paused") resumeSpeech();
    else if (speechState === "loading") stopSpeech(true);
    else startSpeech();
  });
  ttsSettingsBtn?.addEventListener("click", () => {
    if (!ttsPanel) return;
    ttsPanel.hidden = !ttsPanel.hidden;
  });
  byId("saveTtsBtn")?.addEventListener("click", () => {
    saveTtsSettings(readTtsForm());
    setTtsStatus("TTS settings saved for this browser.");
    stopSpeech(false);
  });
  byId("clearTtsKeysBtn")?.addEventListener("click", () => {
    saveTtsSettings({ ...readTtsForm(), openAiApiKey: "", elevenLabsApiKey: "" });
    setTtsStatus("Hosted API keys cleared from this browser.");
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") go(index - 1);
    if (event.key === "ArrowRight") go(index + 1);
  });
  syncTtsForm();
  render();
})();
</script>
</body>
</html>`;
}

function diffRows(before: string[], after: string[]): AnimatedTourDiffRow[] {
  const table: number[][] = Array.from({ length: before.length + 1 }, () =>
    Array.from({ length: after.length + 1 }, () => 0),
  );
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i][j] =
        before[i] === after[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const rows: AnimatedTourDiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      rows.push({ before: before[i], after: after[j], type: "equal" });
      i++;
      j++;
    } else if (j < after.length && (i >= before.length || table[i][j + 1] >= table[i + 1][j])) {
      rows.push({ after: after[j], type: "insert" });
      j++;
    } else if (i < before.length) {
      rows.push({ before: before[i], type: "delete" });
      i++;
    }
  }
  return rows.length > 0 ? rows : [{ before: "", after: "", type: "equal" }];
}

function splitLines(text: string): string[] {
  if (!text) return [""];
  return text.replace(/\r\n/g, "\n").split("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
