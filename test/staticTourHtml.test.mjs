import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { planToStaticHtml } from "../out-test/engine/staticTourHtml.js";
import { estimateTextWidth, renderStaticSlide } from "../out-test/engine/slides/staticSlide.js";
import { parseTourJson } from "../out-test/engine/tourSerialize.js";

const codeFrame = {
  index: 0,
  title: "Entry <point>",
  location: "src/main.ts:2-3",
  explanation: "Starts **here**. <script>alert(1)</script>",
  viewLabel: "Code",
  code: { text: "a\nb\nc\nd", startLine: 1, highlightStartLine: 2, highlightEndLine: 3 },
  warnings: ["Couldn't read <x>."],
};

const diffFrame = {
  index: 1,
  title: "Change",
  location: "src/main.ts:5",
  explanation: "",
  viewLabel: "Diff",
  diff: {
    beforeLabel: "base",
    afterLabel: "head",
    beforeText: "",
    afterText: "",
    rows: [
      { type: "gap", skipped: 3 },
      { before: "x", after: "x", type: "equal" },
      { before: "old", type: "delete" },
      { after: "new", type: "insert" },
      { type: "gap", skipped: 9, label: "more changes below" },
    ],
  },
  warnings: [],
};

test("a static page has no script and escapes tour text", () => {
  const html = planToStaticHtml({
    plan: { kind: "pr-diff", title: "PR </title><b>", summary: "Why it _matters_.", steps: [] },
    exportedAt: "2026-11-12T10:00:00.000Z",
    frames: [codeFrame, diffFrame],
  });
  assert.equal(/<script/i.test(html), false);
  assert.ok(html.includes("<title>PR &lt;/title&gt;&lt;b&gt;</title>"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("<strong>here</strong>"), "narration renders as markdown");
  assert.ok(html.includes("<em>matters</em>"));
  assert.ok(html.includes("pr-diff · 2 stops · rendered 2026-11-12"));
  assert.ok(html.includes('<a href="#stop-2"><span class="num">02</span>'), "the contents list links every stop");
  assert.ok(html.includes('id="stop-1"') && html.includes('id="stop-2"'));
  assert.ok(html.includes('<a href="#stop-2">Next →</a>'));
  assert.ok(html.includes("Couldn&#39;t read &lt;x&gt;.") || html.includes("Couldn't read &lt;x&gt;."));
  assert.equal(html.includes("rt-slide"), false, "no slide styles without slides");
});

test("code stops highlight their range and diffs show gaps and both sides", () => {
  const html = planToStaticHtml({ plan: { kind: "pr-diff", title: "T", summary: "", steps: [] }, exportedAt: "now", frames: [codeFrame, diffFrame] });
  assert.equal((html.match(/class="line hl"/g) ?? []).length, 2);
  assert.ok(html.includes('<span class="ln">1</span>'));
  assert.ok(html.includes("⋯ 3 unchanged lines"));
  assert.ok(html.includes("⋯ more changes below"));
  assert.ok(html.includes('<div class="row delete"><div class="cell before delete"><span class="mark">−</span><span class="dx">old</span></div><div class="cell after empty">'));
  assert.ok(html.includes('<div class="row insert"><div class="cell before empty">'));
  assert.ok(html.includes("<span>base</span><span>head</span>"));
});

test("a slide stop draws its slide after the last beat and lists the beats", () => {
  const tour = JSON.parse(readFileSync(new URL("./fixtures/slides-morph.json", import.meta.url), "utf8"));
  const plan = parseTourJson(JSON.stringify(tour));
  assert.ok(plan);
  const frames = plan.steps.map((step, index) => ({
    index,
    title: step.title,
    location: "deck",
    explanation: step.explanation,
    viewLabel: "Slide",
    slide: step.slide,
    warnings: [],
  }));
  const html = planToStaticHtml({ plan, exportedAt: "now", frames, slidesCss: ".rt-slide { color: red }\n/*# sourceMappingURL=slides.css.map */\n" });
  assert.equal(/<script/i.test(html), false);
  assert.ok(html.includes(".rt-slide { color: red }"));
  assert.equal(html.includes("sourceMappingURL"), false);
  assert.ok(html.includes('<svg class="rt-flow-svg"'));
  assert.ok(html.includes("rt-slide rt-static"));
  // Arrow markers are unique per diagram on the page.
  const ids = [...html.matchAll(/<marker id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 0);
  assert.equal(new Set(ids).size, ids.length);
});

test("a static slide applies its beats' final state", () => {
  const slide = {
    layout: "stack",
    blocks: [
      {
        type: "flow",
        id: "f",
        direction: "LR",
        nodes: [
          { id: "a", label: "Alpha", shape: "box" },
          { id: "b", label: "Beta", shape: "box" },
        ],
        edges: [{ id: "a->b", from: "a", to: "b", arrow: "end" }],
        groups: [],
      },
      { type: "bullets", id: "list", items: [{ id: "one", text: "One" }, { id: "two", text: "Two" }] },
    ],
    beats: [
      { show: ["b"], say: "Beta appears." },
      { set: { a: { label: "Alpha 2", tone: "good" } }, hide: ["two"], say: "Alpha changes." },
    ],
  };
  const html = renderStaticSlide({ title: "Final <state>", slide, index: 0, total: 1 });
  assert.ok(html.includes("Final &lt;state&gt;"));
  assert.ok(html.includes(">Alpha 2<"), "set patches apply");
  assert.ok(/class="rt-node shape-box tone-good toned" data-id="a"/.test(html));
  assert.ok(/class="rt-node shape-box" data-id="b"/.test(html), "shown nodes are visible");
  assert.ok(/<li class="rt-hidden" data-id="two">/.test(html), "hidden at the end stays hidden");
});

test("estimated text widths grow with length and weight", () => {
  assert.ok(estimateTextWidth("MMMM", "label") > estimateTextWidth("iiii", "label"));
  assert.ok(estimateTextWidth("Database", "label") > estimateTextWidth("Database", "sub"));
  assert.ok(estimateTextWidth("Database", "label") > 60 && estimateTextWidth("Database", "label") < 90);
});
