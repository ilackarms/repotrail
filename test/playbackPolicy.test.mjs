import assert from "node:assert/strict";
import { test } from "node:test";
import { narrationTargetKey } from "../out-test/tts/playbackPolicy.js";

const step = (overrides = {}) => ({
  title: "Intro",
  file: "src/index.ts",
  explanation: "Explain the entrypoint.",
  range: { startLine: 1, startColumn: 1, endLine: 5, endColumn: 1 },
  viewMode: "code",
  actions: ["openFile", "highlightRange", "showNarration"],
  ...overrides,
});

test("changes narration identity when current content or editor target changes", () => {
  const current = step();
  const key = narrationTargetKey("tour-1", current);
  assert.notEqual(narrationTargetKey("tour-1", step({ title: "Updated" })), key);
  assert.notEqual(narrationTargetKey("tour-1", step({ explanation: "Updated narration." })), key);
  assert.notEqual(narrationTargetKey("tour-1", step({ file: "src/other.ts" })), key);
  assert.notEqual(narrationTargetKey("tour-2", current), key);
});

test("ignores route index, sibling edits, and runtime anchors", () => {
  const current = step();
  const key = narrationTargetKey("tour-1", current);
  const rewrittenRoute = [step({ title: "Inserted" }), step({ anchor: "const main = true;" })];
  assert.equal(narrationTargetKey("tour-1", rewrittenRoute[1]), key);
});

test("returns no target without both a tour and current stop", () => {
  assert.equal(narrationTargetKey(null, step()), null);
  assert.equal(narrationTargetKey("tour-1", null), null);
});
