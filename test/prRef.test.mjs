import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parsePrInput,
  parseReviewLink,
  reviewLink,
  vscodeDevRedirect,
} from "../out-test/github/prRef.js";

const SHA = "ba24b92e1f2a002dfb1248f134b78b8b5014a579";
const pr = { owner: "agentdesktop-dev", repo: "agentdesktop", number: 237 };

test("parses PR URLs, comment URLs and owner/repo#n", () => {
  assert.deepEqual(parsePrInput("https://github.com/agentdesktop-dev/agentdesktop/pull/237"), { pr });
  assert.deepEqual(parsePrInput("  https://github.com/agentdesktop-dev/agentdesktop/pull/237/  "), { pr });
  assert.deepEqual(
    parsePrInput("https://github.com/agentdesktop-dev/agentdesktop/pull/237#issuecomment-6781746011"),
    { pr, commentId: "6781746011" },
  );
  assert.deepEqual(parsePrInput("agentdesktop-dev/agentdesktop#237"), { pr });
  assert.deepEqual(parsePrInput("o/r.js#1"), { pr: { owner: "o", repo: "r.js", number: 1 } });
});

test("accepts a pasted review link", () => {
  assert.deepEqual(
    parsePrInput(`vscode://repotrail.repotrail/review?pr=agentdesktop-dev/agentdesktop/237&head=${SHA}`),
    { pr, head: SHA },
  );
});

test("rejects hosts other than github.com", () => {
  for (const input of [
    "https://gitlab.com/o/r/pull/1",
    "https://www.github.com/o/r/pull/1",
    "https://github.com.evil.example/o/r/pull/1",
    "https://evil.example/github.com/o/r/pull/1",
    "https://user@github.com/o/r/pull/1",
    "https://github.com:8443/o/r/pull/1",
    "http://github.com/o/r/pull/1",
  ]) {
    assert.throws(() => parsePrInput(input), Error, input);
  }
});

test("rejects extra or missing path segments", () => {
  for (const input of [
    "https://github.com/o/r/pull/1/files",
    "https://github.com/o/r/pull/1/commits/abc",
    "https://github.com/o/r/pull",
    "https://github.com/o/r/issues/1",
    "https://github.com/o/r/x/pull/1",
    "https://github.com/o/r/pull/1#discussion_r123",
    "o/r/x#1",
  ]) {
    assert.throws(() => parsePrInput(input), Error, input);
  }
});

test("rejects bad slugs and numbers", () => {
  for (const input of [
    "-owner/repo#1",
    "owner-/repo#1",
    "own_er/repo#1",
    "owner/re po#1",
    "owner/..#1",
    "owner/repo.git#1",
    "owner/repo#0",
    "owner/repo#012",
    "owner/repo#1e3",
    "owner/repo#99999999999",
    `${"a".repeat(40)}/repo#1`,
  ]) {
    assert.throws(() => parsePrInput(input), Error, input);
  }
});

test("parses review links and ignores keys added by redirectors", () => {
  assert.deepEqual(parseReviewLink("/review", "pr=agentdesktop-dev/agentdesktop/237"), { pr });
  assert.deepEqual(
    parseReviewLink(
      "/review",
      `pr=agentdesktop-dev%2Fagentdesktop%2F237&comment=6781746011&head=${SHA.toUpperCase()}&url=vscode%3A%2F%2Fwhatever`,
    ),
    { pr, commentId: "6781746011", head: SHA },
  );
});

test("rejects malformed review links", () => {
  const cases = [
    ["/open", "pr=o/r/1"],
    ["/review", ""],
    ["/review", "pr=o/r"],
    ["/review", "pr=o/r/1/2"],
    ["/review", "pr=o/r/1&pr=o/r/2"],
    ["/review", "pr=o/r/1&comment=abc"],
    ["/review", "pr=o/r/1&comment=-1"],
    ["/review", `pr=o/r/1&head=${SHA.slice(0, 39)}`],
    ["/review", `pr=o/r/1&head=${SHA.slice(0, 39)}g`],
    ["/review", `pr=o/r/1&head=${SHA}0`],
    ["/review", "pr=o/r/1&head=HEAD"],
    ["/review", "pr=../r/1"],
    ["/review", "pr=o/r;rm -rf/1"],
  ];
  for (const [path, query] of cases) {
    assert.throws(() => parseReviewLink(path, query), Error, `${path}?${query}`);
  }
});

test("builds the canonical link and the vscode.dev redirect", () => {
  const link = reviewLink("vscode", "repotrail.repotrail", { pr, head: SHA });
  assert.equal(link, `vscode://repotrail.repotrail/review?pr=agentdesktop-dev/agentdesktop/237&head=${SHA}`);
  assert.equal(
    vscodeDevRedirect(link),
    `https://vscode.dev/redirect?url=${encodeURIComponent(link)}`,
  );
  const url = new URL(link);
  assert.deepEqual(parseReviewLink(url.pathname, url.search.slice(1)), { pr, head: SHA });
});
