import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSlide, parseEdge } from "../out-test/engine/slides/normalize.js";
import { parseTourJson, planToJson, planToMarkdown } from "../out-test/engine/tourSerialize.js";

test("parses edge shorthand: arrows, dashes, labels and hyphenated ids", () => {
  assert.deepEqual(parseEdge("watch -> store: publish"), {
    from: "watch",
    to: "store",
    label: "publish",
    style: "solid",
    arrow: "end",
  });
  assert.deepEqual(parseEdge("dev --> svc"), { from: "dev", to: "svc", label: undefined, style: "dashed", arrow: "end" });
  assert.equal(parseEdge("a <-> b").arrow, "both");
  assert.equal(parseEdge("a <--> b").style, "dashed");
  assert.equal(parseEdge("a -- b").arrow, "none");
  const hyphen = parseEdge("replica-a -> db: PUT {base: 8}");
  assert.equal(hyphen.from, "replica-a");
  assert.equal(hyphen.to, "db");
  assert.equal(hyphen.label, "PUT {base: 8}");
  assert.equal(parseEdge("not an edge"), undefined);
});

test("assigns default ids and keeps explicit ones", () => {
  const slide = normalizeSlide({
    blocks: [
      { type: "bullets", items: ["one", { text: "two", id: "second" }, { text: "three", items: ["nested"] }] },
      { type: "table", id: "modes", columns: ["", "File", "Database"], rows: [["Writes", "watcher", "PUT"], { cells: ["API", "read-only"], tone: "warn" }] },
      { type: "code", code: "a\nb\nc\n" },
    ],
  });
  assert.equal(slide.warnings, undefined);
  const [bullets, table, code] = slide.blocks;
  assert.equal(bullets.id, "b1");
  assert.deepEqual(bullets.items.map((i) => i.id), ["b1.1", "second", "b1.3"]);
  assert.equal(bullets.items[2].items[0].id, "b1.3.1");
  assert.equal(table.id, "modes");
  assert.deepEqual(table.rows.map((r) => r.id), ["modes.1", "modes.2"]);
  assert.deepEqual(table.rows[1].cells, ["API", "read-only", ""]);
  assert.equal(table.rows[1].tone, "warn");
  assert.equal(code.id, "b3");
  assert.equal(code.code, "a\nb\nc");
});

test("a default block id never takes an id an author chose", () => {
  const slide = normalizeSlide({ blocks: [{ type: "text", md: "x" }, { type: "text", id: "b1", md: "y" }] });
  assert.deepEqual(slide.blocks.map((b) => b.id), ["b1#2", "b1"]);
  assert.equal(slide.warnings, undefined);
});

test("normalizes a flow: shapes, groups, edge ids and repeats", () => {
  const slide = normalizeSlide({
    layout: "columns",
    blocks: [
      {
        type: "flow",
        direction: "tb",
        groups: [{ id: "ctrl", label: "Controller" }],
        nodes: [
          { id: "file", label: "daemon.yaml", shape: "file" },
          { id: "store", label: "DaemonConfigStore", shape: "store", group: "ctrl", badge: "rev 1" },
          "dev",
        ],
        edges: ["file -> store: publish", "store -> dev", "store -> dev: again", { from: "dev", to: "store", style: "dashed", id: "status" }],
      },
    ],
  });
  assert.equal(slide.warnings, undefined);
  const flow = slide.blocks[0];
  assert.equal(slide.layout, "columns");
  assert.equal(flow.direction, "TB");
  assert.deepEqual(flow.nodes.map((n) => [n.id, n.label, n.shape, n.group ?? null]), [
    ["file", "daemon.yaml", "file", null],
    ["store", "DaemonConfigStore", "store", "ctrl"],
    ["dev", "dev", "box", null],
  ]);
  assert.deepEqual(flow.edges.map((e) => e.id), ["file->store", "store->dev", "store->dev#2", "status"]);
  assert.equal(flow.edges[3].style, "dashed");
});

