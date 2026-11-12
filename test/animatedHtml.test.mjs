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
  assert.match(script, /const defaultTts = data\.ttsDefaults/);
  assert.ok(html.includes('"ttsDefaults":{"provider":"system"'));
  assert.ok(html.includes('"ttsProviders":["off","kokoro","system","elevenlabs","openai"]'));
  assert.ok(html.includes('id="ttsPanel"'));
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

test("diff snapshots fold unchanged lines so a change deep in a file shows", async () => {
  const { buildAnimatedDiffFrame } = await import("../out-test/engine/animatedHtml.js");
  const before = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`);
  const after = before.slice();
  after[499] = "changed 500";
  const frame = buildAnimatedDiffFrame({ beforeText: before.join("\n"), afterText: after.join("\n") });
  assert.equal(frame.truncated, false);
  assert.deepEqual(frame.rows[0], { type: "gap", skipped: 495 });
  assert.ok(frame.rows.some((row) => row.type === "insert" && row.after === "changed 500"));
  assert.ok(frame.rows.some((row) => row.type === "delete" && row.before === "line 500"));
  assert.deepEqual(frame.rows.at(-1), { type: "gap", skipped: 496 });
  assert.equal(frame.rows.length, 1 + 4 + 2 + 4 + 1);
});

test("diff snapshots center on the stop's range when given one", async () => {
  const { buildAnimatedDiffFrame } = await import("../out-test/engine/animatedHtml.js");
  const before = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`);
  const after = before.slice();
  after[99] = "changed 100";
  after[899] = "changed 900";
  const frame = buildAnimatedDiffFrame({
    beforeText: before.join("\n"),
    afterText: after.join("\n"),
    focus: { startLine: 898, endLine: 902 },
  });
  assert.equal(frame.rows[0].type, "gap");
  assert.equal(frame.rows[0].label, "more changes above");
  assert.ok(frame.rows.some((row) => row.after === "changed 900"));
  assert.equal(frame.rows.some((row) => row.after === "changed 100"), false);
  assert.equal(frame.rows.at(-1).type, "gap");
  assert.equal(frame.rows.at(-1).label, undefined, "nothing changed below");

  // A stop on a rewritten hunk keeps every deleted line, then context after it.
  const old40 = Array.from({ length: 40 }, (_, i) => `l${i + 1}`);
  const rewritten = [...old40.slice(0, 10), ...Array.from({ length: 10 }, (_, i) => `new${i + 1}`), ...old40.slice(20)];
  const hunk = buildAnimatedDiffFrame({ beforeText: old40.join("\n"), afterText: rewritten.join("\n"), focus: { startLine: 11, endLine: 20 } });
  assert.equal(hunk.rows.filter((row) => row.type === "delete").length, 10);
  assert.equal(hunk.rows.filter((row) => row.type === "insert").length, 10);
  assert.deepEqual(hunk.rows.slice(-5).map((row) => row.type), ["equal", "equal", "equal", "equal", "gap"]);
  assert.equal(hunk.rows.at(-1).label, undefined);

  const unfocused = buildAnimatedDiffFrame({ beforeText: "a\nb", afterText: "a\nb", focus: { startLine: 50, endLine: 60 } });
  assert.deepEqual(unfocused.rows, [
    { before: "a", after: "a", type: "equal" },
    { before: "b", after: "b", type: "equal" },
  ]);
});

test("standalone code limits keep more context around a stop", async () => {
  const { codeFrameFromLines, STANDALONE_CODE_LIMITS } = await import("../out-test/engine/animatedHtml.js");
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`);
  const { frame } = codeFrameFromLines(lines, { startLine: 50, startColumn: 1, endLine: 52, endColumn: 1 }, undefined, "\n", STANDALONE_CODE_LIMITS);
  assert.equal(frame.startLine, 50 - STANDALONE_CODE_LIMITS.contextLines);
  assert.equal(frame.text.split("\n").length, 3 + 2 * STANDALONE_CODE_LIMITS.contextLines);
});
