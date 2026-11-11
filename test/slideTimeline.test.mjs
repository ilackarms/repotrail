import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSlide } from "../out-test/engine/slides/normalize.js";
import { layoutSequence } from "../out-test/engine/slides/sequenceLayout.js";
import {
  effectsEntering,
  expandIds,
  moveCursor,
  narrationAt,
  positionCount,
  scheduleFlows,
  slideBeats,
  stateAt,
  textVariants,
} from "../out-test/engine/slides/timeline.js";

const measure = (text, font) => text.length * ({ label: 8.6, sub: 7, edge: 6.6, group: 7 }[font] ?? 8);

function slideOf(raw) {
  const slide = normalizeSlide(raw);
  assert.equal(slide.warnings, undefined, slide.warnings?.join("\n"));
  return slide;
}

const race = slideOf({
  blocks: [
    {
      type: "flow",
      id: "race",
      nodes: ["alice", "bob", { id: "db", label: "revisions", sub: "latest: 8" }, { id: "conflict", label: "409" }],
      edges: [{ id: "a", from: "alice", to: "db" }, { id: "b", from: "bob", to: "db" }, "bob -> conflict"],
    },
    { type: "code", id: "sql", code: "INSERT\nSELECT\nWHERE\n= $base" },
  ],
  beats: [
    { say: "Both save.", flow: ["a", "b"] },
    { say: "A wins.", set: { db: { sub: "latest: 9", tone: "good" } }, focus: ["alice", "a", "db"] },
    { say: "B gets a 409.", show: ["conflict"], set: { bob: { tone: "bad" } }, focus: ["bob", "sql:L3-4"], pulse: ["conflict"] },
  ],
});

test("an element a beat shows starts hidden, and its edges hide with it", () => {
  assert.deepEqual(stateAt(race, 0).hidden, ["conflict", "bob->conflict"]);
  assert.deepEqual(stateAt(race, 2).hidden, ["conflict", "bob->conflict"]);
  assert.deepEqual(stateAt(race, 3).hidden, []);
});

test("set accumulates; focus and highlight last one beat", () => {
  assert.deepEqual(stateAt(race, 1).patches, {});
  assert.deepEqual(stateAt(race, 1).focus, []);
  assert.deepEqual(stateAt(race, 2).focus, ["alice", "a", "db"]);
  assert.deepEqual(stateAt(race, 3).patches, { db: { sub: "latest: 9", tone: "good" }, bob: { tone: "bad" } });
  assert.deepEqual(stateAt(race, 3).focus, ["bob", "sql:L3", "sql:L4"]);
  assert.deepEqual(stateAt(race, 99).position, 3);
});

test("entering a beat reports what appears, flows and pulses", () => {
  assert.deepEqual(effectsEntering(race, 0), { appear: [], flows: [], pulse: [] });
  const first = effectsEntering(race, 1);
  assert.deepEqual(first.flows.map((f) => [f.edge, f.slot]), [["a", 0], ["b", 0]]);
  const third = effectsEntering(race, 3);
  assert.deepEqual(third.appear, ["conflict", "bob->conflict"]);
  assert.deepEqual(third.pulse, ["conflict"]);
});

test("a flow that starts where the last one ended waits for it", () => {
  const chain = slideOf({
    blocks: [{ type: "flow", nodes: ["f", "w", "s", "d", "x"], edges: ["f -> w", "w -> s", "s -> d", "x -> d"] }],
  });
  const flows = scheduleFlows(chain, [{ edge: "f->w" }, { edge: "w->s" }, { edge: "s->d" }, { edge: "x->d" }, { edge: "s->d", reverse: true }]);
  assert.deepEqual(flows.map((f) => [f.edge, f.from, f.to, f.slot]), [
    ["f->w", "f", "w", 0],
    ["w->s", "w", "s", 1],
    ["s->d", "s", "d", 2],
    ["x->d", "x", "d", 2],
    ["s->d", "d", "s", 3],
  ]);
});

test("build reveals bullets, rows and messages one beat each", () => {
  const slide = slideOf({
    blocks: [
      { type: "bullets", id: "qs", items: ["one", "two"], build: true },
      { type: "sequence", id: "seq", participants: ["ui", "api"], messages: ["ui -> api: PUT", "api --> ui: 200"], build: true },
    ],
  });
  assert.deepEqual(slideBeats(slide), [
    { show: ["qs.1"] },
    { show: ["qs.2"] },
    { show: ["seq.1"], highlight: ["seq.1"] },
    { show: ["seq.2"], highlight: ["seq.2"] },
  ]);
  assert.deepEqual(stateAt(slide, 0).hidden, ["qs.1", "qs.2", "seq.1", "seq.2"]);
  assert.deepEqual(stateAt(slide, 3).hidden, ["seq.2"]);
  assert.equal(slide.blocks[1].messages[1].reply, true);
});

