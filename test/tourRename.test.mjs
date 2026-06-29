import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  renameRepoTourTitle,
  renameTourRecordTitle,
  validateTourTitle,
} from "../out-test/storage/tourRename.js";

function samplePlan(title = "Old title") {
  return {
    kind: "architecture",
    title,
    summary: "A short tour.",
    steps: [
      {
        title: "First stop",
        file: "src/index.ts",
        range: { startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 },
        explanation: "Read this part.",
        actions: ["openFile", "highlightRange", "showNarration"],
      },
    ],
  };
}

test("validates non-empty tour titles and trims surrounding whitespace", () => {
  assert.equal(validateTourTitle("  New visible title  "), "New visible title");
  assert.throws(() => validateTourTitle("   "), /non-empty/);
});

test("renames a repo tour title without changing the filename or envelope metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "repotrail-rename-"));
  const tourDir = path.join(root, ".repotrail");
  await fs.mkdir(tourDir);
  const file = path.join(tourDir, "architecture.json");
  await fs.writeFile(
    file,
    JSON.stringify(
      {
        repoTrailTour: 2,
        exportedAt: "2026-06-01T12:00:00.000Z",
        plan: samplePlan(),
      },
      null,
      2,
    ),
    "utf8",
  );

  const renamed = await renameRepoTourTitle(root, "architecture.json", "New visible title");
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  const entries = await fs.readdir(tourDir);

  assert.equal(renamed.title, "New visible title");
  assert.deepEqual(entries, ["architecture.json"]);
  assert.equal(saved.exportedAt, "2026-06-01T12:00:00.000Z");
  assert.equal(saved.plan.title, "New visible title");
  assert.equal(saved.plan.steps[0].title, "First stop");
});

test("renames a bare repo tour plan title in place", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "repotrail-rename-bare-"));
  const tourDir = path.join(root, ".repotrail");
  await fs.mkdir(tourDir);
  const file = path.join(tourDir, "bare.json");
  await fs.writeFile(file, JSON.stringify(samplePlan(), null, 2), "utf8");

  const renamed = await renameRepoTourTitle(root, "bare.json", "Bare plan title");
  const saved = JSON.parse(await fs.readFile(file, "utf8"));

  assert.equal(renamed.title, "Bare plan title");
  assert.equal(saved.title, "Bare plan title");
  assert.equal(saved.steps.length, 1);
});

test("renames a local saved tour record title and bumps updatedAt", () => {
  const record = {
    id: "tour-1",
    workspaceRoot: "/tmp/workspace",
    createdAt: 100,
    updatedAt: 200,
    lastIndex: 0,
    seen: [0],
    plan: samplePlan(),
  };

  const renamed = renameTourRecordTitle(record, "Local visible title", 300);

  assert.equal(renamed.plan.title, "Local visible title");
  assert.equal(renamed.updatedAt, 300);
  assert.equal(renamed.id, "tour-1");
  assert.deepEqual(renamed.seen, [0]);
});
