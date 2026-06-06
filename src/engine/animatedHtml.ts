import { TourPlan } from "./types";

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
  }).replace(/</g, "\\u003c");

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
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    min-height: 0;
  }

  .diff-col:first-child { border-right: 1px solid var(--line); }

  .diff-label {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 8px 12px;
    background: #151515;
    border-bottom: 1px solid var(--line);
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
  }

  .diff-cell {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr);
    min-height: 22px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.03);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    font-size: 12px;
    line-height: 1.45;
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
    white-space: pre;
    min-height: 22px;
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

  .empty {
    padding: 28px;
    color: var(--muted);
  }

  @media (max-width: 900px) {
    .topbar { grid-template-columns: 1fr; }
    .controls { justify-content: flex-start; }
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
      <button id="playBtn" class="primary" title="Play or pause the animated tour">Play</button>
      <button id="nextBtn" title="Next stop">Next</button>
    </div>
  </header>
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
  const frames = Array.isArray(data.frames) ? data.frames : [];
  let index = 0;
  let playing = false;
  let timer = 0;

  const byId = (id) => document.getElementById(id);
  const setText = (id, value) => { const el = byId(id); if (el) el.textContent = value || ""; };
  const stopList = byId("stopList");
  const codeBody = byId("codeBody");
  const frameEl = byId("frame");
  const playBtn = byId("playBtn");

  setText("tourTitle", data.title || "RepoTrail tour");
  setText("tourSummary", data.summary || "");
  setText("railMeta", (data.kind || "tour") + " - " + frames.length + " stops - exported " + (data.exportedAt || ""));

  function schedule() {
    window.clearTimeout(timer);
    if (!playing || frames.length < 2) return;
    const text = frames[index]?.explanation || "";
    const words = text.trim() ? text.trim().split(/\\s+/).length : 0;
    const duration = Math.max(4500, Math.min(14000, 3200 + words * 95));
    timer = window.setTimeout(() => go(index >= frames.length - 1 ? 0 : index + 1), duration);
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
    const left = document.createElement("div");
    left.className = "diff-col";
    const right = document.createElement("div");
    right.className = "diff-col";
    left.appendChild(label(diff.beforeLabel || "Before"));
    right.appendChild(label(diff.afterLabel || "After"));

    (diff.rows || []).forEach((row) => {
      left.appendChild(diffCell(row.before, row.type === "delete" ? "delete" : "equal", row.type === "delete" ? "-" : ""));
      right.appendChild(diffCell(row.after, row.type === "insert" ? "insert" : "equal", row.type === "insert" ? "+" : ""));
    });
    wrap.append(left, right);
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
    if (playBtn) playBtn.textContent = playing ? "Pause" : "Play";
    renderRoute();
    renderCode(frame);
    renderWarnings(frame);
    if (frameEl) {
      frameEl.classList.remove("is-entering");
      void frameEl.offsetWidth;
      frameEl.classList.add("is-entering");
    }
    schedule();
  }

  function go(next) {
    if (!frames.length) return;
    index = Math.max(0, Math.min(frames.length - 1, next));
    render();
  }

  byId("prevBtn")?.addEventListener("click", () => go(index - 1));
  byId("nextBtn")?.addEventListener("click", () => go(index + 1));
  playBtn?.addEventListener("click", () => {
    playing = !playing;
    render();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") go(index - 1);
    if (event.key === "ArrowRight") go(index + 1);
    if (event.key === " ") {
      event.preventDefault();
      playing = !playing;
      render();
    }
  });
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
