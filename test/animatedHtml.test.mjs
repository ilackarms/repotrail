import assert from "node:assert/strict";
import { test } from "node:test";
import { planToAnimatedHtml } from "../out-test/engine/animatedHtml.js";

test("emits parseable browser code with centralized TTS defaults", () => {
  const html = planToAnimatedHtml({
    plan: {
      kind: "architecture",
      title: "Settings tour",
      summary: "",
      steps: [],
    },
    exportedAt: "2026-09-02T00:00:00.000Z",
    frames: [],
  });

  const script = html.match(/<script>\n([\s\S]*?)\n<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /const defaultTts = \{"provider":"system"/);
  assert.match(script, /const browserTtsProviders = \["off","kokoro","system","elevenlabs","openai"\]/);
});

test("inlines the slide runtime safely and plays slide frames with deep links", async () => {
  const { planToAnimatedHtml: toHtml } = await import("../out-test/engine/animatedHtml.js");
  const slide = { layout: "stack", blocks: [{ type: "text", id: "b1", md: "hi" }] };
  const html = toHtml({
    plan: { kind: "design-review", title: "Deck", summary: "", steps: [{ title: "S", explanation: "", actions: [], slide }] },
    exportedAt: "now",
    frames: [{ index: 0, title: "S", location: "Slide", explanation: "", viewLabel: "Slide", slide, warnings: [] }],
    slideRuntime: { script: 'window.RepoTrailSlides = {}; const s = "</script><b>";', css: ".rt-slide { color: red } </style>" },
  });
  assert.equal(html.includes('"</script><b>"'), false);
  assert.ok(html.includes('"<\\/script><b>"'));
  assert.ok(html.includes("<\\/style>"));
  assert.ok(html.includes("/stop=([0-9]+)/.exec(location.hash)"));
  assert.ok(html.includes('"slide":{"layout":"stack"'));
});

test("code snapshots keep the range plus context", async () => {
  const { codeFrameFromLines } = await import("../out-test/engine/animatedHtml.js");
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
  const { frame, warnings } = codeFrameFromLines(lines, { startLine: 50, startColumn: 1, endLine: 52, endColumn: 1 }, "rust");
  assert.equal(frame.startLine, 48);
  assert.equal(frame.text.split("\n").length, 7);
  assert.equal(frame.highlightStartLine, 50);
  assert.equal(frame.highlightEndLine, 52);
  assert.deepEqual(warnings, ["Code snapshot was trimmed around the tour range."]);
  assert.deepEqual(codeFrameFromLines([], undefined, "md").frame, { text: "", startLine: 1, languageId: "md" });
});
