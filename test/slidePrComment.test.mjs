import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { composePrComment, GITHUB_COMMENT_LIMIT } from "../out-test/github/prTour.js";
import { findToursInMarkdown } from "../out-test/github/tourComments.js";
import { parseTourJson } from "../out-test/engine/tourSerialize.js";

const pr = { owner: "agentdesktop-dev", repo: "agentdesktop", number: 244 };
const roundTrip = (plan) => {
  const result = composePrComment({ plan, pr, exportedAt: "2026-11-11T00:00:00.000Z", extensionId: "repotrail.repotrail" });
  assert.equal(result.ok, true);
  const found = findToursInMarkdown(result.body);
  assert.equal(found.length, 1);
  return { result, back: found[0].plan };
};

for (const name of ["fleet-config-slides.json", "fleet-config-agent-written.json"]) {
  test(`a slide tour survives the PR comment round trip: ${name}`, async () => {
    const plan = parseTourJson(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
    const { result, back } = roundTrip(plan);
    assert.ok(result.body.length < GITHUB_COMMENT_LIMIT);
    assert.equal(back.kind, "design-review");
    assert.deepEqual(back.steps.map((s) => s.title), plan.steps.map((s) => s.title));
    assert.deepEqual(back.steps.map((s) => s.slide ?? null), plan.steps.map((s) => s.slide ?? null));
    assert.equal(result.body.includes('"warnings"'), false);
  });
}

test("code fences inside slide text don't end the comment's json block", () => {
  const plan = parseTourJson(
    JSON.stringify({
      plan: {
        kind: "design-review",
        title: "Fences",
        steps: [
          {
            title: "Fenced",
            explanation: "```\nnot a fence in json\n```",
            slide: {
              blocks: [
                { type: "text", md: "Before\n```sql\nSELECT 1\n```\nAfter" },
                { type: "code", code: "```\nnested\n```" },
              ],
            },
          },
        ],
      },
    }),
  );
  const { back } = roundTrip(plan);
  assert.deepEqual(back.steps[0].slide, plan.steps[0].slide);
  assert.equal(back.steps[0].explanation, plan.steps[0].explanation);
});
