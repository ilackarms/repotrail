import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeOpenWorkspaceInput } from "../out-test/mcp/openWorkspace.js";
import { shouldDeferRenderForTts } from "../out-test/ux/renderPolicy.js";

test("normalizes an absolute workspace path and defaults to a new window", () => {
  assert.deepEqual(
    normalizeOpenWorkspaceInput({ path: "/tmp/example.code-workspace" }),
    { path: "/tmp/example.code-workspace", forceNewWindow: true },
  );
});

test("honors explicit same-window requests", () => {
  assert.deepEqual(
    normalizeOpenWorkspaceInput({ path: "/tmp/project", newWindow: false }),
    { path: "/tmp/project", forceNewWindow: false },
  );
});

test("rejects relative workspace paths", () => {
  assert.throws(
    () => normalizeOpenWorkspaceInput({ path: "../other-project" }),
    /absolute local path/,
  );
});

test("rejects blank workspace paths", () => {
  assert.throws(
    () => normalizeOpenWorkspaceInput({ path: "   " }),
    /non-empty/,
  );
});

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

test("does not defer renders when narration is idle or the current stop changes", () => {
  const previous = {
    tourId: "tour-1",
    index: 0,
    provider: "openai",
    currentKey: "Intro|src/index.ts|The intro",
  };

  assert.equal(shouldDeferRenderForTts("idle", previous, previous), false);
  assert.equal(shouldDeferRenderForTts("playing", previous, { ...previous, index: 1 }), false);
  assert.equal(
    shouldDeferRenderForTts("playing", previous, {
      ...previous,
      currentKey: "Updated|src/index.ts|Changed text",
    }),
    false,
  );
});
