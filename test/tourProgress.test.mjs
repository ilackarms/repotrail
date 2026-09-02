import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileTourUpdate } from "../out-test/ux/tourProgress.js";

const step = (title, file, startLine = 1, explanation = title, anchor) => ({
  title,
  file,
  explanation,
  range: { startLine, startColumn: 1, endLine: startLine + 1, endColumn: 1 },
  viewMode: "code",
  actions: ["openFile", "highlightRange", "showNarration"],
  ...(anchor ? { anchor } : {}),
});

const progress = (previous, index, seen, next) => {
  const result = reconcileTourUpdate(previous, index, seen, next);
  return {
    index: result.index,
    seen: result.seen,
    editorRefreshNeeded: result.editorRefreshNeeded,
  };
};

test("preserves the active step and visited stops when a tour grows", () => {
  const previous = [step("A", "a.ts"), step("B", "b.ts"), step("C", "c.ts")];
  const next = [...previous, step("D", "d.ts")];
  assert.deepEqual(progress(previous, 2, [0, 1, 2], next), {
    index: 2,
    seen: [0, 1, 2],
    editorRefreshNeeded: false,
  });
});

test("clamps progress when a rewritten tour is shorter", () => {
  const previous = ["A", "B", "C", "D", "E", "F"].map((title) => step(title, `${title}.ts`));
  const next = previous.slice(0, 3);
  assert.deepEqual(progress(previous, 5, [0, 2, 4, 5], next), {
    index: 2,
    seen: [0, 2],
    editorRefreshNeeded: true,
  });
});

test("clears navigation state when a rewritten tour has no stops", () => {
  const previous = [step("A", "a.ts"), step("B", "b.ts")];
  assert.deepEqual(progress(previous, 1, [0, 1], []), {
    index: -1,
    seen: [],
    editorRefreshNeeded: true,
  });
});

test("tracks the same logical stop when earlier stops are inserted", () => {
  const previous = [step("A", "a.ts"), step("B", "b.ts"), step("C", "c.ts")];
  const next = [step("New", "new.ts"), ...previous];
  assert.deepEqual(progress(previous, 1, [0, 1], next), {
    index: 2,
    seen: [1, 2],
    editorRefreshNeeded: false,
  });
});

test("does not transfer seen state to an unrelated stop in the same file", () => {
  const previous = [step("Removed", "shared.ts", 1), step("Kept", "shared.ts", 20), step("Current", "c.ts")];
  const next = [step("Kept", "shared.ts", 20), step("Current", "c.ts")];
  assert.deepEqual(progress(previous, 2, [0], next), {
    index: 1,
    seen: [],
    editorRefreshNeeded: false,
  });
});

test("updates narration without reopening an unchanged editor target", () => {
  const previous = [step("A", "a.ts", 4, "Old explanation")];
  const next = [step("A", "a.ts", 4, "New explanation")];
  assert.deepEqual(progress(previous, 0, [0], next), {
    index: 0,
    seen: [0],
    editorRefreshNeeded: false,
  });
});

test("reopens the editor when the active target changes", () => {
  const previous = [step("A", "a.ts", 4)];
  const next = [step("A", "a.ts", 20)];
  assert.deepEqual(progress(previous, 0, [0], next), {
    index: 0,
    seen: [0],
    editorRefreshNeeded: true,
  });
});

test("refreshes markers when a sibling stop is added in the current file", () => {
  const previous = [step("A", "a.ts", 4), step("B", "b.ts", 8)];
  const next = [step("A", "a.ts", 4), step("New", "a.ts", 30), step("B", "b.ts", 8)];
  assert.deepEqual(progress(previous, 0, [0], next), {
    index: 0,
    seen: [0],
    editorRefreshNeeded: true,
  });
});

test("carries a captured anchor across an unrelated source edit", () => {
  const previous = [step("A", "a.ts", 4, "Old explanation", "const stable = true;")];
  const next = [step("A", "a.ts", 4, "New explanation")];
  const result = reconcileTourUpdate(previous, 0, [0], next);
  assert.equal(result.steps[0].anchor, "const stable = true;");
  assert.equal(result.editorRefreshNeeded, false);
});

test("honors an explicit anchor change from the source file", () => {
  const previous = [step("A", "a.ts", 4, "A", "const oldAnchor = true;")];
  const next = [step("A", "a.ts", 4, "A", "const newAnchor = true;")];
  const result = reconcileTourUpdate(previous, 0, [0], next);
  assert.equal(result.steps[0].anchor, "const newAnchor = true;");
  assert.equal(result.editorRefreshNeeded, true);
});
