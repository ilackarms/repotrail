import { TourPlan, TourRange, TourSlide } from "./types";
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
  /**
   * "gap" stands for `skipped` rows left out: unchanged lines between changes,
   * or, with a `label`, the rest of the file outside the stop's range.
   */
  type: "equal" | "delete" | "insert" | "gap";
  skipped?: number;
  label?: string;
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
  /** A slide stop, played with the slide runtime. */
  slide?: TourSlide;
  warnings: string[];
}

export interface AnimatedTourHtmlInput {
  plan: TourPlan;
  exportedAt: string;
  frames: AnimatedTourFrame[];
  tts?: AnimatedTourTtsDefaults;
  /**
   * The slide runtime (out/slides.js and out/slides.css), inlined so slide
   * frames play in the exported page. The caller reads the files; this module
   * stays pure.
   */
  slideRuntime?: { script: string; css: string };
  /**
   * Load the player from this URL instead of inlining it (`render --artifact`).
   * The page then offers only the browser's own voice.
   */
  playerUrl?: string;
}

export const ANIMATED_EXPORT_CONTEXT_LINES = 2;
export const ANIMATED_EXPORT_MAX_CODE_LINES = 80;

export interface CodeFrameLimits {
  contextLines: number;
  maxLines: number;
}

/**
 * Code shown around a stop on a page people read without the repo open (an
 * Artifact), where the snapshot is all the context they get.
 */
export const STANDALONE_CODE_LIMITS: CodeFrameLimits = { contextLines: 12, maxLines: 200 };

/**
 * The code shown for a code stop: the range plus some context, capped in
 * length. `lines` is the whole file.
 */