test("explicit beats win over build, with a warning", () => {
  const slide = normalizeSlide({ blocks: [{ type: "bullets", items: ["a"], build: true }, { type: "code", code: "x", build: true }], beats: [{ say: "hi" }] });
  assert.equal(slideBeats(slide).length, 1);
  assert.match(slide.warnings.join("\n"), /build` works on bullets, tables and sequences, not code/);
  assert.match(slide.warnings.join("\n"), /Block "b1": `build` is ignored because the slide has `beats`/);
});

test("hiding a block hides what's inside it, and a hidden participant hides its messages", () => {
  const slide = slideOf({
    blocks: [
      { type: "sequence", id: "seq", participants: ["ui", "api", "db"], messages: ["ui -> api", "api -> db", { note: "later", over: ["db"] }] },
      { type: "bullets", id: "list", items: [{ text: "parent", items: ["child"] }] },
    ],
    beats: [{ show: ["db"] }, { hide: ["list"] }],
  });
  assert.deepEqual(stateAt(slide, 0).hidden, ["db", "seq.2", "seq.3"]);
  assert.deepEqual(stateAt(slide, 2).hidden, ["list", "list.1", "list.1.1"]);
});

test("cursor moves through beats, then stops; Back lands on a slide's last beat", () => {
  const steps = [
    { title: "code", file: "a.ts", explanation: "", actions: [] },
    { title: "race", explanation: "", actions: [], slide: race },
    { title: "more code", file: "b.ts", explanation: "", actions: [] },
  ];
  assert.equal(positionCount(steps[1]), 4);
  assert.deepEqual(moveCursor(steps, { index: 0, beat: 0 }, "next"), { index: 1, beat: 0 });
  assert.deepEqual(moveCursor(steps, { index: 1, beat: 0 }, "next"), { index: 1, beat: 1 });
  assert.deepEqual(moveCursor(steps, { index: 1, beat: 3 }, "next"), { index: 2, beat: 0 });
  assert.deepEqual(moveCursor(steps, { index: 1, beat: 1 }, "nextStop"), { index: 2, beat: 0 });
  assert.deepEqual(moveCursor(steps, { index: 2, beat: 0 }, "back"), { index: 1, beat: 3 });
  assert.deepEqual(moveCursor(steps, { index: 1, beat: 2 }, "back"), { index: 1, beat: 1 });
  assert.deepEqual(moveCursor(steps, { index: 1, beat: 9 }, "back"), { index: 1, beat: 2 });
  assert.equal(moveCursor(steps, { index: 0, beat: 0 }, "back"), null);
  assert.equal(moveCursor(steps, { index: 2, beat: 0 }, "next"), null);
});

test("narration is the explanation at position 0, then each beat's say", () => {
  const step = { title: "Race", explanation: "Revisions only go up.", actions: [], slide: race };
  assert.equal(narrationAt(step, 0), "Race. Revisions only go up.");
  assert.equal(narrationAt(step, 2), "A wins.");
  assert.equal(narrationAt({ title: "Code", file: "a.ts", explanation: "x", actions: [] }, 3), "Code. x");
});

test("collects the text a beat swaps in, and expands code line ranges", () => {
  assert.deepEqual([...textVariants(race)], [["db", { label: [], sub: ["latest: 9"] }], ["bob", { label: [], sub: [] }]]);
  assert.deepEqual(expandIds(["a", "sql:L2-4", "sql:L7"]), ["a", "sql:L2", "sql:L3", "sql:L4", "sql:L7"]);
});

test("sequence layout: columns fit labels, rows go down, self-calls loop", () => {
  const slide = slideOf({
    blocks: [
      {
        type: "sequence",
        participants: [{ id: "ui", label: "Controller UI", shape: "actor" }, { id: "a", label: "Replica A" }, { id: "db", label: "Database", shape: "store" }],
        messages: [
          "ui -> a: PUT /api/v1/daemon-config {base_revision: 8}",
          "a -> a: parse_daemon",
          "a -> db: insert 9 if the latest is 8",
          { note: "Replica B finds out at its next poll", over: ["a", "db"] },
          "a --> ui: 200 {revision: 9}",
        ],
      },
    ],
  });
  const layout = layoutSequence(slide.blocks[0], measure);
  const [ui, a] = layout.participants;
  const longest = measure("PUT /api/v1/daemon-config {base_revision: 8}", "sub");
  assert.ok(a.x + a.width / 2 - (ui.x + ui.width / 2) >= longest, "the first gap fits its label");
  const ys = layout.messages.map((m) => m.y);
  assert.deepEqual([...ys].sort((p, q) => p - q), ys);
  assert.equal(layout.messages[1].self, true);
  assert.equal(layout.notes.length, 1);
  assert.ok(layout.notes[0].y > layout.messages[2].y && layout.notes[0].y < layout.messages[3].y);
  for (const lifeline of layout.lifelines) assert.ok(lifeline.y2 > layout.messages[3].y);
  assert.ok(layout.width > 0 && layout.height > layout.messages[3].y);
  assert.ok(Math.min(...layout.participants.map((p) => p.x)) >= 0);
});

test("the fleet configuration storyboard parses cleanly", async () => {
  const { readFile } = await import("node:fs/promises");
  const { parseTourJson } = await import("../out-test/engine/tourSerialize.js");
  const plan = parseTourJson(await readFile(new URL("./fixtures/fleet-config-slides.json", import.meta.url), "utf8"));
  assert.equal(plan.steps.length, 16);
  const problems = plan.steps.flatMap((step, i) => (step.slide?.warnings ?? []).map((w) => `stop ${i + 1}: ${w}`));
  assert.deepEqual(problems, []);
  assert.equal(plan.steps.filter((s) => s.slide).length, 14);
  assert.equal(positionCount(plan.steps[9]), 10, "the sequence builds one beat per message and note");
});

test("reading time grows with the words, within bounds", async () => {
  const { readingTimeMs } = await import("../out-test/engine/slides/timeline.js");
  assert.equal(readingTimeMs(""), 1800);
  assert.equal(readingTimeMs(Array.from({ length: 26 }, () => "word").join(" ")), 10700);
  assert.equal(readingTimeMs(Array.from({ length: 500 }, () => "word").join(" ")), 15000);
});
