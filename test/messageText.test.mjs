import assert from "node:assert/strict";
import { test } from "node:test";
import { plainMessageText } from "../out-test/ux/messageText.js";

// The link pattern VS Code's notifications use (LinkedText), copied from the workbench.
const VSCODE_LINK = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^\)\s]+)(?: (["'])(.+?)(\3))?\)/gi;

test("breaks every link VS Code would render in a notification", () => {
  const titles = [
    "Review guide [notes](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22id%5Cn%22%7D)",
    "[Retry](https://evil.example/x) and [file](file:///etc/passwd)",
    'Nested [a [b](command:x)](command:y "title")',
    "Line\nbreak [x](command:y)",
  ];
  for (const title of titles) {
    const safe = plainMessageText(title, 1000);
    assert.equal([...safe.matchAll(VSCODE_LINK)].length, 0, safe);
  }
  assert.equal([...titles[0].matchAll(VSCODE_LINK)].length, 1);
});

test("keeps ordinary text and truncates long values", () => {
  assert.equal(plainMessageText("#237: fleet API limits"), "#237: fleet API limits");
  assert.equal(plainMessageText("a".repeat(10), 5), "aaaa…");
});
