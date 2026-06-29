import assert from "node:assert/strict";
import { test } from "node:test";
import { diffRevealTargetForRange } from "../out-test/ux/diffReveal.js";

test("builds a diff reveal target from the prepared zero-based step range", () => {
  assert.deepEqual(
    diffRevealTargetForRange({
      start: { line: 41, character: 0 },
      end: { line: 67, character: 1 },
    }),
    {
      startLine: 41,
      startCharacter: 0,
      endLine: 67,
      endCharacter: 1,
    },
  );
});

test("clamps invalid diff reveal coordinates to the top of the file", () => {
  assert.deepEqual(
    diffRevealTargetForRange({
      start: { line: -1, character: -4 },
      end: { line: -1, character: -2 },
    }),
    {
      startLine: 0,
      startCharacter: 0,
      endLine: 0,
      endCharacter: 0,
    },
  );
});

test("translates hunk-scope diff reveal targets to the virtual hunk document", () => {
  assert.deepEqual(
    diffRevealTargetForRange(
      {
        start: { line: 41, character: 0 },
        end: { line: 67, character: 1 },
      },
      "hunk",
    ),
    {
      startLine: 0,
      startCharacter: 0,
      endLine: 26,
      endCharacter: 1,
    },
  );
});
