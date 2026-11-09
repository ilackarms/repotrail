import assert from "node:assert/strict";
import { test } from "node:test";
import { mapDiffPositionToSource, sameDocumentText, wordAt } from "../out-test/ux/diffPositionMap.js";

const source = [
  "import { refresh } from './token';",
  "",
  "export function check(session) {",
  "  if (session.expired) {",
  "    return refresh(session);",
  "  }",
  "  return session;",
  "}",
];

test("maps hunk slices with an exact line offset", () => {
  assert.deepEqual(
    mapDiffPositionToSource({
      virtualLines: source.slice(3, 6),
      position: { line: 1, character: 12 },
      sourceLines: source,
      lineOffset: 3,
    }),
    { line: 4, character: 12 },
  );
});

test("maps a base-side line to the matching current line nearest its old position", () => {
  const base = ["export function check(session) {", "  if (session.expired) {", "    return refresh(session);", "  }", "}"];
  assert.deepEqual(
    mapDiffPositionToSource({
      virtualLines: base,
      position: { line: 2, character: 12 },
      word: "refresh",
      sourceLines: source,
    }),
    { line: 4, character: 12 },
  );
});

test("adjusts the column when only indentation changed", () => {
  const base = ["if (session.expired) {", "return refresh(session);"];
  assert.deepEqual(
    mapDiffPositionToSource({
      virtualLines: base,
      position: { line: 1, character: 8 },
      word: "refresh",
      sourceLines: source,
    }),
    { line: 4, character: 12 },
  );
});

test("picks the identical line nearest the clicked line", () => {
  const lines = ["  return session;", "", "", "", "", "  return session;"];
  const virtualLines = ["", "", "", "", "  return session;"];
  assert.deepEqual(
    mapDiffPositionToSource({ virtualLines, position: { line: 4, character: 10 }, word: "session", sourceLines: lines }),
    { line: 5, character: 10 },
  );
});

test("falls back to the nearest occurrence of the word when the line was rewritten", () => {
  assert.deepEqual(
    mapDiffPositionToSource({
      virtualLines: ["", "", "", "", "    return refresh(session, { force: true });"],
      position: { line: 4, character: 12 },
      word: "refresh",
      sourceLines: source,
    }),
    { line: 4, character: 11 },
  );
});

test("returns null when neither the line nor the word exists in the current file", () => {
  assert.equal(
    mapDiffPositionToSource({
      virtualLines: ["deleted(thing);"],
      position: { line: 0, character: 2 },
      word: "deleted",
      sourceLines: source,
    }),
    null,
  );
});

test("reads the identifier touching a column, including at its end", () => {
  assert.equal(wordAt("return refresh(session);", 9), "refresh");
  assert.equal(wordAt("return refresh(session);", 14), "refresh");
  assert.equal(wordAt("a + b", 2), "");
});

test("compares document text ignoring line endings", () => {
  assert.equal(sameDocumentText("a\r\nb\r\n", "a\nb\n"), true);
  assert.equal(sameDocumentText("a\nb", "a\nc"), false);
});
