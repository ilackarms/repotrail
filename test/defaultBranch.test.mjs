import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./vscodeStub.mjs";
import { commitsAheadOf, currentBranch, defaultBranchRef } from "../out-test/gitRepo.js";

function git(cwd, ...args) {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdio: "ignore",
  });
}

async function commit(dir, file) {
  await writeFile(path.join(dir, file), `${file}\n`);
  git(dir, "add", file);
  git(dir, "commit", "-m", file);
}

/** A bare "remote" whose default branch is `trunk`, and a clone of it. */
async function cloneWithRemote(t) {
  const root = await mkdtemp(path.join(tmpdir(), "repotrail-default-branch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = path.join(root, "seed");
  const remote = path.join(root, "remote.git");
  const clone = path.join(root, "clone");
  git(root, "init", "-q", "-b", "trunk", seed);
  await commit(seed, "a.txt");
  git(root, "clone", "-q", "--bare", seed, remote);
  git(root, "clone", "-q", remote, clone);
  return clone;
}

test("finds the default branch from the remote's HEAD and counts a branch's commits", async (t) => {
  const clone = await cloneWithRemote(t);

  assert.deepEqual(await defaultBranchRef(clone), { remote: "origin", branch: "trunk", ref: "origin/trunk" });
  assert.equal(await commitsAheadOf(clone, "origin/trunk"), 0);

  git(clone, "checkout", "-q", "-b", "fix/limits");
  await commit(clone, "b.txt");
  await commit(clone, "c.txt");

  assert.equal(await currentBranch(clone), "fix/limits");
  assert.equal(await commitsAheadOf(clone, "origin/trunk"), 2);
});

test("falls back to main when the clone never recorded the remote's HEAD", async (t) => {
  const clone = await cloneWithRemote(t);
  git(clone, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(clone, "symbolic-ref", "-d", "refs/remotes/origin/HEAD");

  assert.deepEqual(await defaultBranchRef(clone), { remote: "origin", branch: "main", ref: "origin/main" });
});

test("reports nothing without a remote, outside a repository, or for a ref git can't read", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "repotrail-no-remote-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.equal(await defaultBranchRef(dir), undefined);
  assert.equal(await commitsAheadOf(dir, "origin/main"), undefined);

  git(dir, "init", "-q", "-b", "main");
  await commit(dir, "a.txt");
  assert.equal(await defaultBranchRef(dir), undefined);
  assert.equal(await commitsAheadOf(dir, "origin/missing"), undefined);
  assert.equal(await commitsAheadOf(dir, "main..HEAD"), undefined);
  assert.equal(await commitsAheadOf(dir, "--all"), undefined);
});

test("prefers upstream's default branch in a fork's clone", async (t) => {
  const clone = await cloneWithRemote(t);
  const upstream = path.join(path.dirname(clone), "remote.git");
  git(clone, "remote", "add", "upstream", upstream);
  git(clone, "fetch", "-q", "upstream");
  git(clone, "remote", "set-head", "upstream", "trunk");

  assert.deepEqual(await defaultBranchRef(clone), { remote: "upstream", branch: "trunk", ref: "upstream/trunk" });
});
