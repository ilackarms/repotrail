import assert from "node:assert/strict";
import { test } from "node:test";
import "./vscodeStub.mjs";
import { listIssueComments, nextPageUrl, commentBelongsTo } from "../out-test/github/api.js";
import {
  composePrComment,
  composeSetupPrompt,
  diffRefs,
  GITHUB_COMMENT_LIMIT,
  portablePlan,
  sharedHeadRef,
  staleHeadMessage,
} from "../out-test/github/prTour.js";
import { parseGitHubRemote, parseGitRemoteVerbose } from "../out-test/github/remotes.js";
import { findToursInMarkdown } from "../out-test/github/tourComments.js";
import { pullRequestFetchArgs } from "../out-test/gitRepo.js";

const BASE = "05fa4065ce12ebfdb0b8b33e46b781e0a937acb7";
const HEAD = "ba24b92e1f2a002dfb1248f134b78b8b5014a579";
const pr = { owner: "agentdesktop-dev", repo: "agentdesktop", number: 237 };

function plan(stepCount = 2, overrides = {}) {
  return {
    kind: "pr-diff",
    title: "#237: fleet API limits",
    summary: "Review guide.",
    roots: { pr: { name: "agentdesktop-pr-237", pathHint: "agentdesktop-pr-237" } },
    steps: Array.from({ length: stepCount }, (_, i) => ({
      root: "pr",
      file: `src/f${i}.rs`,
      title: `Stop ${i + 1}`,
      explanation: "Narration.",
      actions: ["showDiff", "showNarration"],
      viewMode: "diff",
      diff: { baseRef: BASE, headRef: HEAD, scope: "file" },
    })),
    ...overrides,
  };
}

test("recognizes github.com remotes in https and ssh forms", () => {
  const expected = { owner: "agentdesktop-dev", repo: "agentdesktop" };
  for (const url of [
    "https://github.com/agentdesktop-dev/agentdesktop.git",
    "https://github.com/agentdesktop-dev/agentdesktop",
    "https://token@github.com/agentdesktop-dev/agentdesktop.git",
    "git@github.com:agentdesktop-dev/agentdesktop.git",
    "github.com:agentdesktop-dev/agentdesktop",
    "ssh://git@github.com/agentdesktop-dev/agentdesktop.git",
    "ssh://git@ssh.github.com:443/agentdesktop-dev/agentdesktop.git",
    "git://github.com/agentdesktop-dev/agentdesktop.git",
  ]) {
    assert.deepEqual(parseGitHubRemote(url), expected, url);
  }
  for (const url of [
    "https://gitlab.com/agentdesktop-dev/agentdesktop.git",
    "git@github.example.com:o/r.git",
    "https://github.com/o/r/extra",
    "/local/path/to/repo",
    "file:///github.com/o/r",
  ]) {
    assert.equal(parseGitHubRemote(url), null, url);
  }
});

test("parses git remote -v output", () => {
  const out = [
    "origin\tgit@github.com:me/agentdesktop.git (fetch)",
    "origin\tgit@github.com:me/agentdesktop.git (push)",
    "upstream\thttps://github.com/agentdesktop-dev/agentdesktop.git (fetch)",
    "upstream\tno_push (push)",
  ].join("\n");
  assert.deepEqual(parseGitRemoteVerbose(out), [
    { name: "origin", url: "git@github.com:me/agentdesktop.git" },
    { name: "upstream", url: "https://github.com/agentdesktop-dev/agentdesktop.git" },
  ]);
});

test("builds fixed git fetch arguments and refuses unsafe input", () => {
  assert.deepEqual(pullRequestFetchArgs("origin", 237), ["fetch", "--no-tags", "origin", "pull/237/head"]);
  assert.deepEqual(pullRequestFetchArgs("upstream", 237, [BASE]), ["fetch", "--no-tags", "upstream", BASE]);
  assert.throws(() => pullRequestFetchArgs("--upload-pack=x", 1));
  assert.throws(() => pullRequestFetchArgs("origin", 0));
  assert.throws(() => pullRequestFetchArgs("origin", 1, ["HEAD"]));
});

test("collects diff refs and the shared head", () => {
  const p = plan();
  assert.deepEqual(diffRefs(p), [BASE, HEAD]);
  assert.equal(sharedHeadRef(p), HEAD);

  const withCodeStop = plan(2);
  withCodeStop.steps.push({ file: "README.md", title: "Context", explanation: "", actions: ["openFile"] });
  assert.equal(sharedHeadRef(withCodeStop), HEAD);

  const mixed = plan(2);
  mixed.steps[1].diff = { baseRef: BASE, headRef: "c".repeat(40) };
  assert.equal(sharedHeadRef(mixed), undefined);

  const workingTree = plan(2);
  delete workingTree.steps[1].diff.headRef;
  assert.equal(sharedHeadRef(workingTree), undefined);
});

test("warns when the tour head differs from the expected or current PR head", () => {
  assert.equal(staleHeadMessage(plan(), { expected: HEAD, current: HEAD }), null);
  assert.equal(staleHeadMessage(plan(), { current: HEAD.toUpperCase() }), null);
  assert.match(staleHeadMessage(plan(), { current: "d".repeat(40) }), /written for commit ba24b92.*now ddddddd/);
  assert.match(staleHeadMessage(plan(), { expected: "e".repeat(40), current: HEAD }), /link expects eeeeeee/);
  const short = plan();
  for (const step of short.steps) step.diff.headRef = "ba24b92";
  assert.equal(staleHeadMessage(short, { current: HEAD }), null);
});

