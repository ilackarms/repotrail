import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatSelectionReference,
  selectedFullLineRange,
} from "../out-test/ux/selectionReference.js";

test("formats a selected multi-line block as a path reference plus fenced code", () => {
  assert.equal(
    formatSelectionReference({
      file: "src/extension.ts",
      startLine: 12,
      endLine: 14,
      languageId: "typescript",
      code: "const a = 1;\nconst b = 2;\nreturn a + b;",
    }),
    [
      "src/extension.ts:12-14",
      "",
      "```typescript",
      "const a = 1;",
      "const b = 2;",
      "return a + b;",
      "```",
    ].join("\n"),
  );
});

test("formats a selected single line without a redundant line range", () => {
  assert.equal(
    formatSelectionReference({
      file: "src/workspace.ts",
      workspaceFolder: "repotrail",
      startLine: 20,
      endLine: 20,
      languageId: "typescript",
      code: "export function hasWorkspaceFolders(): boolean {",
    }),
    [
      "repotrail/src/workspace.ts:20",
      "",
      "```typescript",
      "export function hasWorkspaceFolders(): boolean {",
      "```",
    ].join("\n"),
  );
});

test("expands partial selections to the full touched lines", () => {
  assert.deepEqual(
    selectedFullLineRange({
      start: { line: 3, character: 8 },
      end: { line: 5, character: 2 },
    }),
    { startLine: 3, endLine: 5 },
  );
});

test("does not include an untouched trailing line when selection ends at column zero", () => {
  assert.deepEqual(
    selectedFullLineRange({
      start: { line: 3, character: 8 },
      end: { line: 6, character: 0 },
    }),
    { startLine: 3, endLine: 5 },
  );
});

test("uses a longer fence when the selected code contains backtick fences", () => {
  assert.equal(
    formatSelectionReference({
      file: "README.md",
      startLine: 4,
      endLine: 6,
      languageId: "markdown",
      code: "```ts\nconst value = true;\n```",
    }),
    [
      "README.md:4-6",
      "",
      "````markdown",
      "```ts",
      "const value = true;",
      "```",
      "````",
    ].join("\n"),
  );
});