export function codeFrameFromLines(
  lines: string[],
  range: TourRange | undefined,
  languageId: string | undefined,
  eol = "\n",
  limits: CodeFrameLimits = { contextLines: ANIMATED_EXPORT_CONTEXT_LINES, maxLines: ANIMATED_EXPORT_MAX_CODE_LINES },
): { frame: AnimatedTourCodeFrame; warnings: string[] } {
  if (lines.length === 0) return { frame: { text: "", startLine: 1, languageId }, warnings: [] };
  const clampLine = (n: number, lo: number) => Math.max(lo, Math.min(lines.length - 1, n));
  const focusStart = range ? clampLine(range.startLine - 1, 0) : 0;
  const focusEnd = range ? clampLine(range.endLine - 1, focusStart) : 0;
  const start = range ? Math.max(0, focusStart - limits.contextLines) : 0;
  let end = range
    ? Math.min(lines.length - 1, focusEnd + limits.contextLines)
    : Math.min(lines.length - 1, limits.maxLines - 1);
  if (end - start + 1 > limits.maxLines) end = start + limits.maxLines - 1;
  const truncated = start > 0 || end < lines.length - 1;
  return {
    frame: {
      text: lines.slice(start, end + 1).join(eol),
      startLine: start + 1,
      highlightStartLine: range ? focusStart + 1 : undefined,
      highlightEndLine: range ? focusEnd + 1 : undefined,
      languageId,
      truncated,
    },
    warnings: truncated ? ["Code snapshot was trimmed around the tour range."] : [],
  };
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

/** Rows a diff snapshot shows at most, gap rows included. */
const MAX_DIFF_ROWS = 160;
/** Unchanged lines kept on each side of a change. */
const DIFF_CONTEXT_LINES = 4;
/** Past this many before × after lines, the changed region is too big to align line by line. */
const MAX_DIFF_CELLS = 4_000_000;

/**
 * A side-by-side diff of two versions of a file, focused on what changed.
 * Unchanged runs longer than a few lines of context collapse into gap rows,
 * so a change deep in a long file still shows. With `focus` (the stop's range,
 * in after-side lines) the snapshot keeps only that part of the file.
 */
export function buildAnimatedDiffFrame(input: {
  beforeText: string;
  afterText: string;
  beforeLabel?: string;
  afterLabel?: string;
  languageId?: string;
  focus?: { startLine: number; endLine: number };
}): AnimatedTourDiffFrame {
  const before = splitLines(input.beforeText);
  const after = splitLines(input.afterText);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  let changedBefore = before.slice(prefix, before.length - suffix);
  let changedAfter = after.slice(prefix, after.length - suffix);
  let truncated = false;
  if ((changedBefore.length + 1) * (changedAfter.length + 1) > MAX_DIFF_CELLS) {
    // Too big to align: show the start of the changed region.
    changedBefore = changedBefore.slice(0, MAX_DIFF_ROWS);
    changedAfter = changedAfter.slice(0, MAX_DIFF_ROWS);
    truncated = true;
  }
  const equal = (text: string): AnimatedTourDiffRow => ({ before: text, after: text, type: "equal" });
  let all = [
    ...before.slice(0, prefix).map(equal),
    ...diffRows(changedBefore, changedAfter),
    ...(truncated ? [] : before.slice(before.length - suffix).map(equal)),
  ];
  let above: AnimatedTourDiffRow[] = [];
  let below: AnimatedTourDiffRow[] = [];
  const window = input.focus && !truncated ? focusWindow(all, input.focus) : undefined;
  if (window) {
    above = edgeGap(all.slice(0, window.start), "above");
    below = edgeGap(all.slice(window.end), "below");
    all = all.slice(window.start, window.end);
  }
  const rows = mergeGaps([...above, ...collapseUnchanged(all), ...below]);
  if (rows.length > MAX_DIFF_ROWS) {
    rows.length = MAX_DIFF_ROWS;
    truncated = true;
  }
  return {
    beforeLabel: input.beforeLabel ?? "Before",
    afterLabel: input.afterLabel ?? "After",
    beforeText: rows.flatMap((row) => (row.before === undefined ? [] : [row.before])).join("\n"),
    afterText: rows.flatMap((row) => (row.after === undefined ? [] : [row.after])).join("\n"),
    languageId: input.languageId,
    rows: rows.length > 0 ? rows : [{ before: "", after: "", type: "equal" }],
    truncated,
  };
}

/**
 * The rows covering after-side lines `focus`, plus context; undefined when
 * none do. A run of changes counts as one block, so a stop on a rewritten
 * hunk keeps all of its deleted lines too.
 */
function focusWindow(
  rows: AnimatedTourDiffRow[],
  focus: { startLine: number; endLine: number },
): { start: number; end: number } | undefined {
  let afterLine = 0;
  let first = -1;
  let last = -1;
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type === "equal") {
      afterLine++;
      if (afterLine >= focus.startLine && afterLine <= focus.endLine) {
        if (first < 0) first = i;
        last = i;
      }
      i++;
      continue;
    }
    // A block of changes spans its inserted lines; a pure deletion sits at
    // the next after-side line.
    const blockStart = afterLine + 1;
    let j = i;
    while (j < rows.length && rows[j].type !== "equal") {
      if (rows[j].type === "insert") afterLine++;
      j++;
    }
    const blockEnd = Math.max(blockStart, afterLine);
    if (blockStart <= focus.endLine && blockEnd >= focus.startLine) {
      if (first < 0) first = i;
      last = j - 1;
    }
    i = j;
  }
  if (first < 0) return undefined;
  return { start: Math.max(0, first - DIFF_CONTEXT_LINES), end: Math.min(rows.length, last + 1 + DIFF_CONTEXT_LINES) };
}

/** One gap row for the part of the file outside the stop's range. */
function edgeGap(rows: AnimatedTourDiffRow[], where: "above" | "below"): AnimatedTourDiffRow[] {
  if (rows.length === 0) return [];
  const changed = rows.some((row) => row.type !== "equal");
  return [{ type: "gap", skipped: rows.length, label: changed ? `more changes ${where}` : undefined }];
}

function mergeGaps(rows: AnimatedTourDiffRow[]): AnimatedTourDiffRow[] {
  const out: AnimatedTourDiffRow[] = [];
  for (const row of rows) {
    const prev = out[out.length - 1];
    if (row.type === "gap" && prev?.type === "gap") {
      out[out.length - 1] = { type: "gap", skipped: (prev.skipped ?? 0) + (row.skipped ?? 0), label: prev.label ?? row.label };
    } else out.push(row);
  }
  return out;
}

