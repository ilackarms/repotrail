import assert from "node:assert/strict";
import { test } from "node:test";
import { editorSpan } from "../out-test/engine/range.js";

const lines = ["fn main() {", "    let x = 1;", "", "    run(x);", "}"];
const span = (range) => editorSpan(range, lines.length, (n) => lines[n].length);

test("endColumn 1 highlights all of endLine instead of stopping before it", () => {
  assert.deepEqual(span({ startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 }), {
    startLine: 0,
    startCharacter: 0,
    endLine: 1,
    endCharacter: lines[1].length,
  });
});

test("a single-line range with endColumn 1 is the whole line, not empty", () => {
  assert.deepEqual(span({ startLine: 4, startColumn: 1, endLine: 4, endColumn: 1 }), {
    startLine: 3,
    startCharacter: 0,
    endLine: 3,
    endCharacter: lines[3].length,
  });
});

test("real columns still narrow the first and last line", () => {
  assert.deepEqual(span({ startLine: 2, startColumn: 9, endLine: 2, endColumn: 10 }), {
    startLine: 1,
    startCharacter: 8,
    endLine: 1,
    endCharacter: 9,
  });
});

test("a range that would be empty highlights its whole line", () => {
  assert.deepEqual(span({ startLine: 2, startColumn: 9, endLine: 2, endColumn: 5 }), {
    startLine: 1,
    startCharacter: 0,
    endLine: 1,
    endCharacter: lines[1].length,
  });
});

test("ranges past the end of the file clamp to its last line", () => {
  assert.deepEqual(span({ startLine: 4, startColumn: 1, endLine: 40, endColumn: 1 }), {
    startLine: 3,
    startCharacter: 0,
    endLine: 4,
    endCharacter: lines[4].length,
  });
  assert.deepEqual(span({ startLine: 3, startColumn: 1, endLine: 1, endColumn: 1 }).endLine, 2);
});
