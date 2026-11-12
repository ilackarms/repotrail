/**
 * A tour as one static page: HTML and inline SVG, no script. `render
 * --artifact` writes it for readers without VS Code, usually to publish as a
 * Claude Artifact. Every stop is a section on one scrolling page, with a
 * contents list at the top; links move between stops.
 *
 * Pure. The caller builds the frames (code read from disk, diffs from git)
 * and passes slides.css when the tour has slides.
 */

import type { AnimatedTourCodeFrame, AnimatedTourDiffFrame, AnimatedTourFrame } from "./animatedHtml";
import { renderNarrationMarkdown } from "./narrationMarkdown";
import { THEME_CSS } from "./pageTheme";
import { renderStaticSlide } from "./slides/staticSlide";
import { slideBeats } from "./slides/timeline";
import type { TourPlan } from "./types";

export interface StaticTourHtmlInput {
  plan: TourPlan;
  exportedAt: string;
  frames: AnimatedTourFrame[];
  /** The slide stylesheet (out/slides.css), needed when the tour has slides. */
  slidesCss?: string;
}

export function planToStaticHtml(input: StaticTourHtmlInput): string {
  const { plan, frames } = input;
  const title = plan.title || "RepoTrail tour";
  const hasSlides = frames.some((frame) => frame.slide);
  const slidesCss = hasSlides && input.slidesCss ? input.slidesCss.replace(/\/\*# sourceMappingURL=\S* \*\/\s*$/, "") : "";
  const date = /^\d{4}-\d{2}-\d{2}/.exec(input.exportedAt)?.[0] ?? input.exportedAt;
  const meta = [plan.kind, `${frames.length} stop${frames.length === 1 ? "" : "s"}`, date ? `rendered ${date}` : ""].filter(Boolean);

  const contents = frames
    .map(
      (frame, i) =>
        `<li><a href="#stop-${i + 1}"><span class="num">${pad(i + 1)}</span><span class="toc-title">${esc(frame.title || "Untitled stop")}</span>` +
        `<span class="toc-loc">${esc(frame.location)}</span></a></li>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:,">
<title>${esc(title)}</title>
${slidesCss ? `<style>\n${slidesCss.replace(/<\/style/gi, "<\\/style")}\n</style>\n` : ""}<style>${STATIC_CSS}${hasSlides ? SLIDE_CSS : ""}</style>
</head>
<body>
<div class="page">
<header class="page-head" id="top">
  <div class="eyebrow">RepoTrail tour</div>
  <h1>${esc(title)}</h1>
  ${plan.summary ? `<div class="summary md">${renderNarrationMarkdown(plan.summary)}</div>` : ""}
  <p class="meta">${esc(meta.join(" · "))}</p>
</header>
<nav class="toc" aria-label="Stops">
<ol>
${contents}
</ol>
</nav>
<main>
${frames.map((frame, i) => renderStop(frame, i, frames.length)).join("\n")}
</main>
<footer class="page-foot">Made with RepoTrail. Code and diffs are a snapshot from when the tour was rendered.</footer>
</div>
</body>
</html>
`;
}

function renderStop(frame: AnimatedTourFrame, index: number, total: number): string {
  const kind = frame.slide ? "Slide" : frame.diff ? "Diff" : frame.code ? "Code" : frame.viewLabel || "Stop";
  const narration = frame.explanation ? `<div class="narration md">${renderNarrationMarkdown(frame.explanation)}</div>` : "";
  let body: string;
  if (frame.slide) {
    const beats = slideBeats(frame.slide).flatMap((beat, i) => (beat.say ? [`<li value="${i + 1}">${inlineMarkdown(beat.say)}</li>`] : []));
    body =
      `<div class="slide-frame">${renderStaticSlide({ title: frame.title, slide: frame.slide, index, total, source: frame.location })}</div>` +
      narration +
      (beats.length ? `<ol class="beats" aria-label="Beats">${beats.join("")}</ol>` : "");
  } else {
    const view = frame.diff ? renderDiff(frame.diff) : frame.code ? renderCode(frame.code) : `<p class="empty">No code snapshot was available for this stop.</p>`;
    body = narration + view;
  }
  const warnings = frame.warnings.length ? `<div class="warnings">${frame.warnings.map((w) => `<p class="warning">${esc(w)}</p>`).join("")}</div>` : "";
  const links = [
    index > 0 ? `<a href="#stop-${index}">← Previous</a>` : "",
    `<a href="#top">Contents</a>`,
    index < total - 1 ? `<a href="#stop-${index + 2}">Next →</a>` : "",
  ].filter(Boolean);
  return `<section class="stop" id="stop-${index + 1}">
<div class="stop-head"><span class="num">${pad(index + 1)}</span><h2>${esc(frame.title || "Untitled stop")}</h2><span class="pill">${kind}</span></div>
${frame.location ? `<div class="location">${esc(frame.location)}</div>` : ""}
${body}
${warnings}<nav class="stop-nav">${links.join("")}</nav>
</section>`;
}

function renderCode(code: AnimatedTourCodeFrame): string {
  if (!code.text) return `<p class="empty">No code snapshot was available for this stop.</p>`;
  const start = code.startLine || 1;
  const lines = code.text.split(/\r?\n/).map((line, i) => {
    const n = start + i;
    const hl = code.highlightStartLine !== undefined && code.highlightEndLine !== undefined && n >= code.highlightStartLine && n <= code.highlightEndLine;
    return `<div class="line${hl ? " hl" : ""}"><span class="ln">${n}</span><span class="tx">${esc(line) || " "}</span></div>`;
  });
  return `<div class="code"><div class="lines">\n${lines.join("\n")}\n</div></div>`;
}

function renderDiff(diff: AnimatedTourDiffFrame): string {
  const rows = diff.rows.map((row) => {
    if (row.type === "gap") {
      const skipped = row.skipped ?? 0;
      return `<div class="gap">⋯ ${esc(row.label ?? `${skipped} unchanged line${skipped === 1 ? "" : "s"}`)}</div>`;
    }
    const before = row.type === "insert" ? cell("before empty", "", "") : cell(`before${row.type === "delete" ? " delete" : ""}`, row.type === "delete" ? "−" : "", row.before ?? "");
    const after = row.type === "delete" ? cell("after empty", "", "") : cell(`after${row.type === "insert" ? " insert" : ""}`, row.type === "insert" ? "+" : "", row.after ?? "");
    return `<div class="row ${row.type}">${before}${after}</div>`;
  });
  return (
    `<div class="diff"><div class="diff-head"><span>${esc(diff.beforeLabel)}</span><span>${esc(diff.afterLabel)}</span></div>\n` +
    `${rows.join("\n")}\n</div>`
  );
}

function cell(className: string, mark: string, text: string): string {
  return `<div class="cell ${className}"><span class="mark">${mark}</span><span class="dx">${esc(text) || " "}</span></div>`;
}

/** Markdown for one line, without the paragraph wrapper. */
function inlineMarkdown(text: string): string {
  const html = renderNarrationMarkdown(text);
  const single = /^<p>([\s\S]*)<\/p>$/.exec(html);
  return single && !single[1].includes("<p>") ? single[1] : html;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const MONO = `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace`;

const STATIC_CSS = `${THEME_CSS}
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1.5;
  }
  a { color: var(--accent); }
  .page { max-width: 1040px; margin: 0 auto; padding: 32px 24px 64px; }

  .eyebrow { color: var(--accent-2); font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
  h1 { margin: 4px 0 10px; font-size: 30px; line-height: 1.15; }
  .summary { color: var(--text-soft); max-width: 760px; }
  h1, .md, .beats, .stop-head h2, .toc-title { overflow-wrap: anywhere; }
  .meta { margin: 10px 0 0; color: var(--muted); font-size: 13px; }

  .md p { margin: 0 0 0.7em; }
  .md p:last-child { margin-bottom: 0; }
  .md ul, .md ol { margin: 0 0 0.7em; padding-left: 1.4em; }
  .md .md-heading { font-weight: 700; }
  .md code, .beats code { font-family: ${MONO}; font-size: 0.88em; background: var(--panel-2); border-radius: 4px; padding: 0.05em 0.3em; }
  .md pre, .beats pre { margin: 0 0 0.7em; background: var(--code-bg); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; overflow-x: auto; overflow-wrap: normal; }
  .md pre code, .beats pre code { background: none; padding: 0; }

  .toc { margin: 24px 0 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 10px; }
  .toc ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  .toc a { display: grid; grid-template-columns: 2.4em minmax(0, 1fr); column-gap: 6px; padding: 6px 8px; border-radius: 6px; color: var(--text); text-decoration: none; }
  .toc a:hover, .toc a:focus-visible { background: var(--panel-2); }
  .num { color: var(--accent-2); font-variant-numeric: tabular-nums; font-weight: 700; }
  .toc-loc { grid-column: 2; color: var(--muted); font: 12px ${MONO}; overflow-wrap: anywhere; }

  .stop { border-top: 1px solid var(--line); padding: 28px 0 8px; margin-top: 20px; scroll-margin-top: 8px; }
  .stop-head { display: flex; align-items: baseline; gap: 10px; }
  .stop-head h2 { margin: 0; font-size: 22px; line-height: 1.2; flex: 1 1 auto; min-width: 0; }
  .pill { flex: none; border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; color: var(--accent-2); font-size: 11px; font-weight: 700; text-transform: uppercase; }
  .location { margin: 4px 0 14px; color: var(--muted); font: 12px ${MONO}; overflow-wrap: anywhere; }
  .narration { margin: 0 0 16px; max-width: 760px; }

  .code, .diff { border: 1px solid var(--line); border-radius: 8px; background: var(--code-bg); overflow-x: auto; font: 12.5px/1.55 ${MONO}; tab-size: 2; }
  .lines { display: inline-block; min-width: 100%; padding: 6px 0; }
  .line { display: flex; }
  .line.hl { background: var(--code-hi); box-shadow: inset 3px 0 0 var(--accent); }
  .ln { flex: none; position: sticky; left: 0; width: 4em; padding-right: 12px; text-align: right; color: var(--gutter-fg); background: var(--gutter-bg); user-select: none; }
  .line.hl .ln { color: var(--text); }
  .tx { white-space: pre; padding: 0 16px 0 12px; }

  .diff-head { display: grid; grid-template-columns: 1fr 1fr; background: var(--gutter-bg); border-bottom: 1px solid var(--line); color: var(--muted); font-weight: 700; font-size: 12px; }
  .diff-head span { padding: 6px 12px; overflow-wrap: anywhere; }
  .diff-head span:first-child { border-right: 1px solid var(--line); }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .cell { display: grid; grid-template-columns: 22px minmax(0, 1fr); border-bottom: 1px solid var(--rule); min-width: 0; }
  .cell.before { border-right: 1px solid var(--line); }
  .mark { text-align: center; color: var(--gutter-fg); background: var(--gutter-bg); user-select: none; }
  .dx { padding: 1px 10px; white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
  .cell.delete .dx { background: var(--delete-bg); }
  .cell.insert .dx { background: var(--insert-bg); }
  .gap { padding: 3px 12px; background: var(--gutter-bg); color: var(--muted); font-size: 11px; border-bottom: 1px solid var(--line); }

  .beats { margin: 0 0 16px; padding-left: 1.6em; color: var(--text-soft); max-width: 760px; }
  .beats li { margin: 0 0 6px; }
  .beats li::marker { color: var(--accent); font-weight: 700; }
  .warnings { display: grid; gap: 6px; margin: 12px 0 0; }
  .warning { margin: 0; border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); border-radius: 6px; padding: 8px 10px; color: var(--danger-fg); background: color-mix(in srgb, var(--danger) 12%, transparent); font-size: 12px; }
  .empty { color: var(--muted); }
  .stop-nav { display: flex; flex-wrap: wrap; gap: 16px; margin: 14px 0 0; font-size: 13px; }
  .page-foot { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }

  @media (max-width: 700px) {
    .page { padding: 20px 16px 48px; }
    h1 { font-size: 24px; }
    .stop-head h2 { font-size: 19px; }
    .diff-head { grid-template-columns: 1fr; }
    .diff-head span:first-child { border-right: none; border-bottom: 1px solid var(--line); }
    .row { grid-template-columns: minmax(0, 1fr); }
    .row.equal .cell.before, .cell.empty { display: none; }
    .cell.before { border-right: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
  }
`;

const DARK_CHARTS = [
  "--vscode-charts-blue: #3794ff;",
  "--vscode-charts-green: #89d185;",
  "--vscode-charts-yellow: #cca700;",
  "--vscode-charts-red: #f14c4c;",
  "--vscode-charts-purple: #b180d7;",
  "--vscode-charts-orange: #d18616;",
].join(" ");

/** Slide styles on top of slides.css, for tours with slides. */
const SLIDE_CSS = `
  .slide-frame {
    margin: 0 0 16px;
    border: 1px solid var(--line);
    border-radius: 8px;
    overflow: hidden;
    --vscode-editor-background: var(--panel);
    --vscode-editor-foreground: var(--text);
    --vscode-descriptionForeground: var(--muted);
    --vscode-editorWidget-background: var(--chrome);
    --vscode-editorWidget-border: var(--line);
    --vscode-textCodeBlock-background: var(--code-bg);
    /* Tones readable on the light theme; the dark theme keeps slides.css's. */
    --vscode-charts-blue: #1668c9;
    --vscode-charts-green: #2b7d36;
    --vscode-charts-yellow: #8a6a00;
    --vscode-charts-red: #c2342c;
    --vscode-charts-purple: #7445ad;
    --vscode-charts-orange: #ad5600;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) .slide-frame { ${DARK_CHARTS} }
  }
  :root[data-theme="dark"] .slide-frame { ${DARK_CHARTS} }
  .rt-slide.rt-static { position: relative; width: 100%; height: auto; padding: 28px 32px 18px; overflow: visible; --fit: 0.85; }
  .rt-static .rt-title { font-size: 28px; }
  .rt-static :is(.rt-title, .rt-subtitle, .rt-md) { overflow-wrap: anywhere; }
  .rt-static .rt-subtitle { font-size: 17px; }
  .rt-static.layout-title { padding-top: 48px; }
  .rt-static.layout-title .rt-title { font-size: 38px; }
  .rt-static.layout-title .rt-subtitle { font-size: 20px; }
  .rt-static .rt-body, .rt-static .rt-column, .rt-static .rt-block { flex: none; min-height: 0; }
  .rt-static.layout-columns .rt-body > .rt-column { flex-basis: 0; }
  .rt-static :is(.rt-block-flow, .rt-block-sequence) { display: block; min-height: 0; }
  .rt-static .rt-flow-host { display: block; }
  .rt-static .rt-flow-svg { width: 100%; height: auto; margin: 0 auto; }
  .rt-static .rt-code { overflow-x: auto; }
  .rt-static .rt-tx { overflow: visible; text-overflow: clip; }
  .rt-static .rt-table-wrap { overflow-x: auto; }
  .rt-static .rt-footer { position: static; margin-top: 18px; }
  .rt-static .rt-position { flex: none; white-space: nowrap; }
  .rt-static .rt-warnings { position: static; max-width: none; margin-top: 10px; }
  .rt-static [data-id], .rt-static [data-for] { transition: none; }

  @media (max-width: 700px) {
    .rt-slide.rt-static { padding: 18px 16px 14px; --fit: 0.78; }
    .rt-static .rt-title { font-size: 21px; }
    .rt-static.layout-title .rt-title { font-size: 26px; }
    .rt-static.layout-columns .rt-body { flex-direction: column; gap: 20px; }
    .rt-static.layout-columns .rt-body > .rt-column { flex-basis: auto; }
    /* Wide diagrams keep a readable size and scroll inside their slide. */
    .rt-static .rt-flow-host { overflow-x: auto; }
    .rt-static .rt-flow-svg { width: min(var(--w), 620px); max-width: none !important; }
  }
`;
