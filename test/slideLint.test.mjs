import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { formatLintReport, lintTour } from "../out-test/engine/slides/lint.js";

const tour = (steps, kind = "design-review") => JSON.stringify({ repoTrailTour: 2, plan: { kind, title: "t", summary: "", steps } });
const lint = (text, lineCount = () => 100, schemaErrors = []) => lintTour({ text, schemaErrors, lineCount });
const messages = (findings) => findings.map((f) => `${f.stop ?? "-"}: ${f.message}`).join("\n");

test("the hand-written storyboard has no errors", async () => {
  const text = await readFile(new URL("./fixtures/fleet-config-slides.json", import.meta.url), "utf8");
  const report = lint(text, () => 700);
  assert.deepEqual(report.errors, []);
  assert.equal(report.stops, 16);
  assert.equal(report.slides, 14);
});

test("errors: bad JSON, schema problems, dropped stops, unknown beat ids, missing sources", () => {
  assert.match(messages(lint("{ nope").errors), /Not valid JSON/);
  const report = lint(
    tour([
      { title: "ok", file: "doc.md", range: { startLine: 1, endLine: 5 }, explanation: "", slide: { blocks: [{ type: "flow", nodes: ["a"] }], beats: [{ focus: ["ghost"] }] } },
      { title: "no file or slide", explanation: "" },
      { title: "missing", file: "gone.md", explanation: "" },
      { title: "past the end", file: "doc.md", range: { startLine: 400, endLine: 410 }, explanation: "" },
      { title: "escape", file: "../etc/passwd", explanation: "" },
    ]),
    (step) => (step.file === "gone.md" ? null : 100),
    ["/plan/steps/1 must have required property 'file'"],
  );
  const text = messages(report.errors);
  assert.match(text, /-: Schema: \/plan\/steps\/1 must have required property 'file'/);
  assert.match(text, /-: 1 of 5 stops can't be read/);
  assert.match(text, /1: Beat 1 focus: unknown id "ghost"/);
  assert.match(text, /2: `gone\.md` can't be read/);
  assert.match(text, /3: The range starts at line 400, past the end of `doc\.md` \(100 lines\)/);
  assert.match(text, /4: `\.\.\/etc\/passwd` must be a workspace-relative path/);
});

test("warnings: text over budget, too many beats, a diagram too wide to read, a slide without a source", () => {
  const chain = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => ({ id, label: `Service ${id.toUpperCase()} handler` }));
  const report = lint(
    tour([
      {
        title: "A headline that goes on and on well past what fits on one line of a slide",
        explanation: "",
        slide: {
          blocks: [
            { type: "flow", id: "wide", nodes: chain, edges: chain.slice(1).map((n, i) => `${chain[i].id} -> ${n.id}`) },
            { type: "callout", md: Array.from({ length: 50 }, () => "word").join(" ") },
          ],
          beats: Array.from({ length: 8 }, (_, i) => ({ say: i === 0 ? Array.from({ length: 40 }, () => "word").join(" ") : "Short." })),
        },
      },
    ]),
  );
  assert.deepEqual(report.errors, []);
  const text = messages(report.warnings);
  assert.match(text, /The title has 73 characters/);
  assert.match(text, /8 beats/);
  assert.match(text, /Beat 1's `say` has 40 words/);
  assert.match(text, /Block 2: the callout has 50 words/);
  assert.match(text, /Block 1 \("wide"\): the diagram renders at about \d+%.*Use `TB`/);
  assert.match(text, /The slide has no source `file` and `range`/);
});

test("formats a report with errors first", () => {
  const report = { stops: 2, slides: 1, errors: [{ stop: 1, message: "bad" }], warnings: [{ message: "meh" }] };
  assert.equal(formatLintReport(report, "t.json"), "t.json: 2 stops (1 slides), 1 error, 1 warning\nerror stop 1: bad\nwarning meh");
});
