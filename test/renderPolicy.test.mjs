import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldDeferRenderForTts } from "../out-test/ux/renderPolicy.js";

test("defers same-step renders while narration is active", () => {
  const previous = {
    tourId: "tour-1",
    index: 0,
    provider: "openai",
    currentKey: "Intro|src/index.ts|The intro",
  };
  const next = { ...previous };

  assert.equal(shouldDeferRenderForTts("playing", previous, next), true);
  assert.equal(shouldDeferRenderForTts("paused", previous, next), true);
  assert.equal(shouldDeferRenderForTts("preparing", previous, next), true);
});

test("defers tour changes until active narration is cancelled", () => {
  const previous = {
    tourId: "tour-1",
    index: 0,
    provider: "openai",
    currentKey: "Intro|src/index.ts|The intro",
  };

  assert.equal(shouldDeferRenderForTts("idle", previous, previous), false);
  assert.equal(shouldDeferRenderForTts("playing", previous, { ...previous, index: 1 }), true);
  assert.equal(
    shouldDeferRenderForTts("playing", previous, {
      ...previous,
      currentKey: "Updated|src/index.ts|Changed text",
    }),
    true,
  );
  assert.equal(
    shouldDeferRenderForTts("playing", previous, { ...previous, provider: "system" }),
    false,
  );
});
