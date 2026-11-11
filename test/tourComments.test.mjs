import assert from "node:assert/strict";
import { test } from "node:test";
import { fencedCodeBlocks, findToursInMarkdown } from "../out-test/github/tourComments.js";

const tour = (title, extra = {}) =>
  JSON.stringify(
    {
      repoTrailTour: 2,
      exportedAt: "2026-11-10T00:00:00.000Z",
      plan: {
        kind: "pr-diff",
        title,
        summary: "",
        roots: { pr: { name: "app-pr-1", pathHint: "app-pr-1" } },
        steps: [
          {
            root: "pr",
            file: "src/a.ts",
            title: "A",
            explanation: "Uses `code` and\n```\nfences\n```\ninside a string.",
            viewMode: "diff",
            diff: { baseRef: "a".repeat(40), headRef: "b".repeat(40), scope: "file" },
          },
        ],
        ...extra,
      },
    },
    null,
    2,
  );

test("finds a tour in a comment with CRLF line endings", () => {
  const body = ["<!-- marker -->", "## Review guide", "", "```json", tour("CRLF tour"), "```", ""].join("\r\n");
  const found = findToursInMarkdown(body.replace(/\n/g, "\r\n").replace(/\r\r\n/g, "\r\n"));
  assert.equal(found.length, 1);
  assert.equal(found[0].plan.title, "CRLF tour");
  assert.equal(found[0].plan.steps[0].diff.headRef, "b".repeat(40));
  assert.ok(!found[0].json.includes("\r"));
});

test("finds every tour across several fences and keeps json fence positions", () => {
  const body = [
    "Intro",
    "```text",
    "awk '/^```json$/ {on=1}'",
    "```",
    "```json",
    '{ "not": "a tour" }',
    "```",
    "<details>",
    "<summary>Tour file</summary>",
    "",
    "```json",
    tour("First"),
    "```",
    "",
    "</details>",
    "",
    "- list item",
    "  ```JSON",
    tour("Second"),
    "  ```",
  ].join("\n");
  const found = findToursInMarkdown(body);
  assert.deepEqual(found.map((t) => t.plan.title), ["First", "Second"]);
  assert.deepEqual(found.map((t) => t.jsonFenceIndex), [2, 3]);
});

test("skips json fences that are not tour envelopes", () => {
  const bare = JSON.stringify({ kind: "pr-diff", title: "Bare plan", steps: [{ file: "a.ts", title: "A" }] });
  const envelopeWithoutSteps = JSON.stringify({ repoTrailTour: 2, plan: { title: "Empty", steps: [] } });
  const body = [
    "```json",
    bare,
    "```",
    "```json",
    "{ broken json",
    "```",
    "```json",
    envelopeWithoutSteps,
    "```",
    "```js",
    tour("Wrong language"),
    "```",
  ].join("\n");
  assert.deepEqual(findToursInMarkdown(body), []);
});

test("returns nothing for a comment without fences", () => {
  assert.deepEqual(findToursInMarkdown("LGTM. The tour is in the other comment."), []);
  assert.deepEqual(findToursInMarkdown(""), []);
});

test("closes fences only with a matching fence of at least the same length", () => {
  const blocks = fencedCodeBlocks(["````md", "```json", "{}", "```", "````", "~~~json", "{}", "~~~"].join("\n"));
  assert.deepEqual(
    blocks.map((b) => b.language),
    ["md", "json"],
  );
  assert.equal(blocks[0].content, "```json\n{}\n```");
});

test("treats an unclosed fence as running to the end of the comment", () => {
  const found = findToursInMarkdown(`Tour below\n\n\`\`\`json\n${tour("Unclosed")}\n`);
  assert.equal(found.length, 1);
  assert.equal(found[0].plan.title, "Unclosed");
});
