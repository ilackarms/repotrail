import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const { version } = JSON.parse(read("package.json"));

// The skill runs `npx repotrail@<version>`, so the npm package, the skill and
// the plugin are released together.
test("the skill pins the npm CLI to this release", () => {
  const pins = [...read("harness/repo-trail/SKILL.md").matchAll(/repotrail@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  assert.ok(pins.length > 0, "the skill names a pinned repotrail version");
  assert.deepEqual([...new Set(pins)], [version]);
});

test("the Claude Code plugin's version matches the release", () => {
  assert.equal(JSON.parse(read("harness/.claude-plugin/plugin.json")).version, version);
});
