import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeTourRefForRecord,
  activeTourRefForWorkspace,
} from "../out-test/storage/activeTour.js";

test("stores only the active tour identity", () => {
  const ref = activeTourRefForRecord({
    id: "repo_123",
    workspaceRoot: "/tmp/project",
    createdAt: 1,
    updatedAt: 2,
    lastIndex: 3,
    plan: { kind: "architecture", title: "Tour", summary: "", steps: [] },
  });

  assert.deepEqual(ref, { id: "repo_123", workspaceRoot: "/tmp/project" });
});

test("restores an active tour only in its owning workspace", () => {
  const ref = { id: "repo_123", workspaceRoot: "/tmp/project" };
  assert.deepEqual(activeTourRefForWorkspace(ref, "/tmp/project"), ref);
  assert.equal(activeTourRefForWorkspace(ref, "/tmp/other"), null);
  assert.equal(activeTourRefForWorkspace({ workspaceRoot: "/tmp/project" }, "/tmp/project"), null);
});