test("drops what it can't use and says why", () => {
  const slide = normalizeSlide({
    layout: "grid",
    blocks: [
      { type: "chart", series: [] },
      { type: "flow", nodes: [{ id: "a" }, { id: "a" }, { label: "no id" }], edges: ["a -> ghost", "a -> a"] },
      { type: "text" },
      { type: "callout", tone: "danger", md: "Careful" },
    ],
  });
  assert.equal(slide.layout, "stack");
  assert.deepEqual(slide.blocks.map((b) => b.type), ["flow", "callout"]);
  assert.equal(slide.blocks[0].nodes.length, 1);
  assert.deepEqual(slide.blocks[0].edges.map((e) => e.id), ["a->a"]);
  assert.equal(slide.blocks[1].tone, "info");
  const text = slide.warnings.join("\n");
  assert.match(text, /Unknown layout "grid"/);
  assert.match(text, /Block 1: unknown type "chart"/);
  assert.match(text, /id "a" is already used/);
  assert.match(text, /node 3 needs an id/);
  assert.match(text, /"ghost" isn't a node/);
  assert.match(text, /Block 3: `md` is missing/);
  assert.match(text, /unknown callout tone "danger"/);
});

test("checks beat targets, including code line ranges", () => {
  const slide = normalizeSlide({
    blocks: [
      { type: "flow", nodes: ["alice", "db"], edges: ["alice -> db"] },
      { type: "code", id: "sql", code: "INSERT\nSELECT\nWHERE", startLine: 10 },
    ],
    beats: [
      { say: "Both save.", flow: ["alice->db", "nope"] },
      { focus: ["alice", "sql:L12", "sql:L9", "ghost"], set: { db: { badge: "rev 9", tone: "good" }, ghost: { tone: "bad" } } },
    ],
  });
  assert.deepEqual(slide.beats[0].flow, [{ edge: "alice->db" }]);
  assert.deepEqual(slide.beats[1].focus, ["alice", "sql:L12"]);
  assert.deepEqual(slide.beats[1].set, { db: { badge: "rev 9", tone: "good" } });
  const text = slide.warnings.join("\n");
  assert.match(text, /Beat 1 flow: "nope" isn't an edge/);
  assert.match(text, /Beat 2 focus: unknown id "sql:L9"/);
  assert.match(text, /Beat 2 focus: unknown id "ghost"/);
  assert.match(text, /Beat 2 set: unknown id "ghost"/);
});

test("caps sizes", () => {
  const slide = normalizeSlide({
    blocks: [{ type: "code", code: Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") }],
    eyebrow: "x".repeat(500),
  });
  assert.equal(slide.blocks[0].code.split("\n").length, 120);
  assert.equal(slide.eyebrow.length, 200);
  assert.equal(slide.warnings.length, 2);
});

test("parseTourJson keeps slide stops without a file and drops file-less non-slides", () => {
  const plan = parseTourJson(
    JSON.stringify({
      repoTrailTour: 2,
      plan: {
        kind: "design-review",
        title: "Fleet config",
        summary: "",
        steps: [
          { title: "Today", explanation: "How config reaches devices.", slide: { blocks: [{ type: "text", md: "hi" }, { type: "nope" }] } },
          { title: "Code", file: "src/a.rs", explanation: "" },
          { title: "No file, no slide", explanation: "" },
          { title: "Sourced slide", file: "docs/design.md", range: { startLine: 3, endLine: 9 }, explanation: "", slide: { blocks: [] } },
        ],
      },
    }),
  );
  assert.equal(plan.kind, "design-review");
  assert.deepEqual(plan.steps.map((s) => s.title), ["Today", "Code", "Sourced slide"]);
  assert.equal(plan.steps[0].file, undefined);
  assert.deepEqual(plan.steps[0].actions, ["showNarration"]);
  assert.equal(plan.steps[0].slide.warnings.length, 1);
  assert.equal(plan.steps[2].file, "docs/design.md");
  assert.equal(plan.steps[2].range.startLine, 3);

  const json = planToJson(plan, "2026-11-11T00:00:00.000Z");
  assert.equal(json.includes("warnings"), false);
  assert.deepEqual(parseTourJson(json).steps[0].slide.blocks, plan.steps[0].slide.blocks);

  const md = planToMarkdown(plan, "now");
  assert.match(md, /## 1\. Today\n\n`Slide`\n\n_Slide_/);
  assert.match(md, /`docs\/design\.md:3-9`/);
});

test("places blocks in columns", () => {
  const slide = normalizeSlide({
    layout: "columns",
    blocks: [
      { type: "text", md: "left", span: 1.5 },
      { type: "text", md: "right" },
      { type: "text", md: "also right", column: 2 },
      { type: "text", md: "bad", column: 9 },
    ],
  });
  assert.deepEqual(slide.blocks.map((b) => [b.column ?? null, b.span ?? null]), [[null, 1.5], [null, null], [2, null], [null, null]]);
  assert.match(slide.warnings.join("\n"), /Block 4: column must be a whole number from 1 to 4/);
});

test("reads refs on nodes, participants and code, and rejects paths that escape", () => {
  const slide = normalizeSlide({
    blocks: [
      { type: "flow", nodes: [{ id: "a", ref: { file: "src/a.rs", range: { startLine: 3, endLine: 9 } } }, { id: "b", ref: { file: "../etc/passwd" } }] },
      { type: "sequence", participants: [{ id: "p", ref: { root: "api", file: "lib/p.ts" } }], messages: [] },
      { type: "code", code: "x", ref: { file: "/abs/path" } },
    ],
  });
  const [flow, seq, code] = slide.blocks;
  assert.deepEqual(flow.nodes[0].ref, { file: "src/a.rs", range: { startLine: 3, startColumn: 1, endLine: 9, endColumn: 1 } });
  assert.equal(flow.nodes[1].ref, undefined);
  assert.deepEqual(seq.participants[0].ref, { root: "api", file: "lib/p.ts" });
  assert.equal(code.ref, undefined);
  assert.match(slide.warnings.join("\n"), /node 2 ref: "\.\.\/etc\/passwd" must be a workspace-relative path/);
  assert.match(slide.warnings.join("\n"), /Block 3 ref: "\/abs\/path" must be a workspace-relative path/);
});