/** Keeps DIFF_CONTEXT_LINES of unchanged lines around each change and folds the rest into gap rows. */
function collapseUnchanged(rows: AnimatedTourDiffRow[]): AnimatedTourDiffRow[] {
  if (!rows.some((row) => row.type !== "equal")) return rows;
  const out: AnimatedTourDiffRow[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type !== "equal") {
      out.push(rows[i++]);
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].type === "equal") j++;
    const head = i === 0 ? 0 : DIFF_CONTEXT_LINES; // after a change
    const tail = j === rows.length ? 0 : DIFF_CONTEXT_LINES; // before a change
    if (j - i <= head + tail + 1) out.push(...rows.slice(i, j));
    else out.push(...rows.slice(i, i + head), { type: "gap", skipped: j - i - head - tail }, ...rows.slice(j - tail, j));
    i = j;
  }
  return out;
}

/**
 * Voices a hosted page offers. Artifact pages can't load Kokoro from esm.sh
 * or call hosted voice APIs, so only the browser's own voice is left.
 */
const HOSTED_TTS_PROVIDERS: readonly BrowserTtsProvider[] = ["off", "system"];

/** Where `render --artifact` pages load the player from: the npm package, served by jsDelivr. */
export function hostedPlayerUrl(version: string): string {
  return `https://cdn.jsdelivr.net/npm/repotrail@${version}/out/player.js`;
}

/**
 * The HTML player for a tour. By default the page carries everything: styles,
 * the slide runtime and the player script, so it works offline. With
 * `playerUrl` the page carries only markup and tour data and loads the player
 * from that URL, which keeps it small enough to read before publishing it as
 * a Claude Artifact.
 */
export function planToAnimatedHtml(input: AnimatedTourHtmlInput): string {
  const hosted = Boolean(input.playerUrl);
  const ttsDefaults = {
    provider: TTS_DEFAULTS.provider,
    kokoroVoice: TTS_DEFAULTS.kokoroVoice,
    elevenLabsVoiceId: TTS_DEFAULTS.elevenLabsVoiceId,
    elevenLabsModel: TTS_DEFAULTS.elevenLabsModel,
    openAiModel: TTS_DEFAULTS.openAiModel,
    openAiVoice: TTS_DEFAULTS.openAiVoice,
    openAiInstructions: TTS_DEFAULTS.openAiInstructions,
  };
  const payload = {
    title: input.plan.title || "RepoTrail tour",
    kind: input.plan.kind,
    summary: input.plan.summary,
    exportedAt: input.exportedAt,
    frames: hosted ? input.frames.map(withoutDiffText) : input.frames,
    tts: input.tts ?? {},
    ttsDefaults: hosted ? { ...ttsDefaults, provider: "system" } : ttsDefaults,
    ttsProviders: hosted ? HOSTED_TTS_PROVIDERS : BROWSER_TTS_PROVIDERS,
  };
  // A hosted page is read line by line before it's published, so its data is indented.
  const data = JSON.stringify(payload, null, hosted ? 1 : undefined).replace(/</g, "\\u003c");
  const title = escapeHtml(input.plan.title || "RepoTrail tour");
  if (input.playerUrl) return hostedPage(title, data, input.playerUrl);

  const runtime = input.slideRuntime;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>${title}</title>
${runtime ? `<style>${runtime.css.replace(/<\/style/gi, "<\\/style")}</style>` : ""}
<style>${PLAYER_CSS}</style>
</head>
<body>
${playerMarkup(false)}
<script id="tour-data" type="application/json">${data}</script>
${runtime ? `<script>${runtime.script.replace(/<\/script/gi, "<\\/script")}</script>` : ""}
<script>
${PLAYER_SCRIPT}
</script>
</body>
</html>`;
}

function hostedPage(title: string, data: string, playerUrl: string): string {
  const urlLiteral = JSON.stringify(playerUrl).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>${title}</title>
<!-- The RepoTrail player (page styles, slide runtime, player script) from the repotrail npm package. -->
<script src="${escapeHtml(playerUrl)}"></script>
</head>
<body>
<p id="playerStatus">Loading the RepoTrail player…</p>
${playerMarkup(true)}
<script id="tour-data" type="application/json">
${data}
</script>
<script>
window.addEventListener("load", function () {
  if (window.RepoTrailPlayer) return;
  var status = document.getElementById("playerStatus");
  if (status) status.textContent = "Couldn't load the RepoTrail player from " + ${urlLiteral} + ".";
});
</script>
</body>
</html>`;
}

