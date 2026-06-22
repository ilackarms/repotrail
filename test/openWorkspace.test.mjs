import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeOpenWorkspaceInput } from "../out-test/mcp/openWorkspace.js";

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
