import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Ajv from "ajv";
import { SLIDE_VOCABULARY, normalizeSlide } from "../out-test/engine/slides/normalize.js";
import { KINDS } from "../out-test/engine/tourSerialize.js";

const schema = JSON.parse(await readFile(new URL("../harness/tour.schema.json", import.meta.url), "utf8"));
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
const defs = schema.definitions;

const errors = (value) => (validate(value) ? [] : validate.errors.map((e) => `${e.instancePath} ${e.message}`));
const slideStep = (slide) => ({ plan: { kind: "design-review", title: "t", steps: [{ title: "s", explanation: "", slide }] } });

test("the schema's vocabularies match what RepoTrail reads", () => {
  assert.deepEqual(defs.plan.properties.kind.enum, KINDS);
  assert.deepEqual(defs.block.properties.type.enum, [...SLIDE_VOCABULARY.blockTypes]);
  assert.deepEqual(defs.slide.properties.layout.enum, [...SLIDE_VOCABULARY.layouts]);
  assert.deepEqual(defs.calloutBlock.properties.tone.enum, [...SLIDE_VOCABULARY.calloutTones]);
  assert.deepEqual(defs.flowBlock.properties.nodes.items.anyOf[1].properties.shape.enum, [...SLIDE_VOCABULARY.shapes]);
  assert.deepEqual(defs.patch.properties.tone.enum, [...SLIDE_VOCABULARY.tones]);
  for (const type of SLIDE_VOCABULARY.blockTypes) assert.ok(defs[`${type}Block`], `no schema for ${type} blocks`);
});

test("the fleet configuration storyboards are valid", async () => {
  for (const name of ["fleet-config-slides.json", "fleet-config-agent-written.json", "slides-morph.json"]) {
    const tour = JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
    assert.deepEqual(errors(tour), [], name);
  }
});

test("a tour an agent wrote from the skill alone reads with no warnings", async () => {
  const { parseTourJson } = await import("../out-test/engine/tourSerialize.js");
  const plan = parseTourJson(await readFile(new URL("./fixtures/fleet-config-agent-written.json", import.meta.url), "utf8"));
  assert.equal(plan.kind, "design-review");
  assert.equal(plan.steps.length, 20);
  assert.deepEqual(plan.steps.flatMap((step) => step.slide?.warnings ?? []), []);
});

test("accepts envelopes, bare plans and plain code tours", () => {
  const steps = [{ title: "A", file: "src/a.ts", range: { startLine: 1, endLine: 4 }, explanation: "", viewMode: "code", actions: ["openFile"] }];
  assert.deepEqual(errors({ repoTrailTour: 2, exportedAt: "now", plan: { kind: "architecture", title: "t", summary: "", steps } }), []);
  assert.deepEqual(errors({ kind: "pr-diff", title: "t", steps }), []);
});

test("a slide using every block type and beat field is valid and reads with no warnings", () => {
  const slide = {
    layout: "columns",
    eyebrow: "Everything",
    subtitle: "Every block",
    blocks: [
      { type: "text", id: "intro", md: "Some **markdown** with `code`." },
      { type: "bullets", id: "list", ordered: true, column: 1, items: ["one", { id: "two", text: "two", tone: "good", items: ["nested"] }] },
      { type: "table", id: "tbl", columns: ["a", "b"], rows: [["1", 2], { id: "row", cells: ["x", "y"], tone: "warn" }] },
      { type: "code", id: "sql", language: "sql", startLine: 10, code: "SELECT 1\nFROM t" },
      { type: "callout", id: "note", tone: "question", title: "Q", md: "Why?" },
      {
        type: "flow",
        id: "graph",
        direction: "TB",
        span: 1.5,
        groups: ["g1", { id: "g2", label: "Group", tone: "accent" }],
        nodes: ["a", { id: "b", label: "B", sub: "sub", shape: "store", tone: "bad", badge: "rev 1", group: "g2" }],
        edges: ["a -> b: label", { id: "back", from: "b", to: "a", style: "dashed", arrow: "both", tone: "muted" }],
      },
      {
        type: "sequence",
        id: "seq",
        participants: ["ui", { id: "api", label: "API", shape: "service" }],
        messages: ["ui -> api: PUT", { from: "api", to: "ui", label: "200", reply: true }, { note: "later", over: ["api"] }],
      },
    ],
    beats: [
      { say: "First.", show: ["b"], flow: ["a->b"], focus: ["a", "b"] },
      { say: "Second.", set: { b: { label: "B2", sub: "s2", badge: "rev 2", tone: "good" } }, highlight: "sql:L10-11", pulse: ["b"] },
      { hide: ["note"], flow: [{ edge: "back", label: "reply", tone: "accent", reverse: true }] },
    ],
  };
  assert.deepEqual(errors(slideStep(slide)), []);
  assert.equal(normalizeSlide(slide).warnings, undefined);
});