/**
 * `out/player.js`, the file hosted pages load: the page styles, the slide
 * runtime and the player script. The build writes it, the npm package ships
 * it, and jsDelivr serves it.
 */
export function hostedPlayerScript(runtime: { script: string; css: string }): string {
  const slidesCss = runtime.css.replace(/\/\*# sourceMappingURL=\S* \*\/\s*$/, "");
  const css = JSON.stringify(`${slidesCss}\n${PLAYER_CSS}`);
  const slides = runtime.script.replace(/\n\/\/# sourceMappingURL=\S*\s*$/, "\n");
  return `/* RepoTrail player for pages written by \`repotrail render --artifact\`. */
(function () {
  var style = document.createElement("style");
  style.textContent = ${css};
  (document.head || document.documentElement).appendChild(style);
})();
${slides}
;(function () {
  function start() {
    var app = document.getElementById("app");
    if (app) app.hidden = false;
    var status = document.getElementById("playerStatus");
    if (status) status.remove();
${PLAYER_SCRIPT}
  }
  window.RepoTrailPlayer = true;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
`;
}

/** A hosted page's frames leave out the diff texts; the player draws diffs from rows. */
function withoutDiffText(frame: AnimatedTourFrame): AnimatedTourFrame {
  if (!frame.diff) return frame;
  const { beforeText: _before, afterText: _after, ...diff } = frame.diff;
  return { ...frame, diff: diff as AnimatedTourDiffFrame };
}

const DARK_TOKENS = `
    color-scheme: dark;
    --bg: #171717;
    --panel: #232323;
    --panel-2: #2d2a25;
    --chrome: #1c1b19;
    --line: #403d38;
    --rule: rgba(255, 255, 255, 0.03);
    --text: #f4f0e8;
    --text-soft: #dfd8ce;
    --muted: #afa89e;
    --accent: #2fb7a3;
    --on-accent: #071412;
    --accent-2: #f0b84d;
    --danger: #ef7466;
    --danger-fg: #f6c8c1;
    --code-bg: #101010;
    --gutter-bg: #151515;
    --gutter-fg: #7c776f;
    --code-hi: rgba(47, 183, 163, 0.2);
    --delete-bg: rgba(239, 116, 102, 0.16);
    --insert-bg: rgba(47, 183, 163, 0.16);
    --track: #2a2927;
    --shadow: 0 18px 44px rgba(0, 0, 0, 0.42);`;

const PLAYER_CSS = `
  :root {
    color-scheme: light;
    --bg: #f6f4ef;
    --panel: #ffffff;
    --panel-2: #e8f3f0;
    --chrome: #efece6;
    --line: #dcd6cc;
    --rule: rgba(0, 0, 0, 0.05);
    --text: #1f1c18;
    --text-soft: #34302a;
    --muted: #6c665d;
    --accent: #0f7f6f;
    --on-accent: #ffffff;
    --accent-2: #8f5a00;
    --danger: #b93a2b;
    --danger-fg: #8c2a1e;
    --code-bg: #fbfaf7;
    --gutter-bg: #f1eee8;
    --gutter-fg: #9b958b;
    --code-hi: rgba(15, 127, 111, 0.13);
    --delete-bg: rgba(185, 58, 43, 0.12);
    --insert-bg: rgba(15, 127, 111, 0.13);
    --track: #e2ddd4;
    --shadow: 0 18px 44px rgba(0, 0, 0, 0.16);
  }

  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {${DARK_TOKENS}
    }
  }

  :root[data-theme="dark"] {${DARK_TOKENS}
  }

  * { box-sizing: border-box; }
  [hidden] { display: none !important; }

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
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 700; }
  button.secondary { background: var(--chrome); }

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
    background: var(--chrome);
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
    background: var(--chrome);
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
    background: var(--track);
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
    border-bottom: 1px solid var(--rule);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    font-size: 12px;
    line-height: 1.45;
  }

  .line-no {
    padding: 2px 10px;
    color: var(--gutter-fg);
    text-align: right;
    user-select: none;
    background: var(--gutter-bg);
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
    background: var(--gutter-bg);
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
    border-bottom: 1px solid var(--rule);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    font-size: 12px;
    line-height: 1.45;
    tab-size: 2;
  }

  .diff-mark {
    padding: 2px 8px;
    color: var(--gutter-fg);
    text-align: center;
    user-select: none;
    background: var(--gutter-bg);
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

  .diff-gap {
    padding: 3px 12px;
    border-bottom: 1px solid var(--line);
    background: var(--gutter-bg);
    color: var(--muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    font-size: 11px;
  }

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
    color: var(--text-soft);
    line-height: 1.55;
    white-space: pre-wrap;
  }

  .warnings {
    display: grid;
    gap: 6px;
    padding: 0 14px 14px;
  }

  .warning {
    border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
    border-radius: 6px;
    padding: 8px 10px;
    color: var(--danger-fg);
    background: color-mix(in srgb, var(--danger) 12%, transparent);
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
    box-shadow: var(--shadow);
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
    background: var(--bg);
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

  .frame.is-slide { grid-template-columns: minmax(0, 2.4fr) minmax(260px, 0.8fr); }
  .slide-surface { min-width: 0; }
  .slide-box {
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 8px;
    --vscode-editor-background: var(--panel);
    --vscode-editor-foreground: var(--text);
    --vscode-descriptionForeground: var(--muted);
    --vscode-editorWidget-background: var(--chrome);
    --vscode-editorWidget-border: var(--line);
    --vscode-textCodeBlock-background: var(--code-bg);
  }
  .slide-box .rt-slide { transform-origin: 0 0; }
  .beat-list { margin: 14px 0 0; padding-left: 20px; line-height: 1.45; }
  .beat-list li { margin: 0 0 6px; color: var(--muted); }
  .beat-list li.past { color: var(--text); opacity: 0.75; }
  .beat-list li.current { color: var(--text); font-weight: 700; }
  .beat-list li.current::marker { color: var(--accent); }
  .beat-list li.future { opacity: 0.45; }

  @media (max-width: 900px) {
    .topbar { grid-template-columns: 1fr; }
    .controls { justify-content: flex-start; }
    .tts-panel { position: static; width: auto; margin: 0 22px 14px; }
    .layout { grid-template-columns: 1fr; }
    .rail { border-right: none; border-bottom: 1px solid var(--line); }
    .stop-list { grid-auto-flow: column; grid-auto-columns: minmax(220px, 1fr); overflow-x: auto; }
    .frame, .frame.is-slide { grid-template-columns: 1fr; }
    .code-body { max-height: 54vh; }
  }

  @media (max-width: 600px) {
    .topbar { padding: 14px 16px 10px; }
    h1 { font-size: 20px; }
    .tts-panel { margin: 0 16px 14px; }
    .rail { padding: 10px 16px; }
    .stop-list { grid-auto-columns: minmax(200px, 1fr); }
    .frame { padding: 14px 16px; gap: 14px; }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 1ms !important; transition-duration: 1ms !important; }
  }
`;

const TTS_PANEL = `  <section id="ttsPanel" class="tts-panel" aria-label="Text to speech settings" hidden>
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
  </section>`;

function playerMarkup(hosted: boolean): string {
  return `<div id="app" class="app"${hosted ? " hidden" : ""}>
  <header class="topbar">
    <div>
      <div class="eyebrow">${hosted ? "RepoTrail tour" : "RepoTrail animated export"}</div>
      <h1 id="tourTitle"></h1>
      <div id="tourSummary" class="summary"></div>
    </div>
    <div class="controls">
      <button id="prevBtn" title="Previous stop">Back</button>
      <button id="nextBtn" title="Next stop">Next</button>
      <button id="speakBtn" title="Read the current stop aloud">Speak</button>
      ${hosted ? "" : '<button id="ttsSettingsBtn" class="secondary" title="Configure speech for this exported tour">TTS</button>'}
    </div>
  </header>
${hosted ? "" : TTS_PANEL}
  <div class="layout">
    <aside class="rail">
      <p id="railMeta" class="rail-meta"></p>
      <ol id="stopList" class="stop-list"></ol>
    </aside>
    <main class="stage">
      <div class="progress"><div id="progressFill" class="progress-fill"></div></div>
      <section id="frame" class="frame" aria-live="polite">
        <section id="slideSurface" class="slide-surface" hidden>
          <div id="slideBox" class="slide-box"></div>
        </section>
        <section id="codeSurface" class="code-surface">
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
            <ol id="beatList" class="beat-list" hidden></ol>
          </div>
          <div id="warnings" class="warnings"></div>
        </aside>
      </section>
    </main>
  </div>
</div>`;
}

const PLAYER_SCRIPT = `(() => {
  const data = JSON.parse(document.getElementById("tour-data").textContent || "{}");
  const defaultTts = data.ttsDefaults || { provider: "system" };
  const browserTtsProviders = Array.isArray(data.ttsProviders) ? data.ttsProviders : ["off", "system"];
  const frames = Array.isArray(data.frames) ? data.frames : [];
  const slides = window.RepoTrailSlides || null;
  let index = 0;
  let beat = 0; // position on a slide stop: 0 before any beat
  let slideView = null;
  let slideViewIndex = -1;

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
    if (frame.slide && slides && beat > 0) {
      return humanizeForSpeech(slides.narrationAt({ title: frame.title, explanation: frame.explanation, slide: frame.slide, actions: [] }, beat));
    }
    return humanizeForSpeech((frame.title || "") + ". " + (frame.explanation || ""));
  }

  function beatCount(frame) {
    return frame && frame.slide && slides ? slides.slideBeats(frame.slide).length : 0;
  }

  /** Mount the current slide at the current beat, scaled to the slide box. */
  function renderSlideFrame(frame) {
    const box = byId("slideBox");
    if (!box) return;
    const previous = slideView;
    const previousIndex = slideViewIndex;
    slideView = null;
    if (!previous) box.textContent = "";
    if (!slides) {
      box.textContent = "";
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "This export doesn't include the slide runtime.";
      box.appendChild(empty);
      return;
    }
    slideView = new slides.SlideView({
      title: frame.title || "",
      slide: frame.slide,
      index: index,
      total: frames.length,
      source: frame.location || undefined,
      position: beat,
      motion: "full",
      captions: true,
    });
    slideViewIndex = index;
    // The new slide goes underneath so the old one can fade out over it, and
    // nodes both slides share glide to their new places.
    if (previous) box.insertBefore(slideView.root, previous.root);
    else box.appendChild(slideView.root);
    slideView.mount();
    placeSlide();
    if (previous) {
      previous.dispose();
      const fade = Math.abs(previousIndex - index) === 1 ? slideView.morphFrom(previous, "full") : 0;
      const outgoing = previous.root;
      const animation = fade && outgoing.animate ? outgoing.animate([{ opacity: 1 }, { opacity: 0 }], { duration: fade }) : null;
      if (animation) animation.onfinish = () => outgoing.remove();
      else outgoing.remove();
    }
  }

  function placeSlide() {
    const box = byId("slideBox");
    if (!box || !slides) return;
    box.querySelectorAll(".rt-slide").forEach((root) => {
      root.style.transform = "scale(" + box.clientWidth / slides.SLIDE_WIDTH + ")";
    });
  }

  function renderBeats(frame) {
    const list = byId("beatList");
    if (!list) return;
    list.textContent = "";
    const beats = frame && frame.slide && slides ? slides.slideBeats(frame.slide) : [];
    list.hidden = !beats.some((b) => b.say);
    beats.forEach((b, i) => {
      if (!b.say) return;
      const li = document.createElement("li");
      li.value = i + 1;
      li.className = i + 1 < beat ? "past" : i + 1 === beat ? "current" : "future";
      li.textContent = b.say;
      list.appendChild(li);
    });
    const count = beatCount(frame);
    setText("stepCount", (index + 1) + " / " + frames.length + (count ? " · beat " + beat + " / " + count : ""));
  }

  function writeHash() {
    const hash = "#stop=" + (index + 1) + (beat ? "&beat=" + beat : "");
    // Sandboxed frames (an Artifact page) may refuse history changes.
    try { if (location.hash !== hash) history.replaceState(null, "", hash); } catch (e) {}
  }

  function readHash() {
    const stop = /stop=([0-9]+)/.exec(location.hash);
    const b = /beat=([0-9]+)/.exec(location.hash);
    return { stop: stop ? Number(stop[1]) - 1 : 0, beat: b ? Number(b[1]) : 0 };
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
      if (row.type === "gap") {
        const gap = document.createElement("div");
        gap.className = "diff-gap";
        gap.textContent = "⋯ " + (row.label || row.skipped + " unchanged line" + (row.skipped === 1 ? "" : "s"));
        wrap.appendChild(gap);
        return;
      }
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
    const isSlide = Boolean(frame.slide);
    if (frameEl) frameEl.classList.toggle("is-slide", isSlide);
    const slideSurface = byId("slideSurface");
    const codeSurface = byId("codeSurface");
    if (slideSurface) slideSurface.hidden = !isSlide;
    if (codeSurface) codeSurface.hidden = isSlide;
    if (isSlide) renderSlideFrame(frame);
    else {
      if (slideView) slideView.dispose();
      slideView = null;
      slideViewIndex = -1;
      const box = byId("slideBox");
      if (box) box.textContent = "";
      renderCode(frame);
    }
    renderBeats(frame);
    renderWarnings(frame);
    writeHash();
    if (frameEl) {
      frameEl.classList.remove("is-entering");
      void frameEl.offsetWidth;
      frameEl.classList.add("is-entering");
    }
  }

  function go(next, nextBeat = 0) {
    if (!frames.length) return;
    stopSpeech(true);
    index = Math.max(0, Math.min(frames.length - 1, next));
    beat = Math.max(0, Math.min(beatCount(frames[index]), nextBeat));
    render();
  }

  /** Move to a beat of the slide on screen; forward one beat animates. */
  function setBeat(next) {
    const animate = next === beat + 1;
    stopSpeech(true);
    beat = next;
    if (slideView) slideView.goTo(beat, { animate: animate, motion: "full" });
    renderBeats(frames[index]);
    writeHash();
  }

  // Next steps through a slide's beats before the next stop; Back from a
  // slide's first beat shows the previous slide finished, as in VS Code.
  function forward() {
    if (beat < beatCount(frames[index])) setBeat(beat + 1);
    else if (index < frames.length - 1) go(index + 1, 0);
  }

  function backward() {
    if (beat > 0) setBeat(beat - 1);
    else if (index > 0) go(index - 1, beatCount(frames[index - 1]));
  }

  byId("prevBtn")?.addEventListener("click", backward);
  byId("nextBtn")?.addEventListener("click", forward);
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
    const target = event.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
    if (event.key === "ArrowLeft" || event.key === "PageUp") backward();
    if (event.key === "ArrowRight" || event.key === "PageDown") forward();
  });
  window.addEventListener("hashchange", () => {
    const target = readHash();
    if (target.stop !== index || target.beat !== beat) go(target.stop, target.beat);
  });
  window.addEventListener("resize", placeSlide);
  syncTtsForm();
  const start = readHash();
  index = Math.max(0, Math.min(frames.length - 1, start.stop));
  beat = Math.max(0, Math.min(beatCount(frames[index]), start.beat));
  render();
})();`;


/** Line-by-line LCS alignment; the table is (before + 1) × (after + 1) cells. */
function diffRows(before: string[], after: string[]): AnimatedTourDiffRow[] {
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);
  const at = (i: number, j: number) => table[i * width + j];
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i * width + j] = before[i] === after[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
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
    } else if (j < after.length && (i >= before.length || at(i, j + 1) >= at(i + 1, j))) {
      rows.push({ after: after[j], type: "insert" });
      j++;
    } else if (i < before.length) {
      rows.push({ before: before[i], type: "delete" });
      i++;
    }
  }
  return rows;
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
