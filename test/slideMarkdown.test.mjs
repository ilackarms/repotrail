import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { flowToMermaid, sequenceToMermaid, slideToMarkdown } from "../out-test/engine/slides/markdown.js";
import { normalizeSlide } from "../out-test/engine/slides/normalize.js";
import { parseTourJson, planToMarkdown } from "../out-test/engine/tourSerialize.js";

test("flows become mermaid flowcharts with safe ids, shapes, groups and edge styles", () => {
  const slide = normalizeSlide({
    blocks: [
      {
        type: "flow",
        direction: "TB",
        groups: [{ id: "ctrl", label: "Controller" }],
        nodes: [
          { id: "file.yaml", label: 'daemon "yaml"', shape: "file" },
          { id: "store", label: "Store", sub: "watch", shape: "store", group: "ctrl" },
          { id: "q-1", label: "Rows?", shape: "decision" },
        ],
        edges: ["file.yaml -> store: publish", "store --> q-1", "q-1 <-> store", "store -- file.yaml"],
      },
    ],
  });
  assert.deepEqual(flowToMermaid(slide.blocks[0]), [
    "flowchart TB",
    '  subgraph g0["Controller"]',
    '    n1[("Store<br/><small>watch</small>")]',
    "  end",
    '  n0>"daemon #quot;yaml#quot;"]',
    '  n2{"Rows?"}',
    '  n0 -->|"publish"| n1',
    "  n1 -.-> n2",
    "  n2 <--> n1",
    "  n1 --- n0",
  ]);
});

test("sequences become mermaid sequence diagrams with replies and notes", () => {
  const slide = normalizeSlide({
    blocks: [
      {
        type: "sequence",
        participants: [{ id: "ui", label: "Controller UI", shape: "actor" }, { id: "a", label: "Replica A" }],
        messages: ["ui -> a: PUT {base: 8}; then wait", "a --> ui: 200", { note: "poll #2", over: ["a"] }],
      },
    ],
  });
  assert.deepEqual(sequenceToMermaid(slide.blocks[0]), [
    "sequenceDiagram",
    "  actor p0 as Controller UI",
    "  participant p1 as Replica A",
    "  p0->>p1: PUT {base: 8}, then wait",
    "  p1-->>p0: 200",
    "  Note over p1: poll #35;2",
  ]);
});

test("slides become markdown with tables, callouts, code and narration", () => {
  const slide = normalizeSlide({
    eyebrow: "Sources",
    blocks: [
      { type: "table", title: "Modes", columns: ["", "File"], rows: [["API", "read | only"]] },
      { type: "callout", tone: "risk", md: "Careful." },
      { type: "bullets", items: ["one", { text: "two", items: ["nested"] }] },
      { type: "code", language: "sql", code: "SELECT 1" },
    ],
    beats: [{ say: "First." }, {}, { say: "Third." }],
  });
  assert.equal(
    slideToMarkdown(slide).join("\n"),
    [
      "**Sources**",
      "",
      "**Modes**",
      "",
      "|  | File |",
      "| --- | --- |",
      "| API | read \\| only |",
      "",
      "> **Risk:** Careful.",
      "",
      "- one",
      "- two",
      "  - nested",
      "",
      "```sql",
      "SELECT 1",
      "```",
      "",
      "_Narration:_",
      "",
      "1. First.",
      "2. Third.",
      "",
    ].join("\n"),
  );
});

test("the storyboard exports to markdown with mermaid diagrams", async () => {
  const plan = parseTourJson(await readFile(new URL("./fixtures/fleet-config-slides.json", import.meta.url), "utf8"));
  const md = planToMarkdown(plan, "now");
  assert.equal((md.match(/```mermaid\nflowchart/g) ?? []).length, 9);
  assert.equal((md.match(/```mermaid\nsequenceDiagram/g) ?? []).length, 1);
  assert.match(md, /## 8\. Two saves, one revision 9\n\n`agentdesktop\/docs\/design\/fleet-config-api\.md:153-166`/);
});
