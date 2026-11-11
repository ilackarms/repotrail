import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./vscodeStub.mjs";
import {
  currentBranch,
  filesDifferingFrom,
  headCommit,
  listWorktrees,
  parseWorktreeList,
} from "../out-test/gitRepo.js";
import { composePrComment, hasSlides, workingTreeFiles } from "../out-test/github/prTour.js";
import { parseTourJson } from "../out-test/engine/tourSerialize.js";
import { clearPendingImport, readPendingImport, writePendingImport } from "../out-test/storage/pendingImport.js";
import { workspaceFileFor } from "../out-test/storage/workspaceFiles.js";

const SHA = "a".repeat(40);
const pr = { owner: "acme", repo: "app", number: 7 };

const plan = (steps) => ({ kind: "pr", title: "T", summary: "", steps });

test("workingTreeFiles lists the files a tour reads from the working tree", () => {
  const files = workingTreeFiles(
    plan([
      { title: "diff", explanation: "", file: "src/pinned.ts", diff: { baseRef: SHA, headRef: SHA } },
      { title: "file", explanation: "", file: "./src/a.ts", range: { startLine: 1, endLine: 2 } },
      { title: "again", explanation: "", file: "src/a.ts" },
      { title: "worktree diff", explanation: "", file: "src/old.ts", diff: { baseRef: SHA, headFile: "src/new.ts" } },
      { title: "text diff", explanation: "", file: "src/text.ts", diff: { beforeText: "a", afterText: "b" } },
      { title: "aliased root", explanation: "", file: "lib/x.ts", root: "lib" },
      { title: "escape", explanation: "", file: "../outside.ts" },
      {
        title: "slide",
        explanation: "",
        file: "docs/design.md",
        slide: {
          blocks: [
            { type: "code", id: "c", code: "x", ref: { file: "src/code.ts" } },
            {
              type: "flow",
              id: "f",
              nodes: [
                { id: "n", label: "N", ref: { file: "src/node.ts" } },
                { id: "m", label: "M", ref: { root: "lib", file: "lib/y.ts" } },
              ],
              edges: [],
            },
            { type: "sequence", id: "s", participants: [{ id: "p", label: "P", ref: { file: "src/actor.ts" } }], messages: [] },
          ],
        },
      },
    ]),
  );
  assert.deepEqual(files.sort(), [
    "docs/design.md",
    "lib/x.ts",
    "lib/y.ts",
    "src/a.ts",
    "src/actor.ts",
    "src/code.ts",
    "src/new.ts",
    "src/node.ts",
  ]);
});

test("a tour of pinned diffs reads nothing from the working tree", () => {
  const p = plan([{ title: "d", explanation: "", file: "src/a.ts", diff: { baseRef: SHA, headRef: SHA, scope: "file" } }]);
  assert.deepEqual(workingTreeFiles(p), []);
  assert.equal(hasSlides(p), false);
});

test("the PR comment asks for a checkout of the PR, and 0.14, when the tour reads the working tree", async () => {
  const slides = parseTourJson(await readFile(new URL("./fixtures/fleet-config-slides.json", import.meta.url), "utf8"));
  const withSlides = composePrComment({ plan: slides, pr, exportedAt: "2026-11-11T00:00:00.000Z", extensionId: "repotrail.repotrail" });
  assert.equal(withSlides.ok, true);
  assert.match(withSlides.body, /\(0\.14 or later, for the slides\) and a checkout of this PR\./);
  assert.doesNotMatch(withSlides.body, /any clone of this repo/);

  const files = plan([{ title: "f", explanation: "", file: "src/a.ts" }]);
  const fileTour = composePrComment({ plan: files, pr, exportedAt: "2026-11-11T00:00:00.000Z", extensionId: "repotrail.repotrail" });
  assert.match(fileTour.body, /\) and a checkout of this PR\./);
  assert.doesNotMatch(fileTour.body, /for the slides/);

  const diffs = plan([{ title: "d", explanation: "", file: "src/a.ts", diff: { baseRef: SHA, headRef: SHA, scope: "file" } }]);
  const diffTour = composePrComment({ plan: diffs, pr, exportedAt: "2026-11-11T00:00:00.000Z", extensionId: "repotrail.repotrail" });
  assert.match(diffTour.body, /\) and any clone of this repo\./);
});

