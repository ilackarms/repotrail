// Render every slide stop of a tour into one standalone HTML page, using the
// same runtime as the Slides panel. For checking slide visuals without VS Code.
//
//   pnpm compile && node scripts/preview-slides.mjs <tour.json> [out.html]
//
// Open the page with #dark or #light to pick the theme.

import { build } from "esbuild";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const [tourPath, outPath = "out/slides-preview.html"] = process.argv.slice(2);
if (!tourPath) {
  console.error("usage: node scripts/preview-slides.mjs <tour.json> [out.html]");
  process.exit(1);
}

// Parse the tour with the extension's own reader, so warnings match.
const dir = await mkdtemp(path.join(tmpdir(), "repotrail-preview-"));
const serializer = path.join(dir, "tourSerialize.cjs");
await build({
  entryPoints: ["src/engine/tourSerialize.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: serializer,
  logLevel: "silent",
});
const { parseTourJson } = createRequire(import.meta.url)(serializer);
await rm(dir, { recursive: true, force: true });

const plan = parseTourJson(await readFile(tourPath, "utf8"));
if (!plan) {
  console.error(`${tourPath} isn't a RepoTrail tour`);
  process.exit(1);
}

const payloads = plan.steps.flatMap((step, index) => {
  if (!step.slide) return [];
  let source;
  if (step.file) {
    source = `${step.root ? `${step.root}/` : ""}${step.file}`;
    if (step.range) source += step.range.startLine === step.range.endLine ? `:${step.range.startLine}` : `:${step.range.startLine}-${step.range.endLine}`;
  }
  return [{ title: step.title, slide: step.slide, index, total: plan.steps.length, source, position: 0, motion: "full", captions: true }];
});

const [runtime, css] = await Promise.all([readFile("out/slides.js", "utf8"), readFile("out/slides.css", "utf8")]);
const data = JSON.stringify(payloads).replace(/</g, "\\u003c");

// Theme colors from VS Code's Dark Modern and Light Modern themes.
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(plan.title)} · slides preview</title>
<style>${css}</style>
<style>
  body.theme-dark {
    --vscode-editor-background: #1f1f1f; --vscode-editor-foreground: #cccccc;
    --vscode-descriptionForeground: #9d9d9d; --vscode-editorWidget-background: #202020;
    --vscode-editorWidget-border: #313131; --vscode-textCodeBlock-background: #2b2b2b;
    --vscode-charts-blue: #3794ff; --vscode-charts-green: #89d185; --vscode-charts-yellow: #cca700;
    --vscode-charts-red: #f14c4c; --vscode-charts-purple: #b180d7; --vscode-charts-orange: #d18616;
  }
  body.theme-light {
    --vscode-editor-background: #ffffff; --vscode-editor-foreground: #3b3b3b;
    --vscode-descriptionForeground: #6f6f6f; --vscode-editorWidget-background: #f8f8f8;
    --vscode-editorWidget-border: #e5e5e5; --vscode-textCodeBlock-background: #f2f2f2;
    --vscode-charts-blue: #1a85ff; --vscode-charts-green: #388a34; --vscode-charts-yellow: #bf8803;
    --vscode-charts-red: #e51400; --vscode-charts-purple: #652d90; --vscode-charts-orange: #d18616;
  }
  html, body { height: auto; overflow: auto; }
  body { padding: 16px 0 40px; background: #888; }
  .frame { position: relative; width: 1280px; height: 720px; margin: 0 auto 28px; overflow: hidden; }
  .caption { width: 1280px; margin: 0 auto 6px; font: 12px ui-monospace, Menlo, monospace; color: #111; display: flex; gap: 8px; align-items: center; }
  .caption button { font: inherit; padding: 1px 8px; }
</style>
</head>
<body>
<div id="frames"></div>
<script>${runtime}</script>
<script>
  const payloads = ${data};
  // ?pos=last starts every slide on its final beat; window.views drives them from scripts.
  const startLast = new URLSearchParams(location.search).get("pos") === "last";
  window.views = [];
  function draw() {
    const theme = location.hash === "#light" ? "light" : "dark";
    document.body.className = "theme-" + theme;
    const root = document.getElementById("frames");
    root.replaceChildren();
    window.views = [];
    for (const payload of payloads) {
      const caption = document.createElement("div");
      caption.className = "caption";
      const frame = document.createElement("div");
      frame.className = "frame";
      frame.id = "stop-" + (payload.index + 1);
      root.append(caption, frame);
      const view = new RepoTrailSlides.SlideView({ ...payload, position: startLast ? 999 : 0 });
      frame.append(view.root);
      view.mount();
      window.views.push(view);
      const label = document.createElement("span");
      const back = document.createElement("button");
      const next = document.createElement("button");
      back.textContent = "◀";
      next.textContent = "▶";
      const beats = view.root.querySelectorAll(".rt-dots i").length - 1;
      const update = () => (label.textContent = "stop " + (payload.index + 1) + " · " + payload.slide.layout + " · beat " + view.position + " / " + Math.max(0, beats) + " · " + theme);
      back.onclick = () => { view.goTo(view.position - 1, { animate: false, motion: "full" }); update(); };
      next.onclick = () => { view.goTo(view.position + 1, { animate: true, motion: "full" }); update(); };
      caption.append(back, next, label);
      update();
    }
  }
  window.addEventListener("hashchange", draw);
  draw();
</script>
</body>
</html>
`;

await writeFile(outPath, html);
console.log(`wrote ${outPath}: ${payloads.length} slide${payloads.length === 1 ? "" : "s"} of ${plan.steps.length} stops`);

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
