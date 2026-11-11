import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { test } from "node:test";
import {
  checkedOutPr,
  defaultBranchOf,
  prFileUrl,
  pullRequestsCheckoutLink,
  remoteBranchesInclude,
  samePr,
} from "../out-test/github/pullRequestsExtension.js";

const pr = { owner: "solo-io", repo: "gloo", number: 42 };

test("reads the checked-out PR from GitHub Pull Requests' repository description", () => {
  assert.deepEqual(
    checkedOutPr({
      owner: "solo-io",
      repositoryName: "gloo",
      defaultBranch: "main",
      pullRequest: { title: "Fix", url: "https://github.com/solo-io/gloo/pull/42", number: 42, id: 7 },
    }),
    pr,
  );
});

test("names a fork checkout by the PR's own URL, not the fork's repository", () => {
  assert.deepEqual(
    checkedOutPr({
      owner: "alice",
      repositoryName: "gloo",
      pullRequest: { url: "https://github.com/solo-io/gloo/pull/42", number: 42 },
    }),
    pr,
  );
  // A URL that isn't a github.com PR falls back to the description's repository.
  assert.deepEqual(
    checkedOutPr({
      owner: "solo-io",
      repositoryName: "gloo",
      pullRequest: { url: "https://ghe.example.com/solo-io/gloo/pull/42", number: 42 },
    }),
    pr,
  );
});

test("treats a description with no PR, or an odd one, as nothing checked out", () => {
  assert.equal(checkedOutPr(undefined), undefined);
  assert.equal(checkedOutPr({ owner: "solo-io", repositoryName: "gloo" }), undefined);
  assert.equal(checkedOutPr({ owner: "solo-io", repositoryName: "gloo", pullRequest: null }), undefined);
  assert.equal(checkedOutPr({ owner: "solo-io", repositoryName: "gloo", pullRequest: { number: "42" } }), undefined);
  assert.equal(checkedOutPr({ owner: "solo-io", repositoryName: "gloo", pullRequest: { number: 0 } }), undefined);
  assert.equal(checkedOutPr({ owner: "-bad-", repositoryName: "gloo", pullRequest: { number: 42 } }), undefined);
  assert.equal(checkedOutPr({ owner: "solo-io", repositoryName: "../x", pullRequest: { number: 42 } }), undefined);
});

test("compares PRs ignoring owner and repo case", () => {
  assert.equal(samePr(pr, { owner: "Solo-IO", repo: "Gloo", number: 42 }), true);
  assert.equal(samePr(pr, { owner: "solo-io", repo: "gloo", number: 43 }), false);
  assert.equal(samePr(pr, { owner: "solo-io", repo: "gloo-ee", number: 42 }), false);
});

test("builds the extension's checkout link", () => {
  assert.equal(
    pullRequestsCheckoutLink("vscode", pr),
    "vscode://github.vscode-pull-request-github/checkout-pull-request?uri=https%3A%2F%2Fgithub.com%2Fsolo-io%2Fgloo%2Fpull%2F42",
  );
  const link = new URL(pullRequestsCheckoutLink("vscode-insiders", pr));
  assert.equal(link.searchParams.get("uri"), "https://github.com/solo-io/gloo/pull/42");
});

test("links a file in the PR's Files changed tab, with a new-side line when given", () => {
  const hash = crypto.createHash("sha256").update("pkg/api/server.go").digest("hex");
  assert.equal(prFileUrl(pr, "pkg/api/server.go"), `https://github.com/solo-io/gloo/pull/42/files#diff-${hash}`);
  assert.equal(prFileUrl(pr, "pkg/api/server.go", 17), `https://github.com/solo-io/gloo/pull/42/files#diff-${hash}R17`);
  assert.equal(prFileUrl(pr, "/pkg\\api/server.go", 17), `https://github.com/solo-io/gloo/pull/42/files#diff-${hash}R17`);
  assert.equal(prFileUrl(pr, "pkg/api/server.go", 0), `https://github.com/solo-io/gloo/pull/42/files#diff-${hash}`);
});

test("accepts only plain default branch names", () => {
  assert.equal(defaultBranchOf({ defaultBranch: "main" }), "main");
  assert.equal(defaultBranchOf({ defaultBranch: "release/1.x" }), "release/1.x");
  assert.equal(defaultBranchOf({ defaultBranch: "-main" }), undefined);
  assert.equal(defaultBranchOf({ defaultBranch: "a..b" }), undefined);
  assert.equal(defaultBranchOf({ defaultBranch: "has space" }), undefined);
  assert.equal(defaultBranchOf({}), undefined);
});

test("spots the default branch among remote branches that hold a commit", () => {
  assert.equal(remoteBranchesInclude("origin/feature\nupstream/main\n", "main"), true);
  assert.equal(remoteBranchesInclude("origin/release/1.x\r\n", "release/1.x"), true);
  assert.equal(remoteBranchesInclude("origin/feature\norigin/main-backup\n", "main"), false);
  assert.equal(remoteBranchesInclude("", "main"), false);
});