test("rejects the mistakes an author is likely to make", () => {
  const bad = (slide) => errors(slideStep(slide)).join("\n");
  assert.match(bad({ blocks: [{ type: "bullets", items: [{ label: "not text" }] }] }), /items/);
  assert.match(bad({ blocks: [{ type: "flow", nodes: ["a", "b"], edges: ["a => b"] }] }), /pattern/);
  assert.match(bad({ blocks: [{ type: "flow", nodes: [{ id: "a", text: "A" }] }] }), /additional properties/);
  assert.match(bad({ blocks: [{ type: "chart" }] }), /allowed values/);
  assert.match(bad({ blocks: [{ type: "callout", tone: "danger", md: "x" }] }), /allowed values/);
  assert.match(bad({ blocks: [], beats: [{ focuss: ["a"] }] }), /additional properties/);
  assert.match(bad({ blocks: [{ type: "text", id: "has space", md: "x" }] }), /pattern/);
  assert.match(bad({ layout: "grid", blocks: [] }), /allowed values/);
  assert.match(errors({ plan: { title: "t", steps: [{ title: "neither file nor slide" }] } }).join("\n"), /required property 'file'/);
  assert.match(errors({ plan: { title: "t", steps: [{ title: "up", file: "../secret" }] } }).join("\n"), /pattern/);
  assert.match(errors({ plan: { title: "t", steps: [{ title: "abs", file: "/etc/passwd" }] } }).join("\n"), /pattern/);
});

test("the skill's slide examples are valid and read with no warnings", async () => {
  const skill = await readFile(new URL("../harness/repo-trail/SKILL.md", import.meta.url), "utf8");
  const fences = [...skill.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  const blocks = fences.filter((f) => /^\{\s*"type": "(flow|sequence)"/.test(f)).map((f) => JSON.parse(f));
  const beatsFence = fences.find((f) => f.startsWith('"beats": ['));
  assert.equal(blocks.length, 2);
  assert.ok(beatsFence);
  // Ids are per slide, and both examples use "api", so they go on separate slides.
  const flowSlide = { blocks: [blocks.find((b) => b.type === "flow")], ...JSON.parse(`{${beatsFence}}`) };
  const sequenceSlide = { blocks: [blocks.find((b) => b.type === "sequence")] };
  for (const slide of [flowSlide, sequenceSlide]) {
    assert.deepEqual(errors(slideStep(slide)), []);
    assert.equal(normalizeSlide(slide).warnings, undefined, normalizeSlide(slide).warnings?.join("\n"));
  }
});

test("refs are valid on nodes, participants and code, and must stay in the workspace", () => {
  const ok = errors(slideStep({ blocks: [
    { type: "flow", nodes: [{ id: "a", ref: { file: "src/a.rs", range: { startLine: 1, endLine: 4 } } }] },
    { type: "sequence", participants: [{ id: "p", ref: { root: "api", file: "lib/p.ts" } }], messages: [] },
    { type: "code", code: "x", ref: { file: "docs/x.md" } },
  ] }));
  assert.deepEqual(ok, []);
  assert.match(errors(slideStep({ blocks: [{ type: "flow", nodes: [{ id: "a", ref: { file: "../up" } }] }] })).join("\n"), /pattern/);
  assert.match(errors(slideStep({ blocks: [{ type: "code", code: "x", ref: { path: "x" } }] })).join("\n"), /required property 'file'/);
});
