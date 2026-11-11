import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutFlow, wrap } from "../out-test/engine/slides/flowLayout.js";
import { normalizeSlide } from "../out-test/engine/slides/normalize.js";

// Rough widths for the slide fonts; the webview measures real text.
const measure = (text, font) => text.length * ({ label: 8.6, sub: 7, edge: 6.6, group: 7 }[font] ?? 8);

function flowOf(block) {
  const slide = normalizeSlide({ blocks: [{ type: "flow", ...block }] });
  assert.equal(slide.warnings, undefined, slide.warnings?.join("\n"));
  return slide.blocks[0];
}

const today = {
  direction: "LR",
  groups: [{ id: "ctrl", label: "Controller" }],
  nodes: [
    { id: "file", label: "daemon.yaml", shape: "file" },
    { id: "watch", label: "daemon_config::watch", sub: "validates with parse_daemon", group: "ctrl" },
    { id: "store", label: "DaemonConfigStore", shape: "store", group: "ctrl" },
    { id: "svc", label: "FleetAgentService", group: "ctrl" },
    { id: "dev", label: "Devices", shape: "device" },
    { id: "status", label: "device_config_status", shape: "store" },
  ],
  edges: [
    "file -> watch: fs event",
    "watch -> store: publish",
    "store -> svc",
    "svc -> dev: DaemonConfig {rev 1}",
    "dev --> svc: ConfigStatus",
    "svc -> status",
  ],
};

function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test("places every node without overlaps, inside the canvas", () => {
  const layout = layoutFlow(flowOf(today), measure);
  assert.equal(layout.nodes.length, 6);
  for (const [i, a] of layout.nodes.entries()) {
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.width <= layout.width && a.y + a.height <= layout.height, a.id);
    for (const b of layout.nodes.slice(i + 1)) assert.equal(overlaps(a, b), false, `${a.id} overlaps ${b.id}`);
  }
});

test("routes every edge and keeps labels off nodes", () => {
  const layout = layoutFlow(flowOf(today), measure);
  assert.equal(layout.edges.length, 6);
  for (const edge of layout.edges) {
    assert.ok(edge.points.length >= 2, edge.id);
    if (!edge.label) continue;
    for (const node of layout.nodes) assert.equal(overlaps(edge.label, node), false, `${edge.id} label on ${node.id}`);
  }
  assert.ok(layout.edges.find((e) => e.id === "file->watch").label);
  assert.equal(layout.edges.find((e) => e.id === "store->svc").label, undefined);
});

test("a group box contains its members and no other node", () => {
  const layout = layoutFlow(flowOf(today), measure);
  const [group] = layout.groups;
  assert.equal(group.id, "ctrl");
  const members = new Set(["watch", "store", "svc"]);
  for (const node of layout.nodes) {
    const inside =
      node.x >= group.x && node.y >= group.y && node.x + node.width <= group.x + group.width && node.y + node.height <= group.y + group.height;
    if (members.has(node.id)) assert.ok(inside, `${node.id} outside its group`);
    else assert.equal(overlaps(node, group), false, `${node.id} overlaps the group`);
  }
});

test("is deterministic", () => {
  assert.deepEqual(layoutFlow(flowOf(today), measure), layoutFlow(flowOf(today), measure));
});

test("top-to-bottom flows stack ranks vertically", () => {
  const layout = layoutFlow(flowOf({ direction: "TB", nodes: ["a", "b", "c"], edges: ["a -> b", "b -> c"] }), measure);
  const [a, b, c] = layout.nodes;
  assert.ok(a.y < b.y && b.y < c.y);
});

test("shapes reserve room for their decoration", () => {
  const layout = layoutFlow(
    flowOf({ nodes: [{ id: "box", label: "Same" }, { id: "db", label: "Same", shape: "store" }, { id: "q", label: "Same?", shape: "decision" }] }),
    measure,
  );
  const [box, db, q] = layout.nodes;
  assert.ok(db.height > box.height);
  assert.ok(q.height > box.height);
});

test("wraps long labels on spaces into at most two lines", () => {
  assert.deepEqual(wrap("one two three", "label", 70, measure, 2), ["one two", "three"]);
  assert.deepEqual(wrap("a b c d e f g h", "label", 30, measure, 2), ["a b", "c d e f g h"]);
  assert.deepEqual(wrap("daemon_config_revisions", "label", 50, measure, 2), ["daemon_config_revisions"]);
});
