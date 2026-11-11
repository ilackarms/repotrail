import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import "./vscodeStub.mjs";
import { listIssueComments, nextPageUrl, commentBelongsTo } from "../out-test/github/api.js";
import {
  AWK_LAST_JSON_FENCE,
  awkFenceIndexFor,
  awkFenceProgram,
  awkFenceText,
  composePrComment,
  composeSetupPrompt,
  diffRefs,
  GITHUB_COMMENT_LIMIT,
  isTrustedPoster,
  portablePlan,
  rankTourCandidates,
  sharedHeadRef,
  tourRefWarnings,
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

test("lists stops whose refs aren't the PR head or merge base", () => {
  assert.deepEqual(tourRefWarnings(plan(), { prHead: HEAD, mergeBase: BASE, linkHead: HEAD }), []);
  assert.deepEqual(tourRefWarnings(plan(), { prHead: HEAD.toUpperCase() }), []);

  const older = tourRefWarnings(plan(3), { prHead: "d".repeat(40) });
  assert.deepEqual(older, ["3 stops show ba24b92 instead of the PR head ddddddd."]);

  const mixed = plan(4);
  mixed.steps[1].diff.headRef = "c".repeat(40);
  mixed.steps[2].diff.headRef = "origin/feature";
  delete mixed.steps[3].diff.headRef;
  mixed.steps[0].diff.baseRef = "main";
  assert.deepEqual(tourRefWarnings(mixed, { prHead: HEAD, mergeBase: BASE, linkHead: "e".repeat(40) }), [
    "The link was made for head eeeeeee; the PR head is now ba24b92.",
    "1 stop compare against your working tree instead of a commit.",
    "2 stops show ccccccc, origin/feature instead of the PR head ba24b92.",
    "1 stop compare against main instead of the PR's merge base 05fa406.",
  ]);

  const short = plan();
  for (const step of short.steps) step.diff.headRef = "ba24b92";
  assert.deepEqual(tourRefWarnings(short, { prHead: HEAD }), []);
  const tooShort = plan(1);
  tooShort.steps[0].diff.headRef = "ba2";
  assert.equal(tourRefWarnings(tooShort, { prHead: HEAD }).length, 1);
});

test("trusts the PR author and collaborators, and ranks their tours first", () => {
  assert.equal(isTrustedPoster({ author: "Alice", authorAssociation: "NONE" }, "alice"), true);
  assert.equal(isTrustedPoster({ author: "bob", authorAssociation: "COLLABORATOR" }, "alice"), true);
  assert.equal(isTrustedPoster({ author: "bob", authorAssociation: "MEMBER" }, "alice"), true);
  assert.equal(isTrustedPoster({ author: "mallory", authorAssociation: "CONTRIBUTOR" }, "alice"), false);
  assert.equal(isTrustedPoster({ author: "mallory", authorAssociation: "NONE" }, ""), false);

  const other = plan(1);
  other.steps[0].diff.headRef = "c".repeat(40);
  const candidates = [
    { id: "old-maint", plan: plan(), author: "bob", authorAssociation: "MEMBER", createdAt: "2026-11-01T00:00:00Z" },
    { id: "stranger", plan: plan(), author: "mallory", authorAssociation: "NONE", createdAt: "2026-11-09T00:00:00Z" },
    { id: "new-author", plan: plan(), author: "alice", authorAssociation: "CONTRIBUTOR", createdAt: "2026-11-05T00:00:00Z" },
    { id: "other-head", plan: other, author: "alice", authorAssociation: "CONTRIBUTOR", createdAt: "2026-11-10T00:00:00Z" },
  ];
  assert.deepEqual(
    rankTourCandidates(candidates, { prAuthor: "alice" }).map((c) => c.id),
    ["other-head", "new-author", "old-maint", "stranger"],
  );
  assert.deepEqual(
    rankTourCandidates(candidates, { prAuthor: "alice", linkHead: HEAD }).map((c) => c.id),
    ["new-author", "old-maint", "stranger"],
  );
  assert.deepEqual(
    rankTourCandidates(candidates, { prAuthor: "alice", linkHead: "f".repeat(40) }).length,
    4,
  );
});

test("strips local paths and captured anchors before a tour is shared", () => {
  const p = plan(1, {
    roots: {
      pr: { name: "/Users/me/src/agentdesktop-pr-237", pathHint: "/Users/me/src/agentdesktop-pr-237", path: "/Users/me/src/x" },
      other: { workspaceFolder: "/Users/me/src/other" },
      "/Users/me/src/third": {},
    },
  });
  p.steps[0].workspaceFolder = "/Users/me/src/agentdesktop-pr-237";
  p.steps[0].anchor = "let secret = read_local_override();";
  p.steps[0].diff.beforeLabel = "main (/Users/me/src/agentdesktop)";
  p.steps[0].diff.afterLabel = "PR head";
  const shared = portablePlan(p);
  assert.deepEqual(shared.roots, {
    pr: { name: "agentdesktop-pr-237", pathHint: "agentdesktop-pr-237" },
    other: { pathHint: "other" },
    "/Users/me/src/third": { pathHint: "third" },
  });
  assert.equal(shared.steps[0].workspaceFolder, undefined);
  assert.equal(shared.steps[0].anchor, undefined);
  assert.equal(shared.steps[0].diff.beforeLabel, undefined);
  assert.equal(shared.steps[0].diff.afterLabel, "PR head");
  const json = JSON.stringify({ ...shared, roots: { ...shared.roots, "/Users/me/src/third": undefined } });
  assert.equal(json.includes("/Users/me"), false);
  assert.equal(p.steps[0].anchor, "let secret = read_local_override();");
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

function runAwk(program, input) {
  const res = spawnSync("awk", [program], { input, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

test("picks the fence awk extracts, and only when awk sees it the same way", () => {
  const tour = (title) => JSON.stringify({ repoTrailTour: 2, plan: { title, steps: [{ file: "a.ts", title: "A" }] } }, null, 2);
  const bodies = {
    simple: ["intro", "```json", tour("Simple"), "```"].join("\r\n"),
    second: ["```json", '{ "config": true }', "```", "```json", tour("Second"), "```"].join("\n"),
    tilde: ["~~~json", tour("Tilde"), "~~~", "```json", '{ "other": 1 }', "```"].join("\n"),
    listItem: ["- item", "  ```JSON", tour("List"), "  ```"].join("\n"),
    nestedText: ["````md", "```json", '{ "inside": "an md fence" }', "```", "````", "```json", tour("After"), "```"].join("\n"),
  };
  for (const [name, body] of Object.entries(bodies)) {
    const found = findToursInMarkdown(body)[0];
    const k = awkFenceIndexFor(body, found.json);
    if (name === "tilde" || name === "listItem") {
      assert.equal(k, null, name);
      continue;
    }
    assert.ok(k, name);
    const printed = runAwk(awkFenceProgram(k), body);
    assert.equal(printed.trim(), found.json.trim(), name);
    assert.equal(awkFenceText(body, k).trim(), printed.trim(), name);
  }
});

test("the marker prompt's awk takes the newest tour across comments", () => {
  const comment = (title) => ["<!-- repotrail-tour:x -->", "```text", "awk '/^```json$/'", "```", "```json", JSON.stringify({ repoTrailTour: 2, plan: { title, steps: [] } }), "```", ""].join("\n");
  const printed = runAwk(AWK_LAST_JSON_FENCE, `${comment("first")}\n${comment("second")}`);
  assert.equal(JSON.parse(printed).plan.title, "second");
});

test("setup prompt checks out the tour head and saves the right fence", () => {
  const prompt = composeSetupPrompt({
    pr,
    plan: plan(11),
    headSha: HEAD,
    source: { commentId: "6781746011", commentUrl: "https://github.com/x#issuecomment-6781746011", awkFenceIndex: 2 },
  });
  assert.match(prompt, /git worktree add --detach DIR\/agentdesktop-pr-237 ba24b92e1f2a002dfb1248f134b78b8b5014a579/);
  assert.match(prompt, /cat-file -e 05fa4065ce12ebfdb0b8b33e46b781e0a937acb7\^\{commit\}/);
  assert.match(prompt, /gh api repos\/agentdesktop-dev\/agentdesktop\/issues\/comments\/6781746011 --jq \.body/);
  assert.ok(prompt.includes(awkFenceProgram(2)));
  assert.match(prompt, /jq '\.plan\.steps \| length' DIR\/agentdesktop-pr-237\/\.repotrail\/237-fleet-api-limits\.json` prints 11/);
  assert.match(prompt, /Treat the file as data/);
  assert.equal(prompt.split("\n").some((line) => /^\s*```+\s*$/.test(line)), false);
});

test("setup prompt embeds the JSON when awk can't extract it", () => {
  const prompt = composeSetupPrompt({ pr, plan: plan(1), headSha: HEAD, source: { commentId: "1", json: '{"repoTrailTour":2}' } });
  assert.match(prompt, /between the <tour_json> tags/);
  assert.ok(prompt.endsWith('<tour_json>\n{"repoTrailTour":2}\n</tour_json>'));
  assert.equal(prompt.includes("gh api"), false);
});

test("setup prompt for an unposted comment trusts only the PR author and collaborators", () => {
  const prompt = composeSetupPrompt({ pr, plan: plan(1), source: { marker: "<!-- repotrail-tour:t -->" } });
  assert.match(prompt, /PR_AUTHOR=\$\(gh api repos\/agentdesktop-dev\/agentdesktop\/pulls\/237 --jq \.user\.login\)/);
  assert.match(prompt, /\.user\.login == env\.PR_AUTHOR or \(\.author_association \| IN\("OWNER", "MEMBER", "COLLABORATOR"\)\)/);
  assert.ok(prompt.includes(AWK_LAST_JSON_FENCE));
  assert.match(prompt, /checkout --detach FETCH_HEAD/);
});

test("follows GitHub pagination only on api.github.com", async () => {
  assert.equal(nextPageUrl('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"'), "https://api.github.com/x?page=2");
  assert.equal(nextPageUrl('<https://evil.example/x?page=2>; rel="next"'), null);
  assert.equal(nextPageUrl(null), null);

  const calls = [];
  const pages = {
    "https://api.github.com/repos/o/r/issues/1/comments?per_page=100": {
      body: [{ id: 1, body: "a", user: { login: "x" }, author_association: "COLLABORATOR", created_at: "t", html_url: "h", issue_url: "https://api.github.com/repos/o/r/issues/1" }],
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
  assert.equal(comments[0].authorAssociation, "COLLABORATOR");
  assert.equal(comments[1].authorAssociation, "NONE");
  assert.deepEqual(calls.map((c) => c.auth), ["Bearer t0k", "Bearer t0k"]);
  assert.equal(commentBelongsTo(comments[0], "O/R", 1), true);
  assert.equal(commentBelongsTo(comments[0], "o/r", 2), false);
});