test("parseWorktreeList reads porcelain output and skips bare and prunable entries", () => {
  const b = "b".repeat(40);
  const out = parseWorktreeList(
    [
      "worktree /repo",
      `HEAD ${SHA}`,
      "branch refs/heads/main",
      "",
      "worktree /repo-pr-7",
      `HEAD ${b.toUpperCase()}`,
      "detached",
      "",
      "worktree /bare.git",
      "bare",
      "",
      "worktree /gone",
      `HEAD ${SHA}`,
      "detached",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n"),
  );
  assert.deepEqual(out, [
    { path: "/repo", head: SHA, branch: "main" },
    { path: "/repo-pr-7", head: b },
  ]);
});

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

test("git checks: HEAD, branch, files that differ from the PR head, and worktrees", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "repotrail-checkout-"));
  try {
    const main = path.join(dir, "app");
    await mkdir(main);
    git(main, "init", "-q", "-b", "main");
    await writeFile(path.join(main, "shared.ts"), "one\n");
    await writeFile(path.join(main, "gone.ts"), "x\n");
    git(main, "add", ".");
    git(main, "commit", "-qm", "base");
    const base = git(main, "rev-parse", "HEAD");

    git(main, "switch", "-qc", "pr");
    await mkdir(path.join(main, "docs"));
    await writeFile(path.join(main, "docs", "design.md"), "# design\n");
    await writeFile(path.join(main, "shared.ts"), "two\n");
    await writeFile(path.join(main, "a*b.ts"), "literal\n");
    git(main, "rm", "-q", "gone.ts");
    git(main, "add", ".");
    git(main, "commit", "-qm", "pr");
    const prHead = git(main, "rev-parse", "HEAD");
    git(main, "switch", "-q", "main");

    assert.equal(await headCommit(main), base);
    assert.equal(await currentBranch(main), "main");
    const files = ["docs/design.md", "shared.ts", "gone.ts", "a*b.ts", "missing-everywhere.ts"];
    assert.deepEqual((await filesDifferingFrom(main, prHead, files)).sort(), ["a*b.ts", "docs/design.md", "gone.ts", "shared.ts"]);
    assert.deepEqual(await filesDifferingFrom(main, base, files), []);
    assert.equal(await filesDifferingFrom(main, "not-a-sha", files), undefined);

    const lane = path.join(dir, "app-pr-7");
    git(main, "worktree", "add", "-q", "--detach", lane, prHead);
    assert.equal(await headCommit(lane), prHead);
    assert.equal(await currentBranch(lane), undefined);
    assert.deepEqual(await filesDifferingFrom(lane, prHead, files), []);
    const trees = await listWorktrees(main);
    assert.ok(trees.some((w) => w.head === prHead && path.basename(w.path) === "app-pr-7"));
    assert.ok(trees.some((w) => w.head === base && w.branch === "main"));

    assert.equal(await headCommit(dir), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a pending import round-trips through its file and rejects junk", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "repotrail-pending-"));
  const file = path.join(dir, "nested", "pending.json");
  try {
    assert.equal(await readPendingImport(file), undefined);
    const value = { request: { pr }, folder: "/work/app-pr-7", at: 123 };
    await writePendingImport(value, file);
    assert.deepEqual(await readPendingImport(file), value);
    await clearPendingImport(file);
    assert.equal(await readPendingImport(file), undefined);
    await clearPendingImport(file);
    await writeFile(file, "{not json");
    assert.equal(await readPendingImport(file), undefined);
    await writeFile(file, JSON.stringify({ folder: 1, at: 1, request: {} }));
    assert.equal(await readPendingImport(file), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspaceFileFor finds the workspace file that holds a folder, single-folder first", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "repotrail-ws-"));
  try {
    const registry = path.join(dir, "registry");
    await mkdir(registry);
    const lane = path.join(dir, "reviews", "app-pr-7");
    await mkdir(lane, { recursive: true });

    assert.equal(await workspaceFileFor(lane, registry), undefined);

    await writeFile(
      path.join(registry, "a-multi.code-workspace"),
      JSON.stringify({ folders: [{ path: lane }, { path: path.join(dir, "other") }] }),
    );
    assert.equal(await workspaceFileFor(lane, registry), path.join(registry, "a-multi.code-workspace"));

    await writeFile(
      path.join(registry, "b-single.code-workspace"),
      `{\n  // the lane\n  "folders": [ { "name": "app", "path": "${lane}" }, ],\n  /* settings */ "settings": { "x": "a // not a comment" }\n}\n`,
    );
    assert.equal(await workspaceFileFor(lane, registry), path.join(registry, "b-single.code-workspace"));

    // The setup prompt's layout: DIR/<folder>.code-workspace with a relative path.
    const sibling = `${lane}.code-workspace`;
    await writeFile(sibling, JSON.stringify({ folders: [{ name: "app-pr-7", path: "app-pr-7" }] }));
    assert.equal(await workspaceFileFor(lane, registry), sibling);
    assert.equal(await workspaceFileFor(path.join(dir, "elsewhere"), registry), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