test("strips local paths before a tour is shared", () => {
  const p = plan(1, {
    roots: {
      pr: { name: "agentdesktop-pr-237", pathHint: "agentdesktop-pr-237", path: "/Users/me/src/agentdesktop-pr-237" },
      other: { workspaceFolder: "/Users/me/src/other" },
    },
  });
  p.steps[0].workspaceFolder = "/Users/me/src/agentdesktop-pr-237";
  const shared = portablePlan(p);
  assert.deepEqual(shared.roots, {
    pr: { name: "agentdesktop-pr-237", pathHint: "agentdesktop-pr-237" },
    other: { pathHint: "other" },
  });
  assert.equal(shared.steps[0].workspaceFolder, undefined);
  assert.equal(JSON.stringify(shared).includes("/Users/me"), false);
});

test("composes a PR comment whose tour round-trips through the importer", () => {
  const result = composePrComment({ plan: plan(11), pr, exportedAt: "2026-11-10T00:00:00.000Z", extensionId: "repotrail.repotrail" });
  assert.equal(result.ok, true);
  assert.equal(result.link, `vscode://repotrail.repotrail/review?pr=agentdesktop-dev/agentdesktop/237&head=${HEAD}`);
  assert.ok(result.body.includes(`https://vscode.dev/redirect?url=${encodeURIComponent(result.link)}`));
  assert.ok(result.body.includes(`\`code --open-url '${result.link}'\``));
  assert.match(result.body, /<summary>No RepoTrail or no clone\? Prompt for your coding agent<\/summary>/);
  assert.match(result.body, /<!-- repotrail-tour:237-fleet-api-limits -->/);
  const found = findToursInMarkdown(result.body);
  assert.equal(found.length, 1);
  assert.equal(found[0].plan.steps.length, 11);
  assert.equal(found[0].plan.steps[0].diff.headRef, HEAD);
  assert.ok(result.body.length < GITHUB_COMMENT_LIMIT);
});

test("leaves head off the link when stops don't share one headRef", () => {
  const p = plan(2);
  p.steps[1].diff.headRef = "c".repeat(40);
  const result = composePrComment({ plan: p, pr, exportedAt: "x", extensionId: "repotrail.repotrail" });
  assert.equal(result.link, "vscode://repotrail.repotrail/review?pr=agentdesktop-dev/agentdesktop/237");
});

test("compacts the JSON, then refuses, as a tour approaches GitHub's limit", () => {
  const many = plan(220);
  const compacted = composePrComment({ plan: many, pr, exportedAt: "x", extensionId: "repotrail.repotrail" });
  assert.equal(compacted.ok, true);
  assert.equal(compacted.compactJson, true);
  assert.ok(compacted.body.length <= GITHUB_COMMENT_LIMIT);
  assert.equal(findToursInMarkdown(compacted.body)[0].plan.steps.length, 220);

  const big = plan(1);
  big.steps[0].explanation = "x".repeat(GITHUB_COMMENT_LIMIT);
  const tooBig = composePrComment({ plan: big, pr, exportedAt: "x", extensionId: "repotrail.repotrail" });
  assert.equal(tooBig.ok, false);
  assert.ok(tooBig.length > GITHUB_COMMENT_LIMIT);
});

test("setup prompt checks out the tour head and saves the right fence", () => {
  const prompt = composeSetupPrompt({
    pr,
    plan: plan(11),
    headSha: HEAD,
    source: { commentId: "6781746011", commentUrl: "https://github.com/x#issuecomment-6781746011", jsonFenceIndex: 2 },
  });
  assert.match(prompt, /git worktree add --detach DIR\/agentdesktop-pr-237 ba24b92e1f2a002dfb1248f134b78b8b5014a579/);
  assert.match(prompt, /cat-file -e 05fa4065ce12ebfdb0b8b33e46b781e0a937acb7\^\{commit\}/);
  assert.match(prompt, /gh api repos\/agentdesktop-dev\/agentdesktop\/issues\/comments\/6781746011 --jq \.body/);
  assert.match(prompt, /n == 2/);
  assert.match(prompt, /\.repotrail\/237-fleet-api-limits\.json/);
  assert.match(prompt, /has 11 entries under plan\.steps/);
  assert.equal(prompt.split("\n").some((line) => /^\s*```+\s*$/.test(line)), false);
});

test("follows GitHub pagination only on api.github.com", async () => {
  assert.equal(nextPageUrl('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"'), "https://api.github.com/x?page=2");
  assert.equal(nextPageUrl('<https://evil.example/x?page=2>; rel="next"'), null);
  assert.equal(nextPageUrl(null), null);

  const calls = [];
  const pages = {
    "https://api.github.com/repos/o/r/issues/1/comments?per_page=100": {
      body: [{ id: 1, body: "a", user: { login: "x" }, created_at: "t", html_url: "h", issue_url: "https://api.github.com/repos/o/r/issues/1" }],
      link: '<https://api.github.com/repositories/9/issues/1/comments?per_page=100&page=2>; rel="next"',
    },
    "https://api.github.com/repositories/9/issues/1/comments?per_page=100&page=2": {
      body: [{ id: 2, body: null, user: null }],
      link: null,
    },
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    const page = pages[url];
    return new Response(JSON.stringify(page.body), { status: 200, headers: page.link ? { link: page.link } : {} });
  };
  const comments = await listIssueComments({ owner: "o", repo: "r", number: 1 }, { token: "t0k", fetchImpl });
  assert.deepEqual(comments.map((c) => c.id), ["1", "2"]);
  assert.equal(comments[1].body, "");
  assert.deepEqual(calls.map((c) => c.auth), ["Bearer t0k", "Bearer t0k"]);
  assert.equal(commentBelongsTo(comments[0], "O/R", 1), true);
  assert.equal(commentBelongsTo(comments[0], "o/r", 2), false);
});
