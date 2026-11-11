/**
 * Checks for a tour file, for agents that can't see what they wrote.
 *
 * Errors mean RepoTrail can't use something as written: invalid JSON, schema
 * violations, anything the reader drops (including beats that name unknown
 * ids), and sources that don't exist. Warnings are the skill's text budgets
 * and an estimate of how small each diagram will render. Pure: the caller
 * supplies schema errors and source file line counts.
 */

import { parseTourJson } from "../tourSerialize";
import type { SlideBlock, TourSlide, TourStep } from "../types";
import { layoutFlow, type TextMeasure } from "./flowLayout";
import { layoutSequence } from "./sequenceLayout";
import { slideBeats, textVariants } from "./timeline";

export interface LintFinding {
  /** 1-based stop number, when the finding belongs to a stop. */
  stop?: number;
  message: string;
}

export interface LintReport {
  errors: LintFinding[];
  warnings: LintFinding[];
  stops: number;
  slides: number;
}

export interface LintInput {
  /** The tour file's text. */
  text: string;
  /** Messages from validating against harness/tour.schema.json. */
  schemaErrors: string[];
  /** Line count of a step's file; null when it can't be read. */
  lineCount: (step: TourStep) => number | null;
}

export const TEXT_BUDGETS = {
  title: 60,
  titleSlideTitle: 40,
  eyebrow: 40,
  blockTitle: 40,
  bullet: 90,
  cell: 60,
  tableRows: 8,
  calloutWords: 40,
  sayWords: 30,
  codeLines: 25,
  codeLineWide: 100,
  codeLineColumn: 60,
  nodes: 12,
  nodeLabel: 28,
  nodeSub: 34,
  beats: 6,
  participants: 6,
  messages: 12,
  /** Below this, diagram labels get hard to read. */
  diagramScale: 0.7,
} as const;

/** Rough text widths for the slide fonts, close enough to estimate scale. */
export const APPROXIMATE_MEASURE: TextMeasure = (text, font) =>
  text.length * ({ label: 8.4, sub: 6.8, edge: 6.3, group: 7 } as const)[font];

const CONTENT_WIDTH = 1160;
const COLUMN_GAP = 32;

export function lintTour(input: LintInput): LintReport {
  const report: LintReport = { errors: [], warnings: [], stops: 0, slides: 0 };
  let raw: unknown;
  try {
    raw = JSON.parse(input.text);
  } catch (err) {
    report.errors.push({ message: `Not valid JSON: ${err instanceof Error ? err.message : String(err)}` });
    return report;
  }
  for (const message of input.schemaErrors) report.errors.push({ message: `Schema: ${message}` });

  const plan = parseTourJson(input.text);
  if (!plan) {
    report.errors.push({ message: "RepoTrail can't read this as a tour: it needs `plan.steps` with at least one usable stop." });
    return report;
  }
  const rawSteps = rawStepsOf(raw);
  if (rawSteps && rawSteps.length !== plan.steps.length) {
    report.errors.push({
      message: `${rawSteps.length - plan.steps.length} of ${rawSteps.length} stops can't be read and are skipped: a stop needs a \`title\`, and a \`file\` or a \`slide\`.`,
    });
  }
  report.stops = plan.steps.length;
  report.slides = plan.steps.filter((step) => step.slide).length;

  plan.steps.forEach((step, i) => {
    const stop = i + 1;
    const error = (message: string) => report.errors.push({ stop, message });
    const warn = (message: string) => report.warnings.push({ stop, message });

    if (step.file) {
      if (step.file.startsWith("/") || /^[A-Za-z]:/.test(step.file) || step.file.split("/").includes("..")) {
        error(`\`${step.file}\` must be a workspace-relative path without "..".`);
      } else {
        const lines = input.lineCount(step);
        if (lines === null) error(`\`${step.file}\` can't be read.`);
        else if (step.range && step.range.startLine > lines) error(`The range starts at line ${step.range.startLine}, past the end of \`${step.file}\` (${lines} lines).`);
        else if (step.range && step.range.endLine > lines + 1) warn(`The range ends at line ${step.range.endLine}; \`${step.file}\` has ${lines} lines.`);
      }
    }
    if (!step.slide) return;
    const slide = step.slide;
    for (const warning of slide.warnings ?? []) error(warning);
    if (plan.kind === "design-review" && !step.file) warn("The slide has no source `file` and `range`.");
    lintSlide(step.title, slide, warn);
  });
  return report;
}

function lintSlide(title: string, slide: TourSlide, warn: (message: string) => void): void {
  const b = TEXT_BUDGETS;
  const titleBudget = slide.layout === "title" ? b.titleSlideTitle : b.title;
  if (title.length > titleBudget) warn(`The title has ${title.length} characters; keep it under about ${titleBudget} so it fits on one line.`);
  if (slide.eyebrow && slide.eyebrow.length > b.eyebrow) warn(`The eyebrow has ${slide.eyebrow.length} characters; keep it under about ${b.eyebrow}.`);

  const beats = slide.beats ?? [];
  if (beats.length > b.beats) warn(`${beats.length} beats; more than about ${b.beats} usually means the slide is doing two things.`);
  slideBeats(slide).forEach((beat, i) => {
    const words = wordCount(beat.say);
    if (words > b.sayWords) warn(`Beat ${i + 1}'s \`say\` has ${words} words; keep it to one or two sentences (about ${b.sayWords} words).`);
  });

  const widths = columnWidths(slide);
  const variants = textVariants(slide);
  const others = slide.blocks.length > 1;
  slide.blocks.forEach((block, i) => {
    const where = `Block ${i + 1}${block.id.startsWith("b") && /^b\d+$/.test(block.id) ? "" : ` ("${block.id}")`}`;
    if (block.title && block.title.length > b.blockTitle) warn(`${where}'s title has ${block.title.length} characters; keep it under about ${b.blockTitle}.`);
    switch (block.type) {
      case "bullets": {
        const long = flatten(block.items).filter((item) => item.text.length > b.bullet);
        if (long.length > 0) warn(`${where}: ${long.length} bullet${long.length === 1 ? " is" : "s are"} over about ${b.bullet} characters (${long.map((item) => item.id).join(", ")}).`);
        break;
      }
      case "table": {
        if (block.rows.length > b.tableRows) warn(`${where}: ${block.rows.length} rows; tables read best at about ${b.tableRows}.`);
        const long = block.rows.flatMap((row) => row.cells.filter((cell) => cell.length > b.cell).map(() => row.id));
        if (long.length > 0) warn(`${where}: ${long.length} cell${long.length === 1 ? " is" : "s are"} over about ${b.cell} characters (rows ${[...new Set(long)].join(", ")}).`);
        break;
      }
      case "callout": {
        const words = wordCount(block.md);
        if (words > b.calloutWords) warn(`${where}: the callout has ${words} words; keep it under about ${b.calloutWords}.`);
        break;
      }
      case "code": {
        const lines = block.code.split("\n");
        const widthLimit = slide.layout === "columns" ? b.codeLineColumn : b.codeLineWide;
        if (lines.length > b.codeLines) warn(`${where}: ${lines.length} lines of code; keep snippets to about ${b.codeLines}, and use a code stop for real source.`);
        const longest = Math.max(...lines.map((line) => line.length));
        if (longest > widthLimit) warn(`${where}: a ${longest}-character line shrinks the whole snippet; wrap lines under about ${widthLimit}.`);
        break;
      }
      case "flow": {
        if (block.nodes.length > b.nodes) warn(`${where}: ${block.nodes.length} nodes; keep a diagram to about ${b.nodes}, or split it.`);
        const longLabels = block.nodes.filter((n) => n.label.length > b.nodeLabel).map((n) => n.id);
        const longSubs = block.nodes.filter((n) => (n.sub ?? "").length > b.nodeSub).map((n) => n.id);
        if (longLabels.length) warn(`${where}: node labels over about ${b.nodeLabel} characters: ${longLabels.join(", ")}.`);
        if (longSubs.length) warn(`${where}: node subs over about ${b.nodeSub} characters: ${longSubs.join(", ")}.`);
        const layout = layoutFlow(block, APPROXIMATE_MEASURE, variants);
        scaleWarning(where, layout.width, layout.height, widths.get(block.id) ?? CONTENT_WIDTH, slide.layout, others, warn, block.direction === "LR" ? " Use `TB`, fold branches, or split it." : " Split it.");
        break;
      }
      case "sequence": {
        if (block.participants.length > b.participants) warn(`${where}: ${block.participants.length} participants; about ${b.participants} fit.`);
        const messages = block.messages.length;
        if (messages > b.messages) warn(`${where}: ${messages} messages and notes; about ${b.messages} fit.`);
        const layout = layoutSequence(block, APPROXIMATE_MEASURE, variants);
        scaleWarning(where, layout.width, layout.height, widths.get(block.id) ?? CONTENT_WIDTH, slide.layout, others, warn, " Shorten labels or split the exchange.");
        break;
      }
    }
  });
}

/** Estimate the diagram's scale from the room the layout gives it. */
function scaleWarning(
  where: string,
  width: number,
  height: number,
  available: number,
  layout: TourSlide["layout"],
  others: boolean,
  warn: (message: string) => void,
  advice: string,
): void {
  const availableHeight = layout === "title" ? 260 : others ? 320 : 500;
  const scale = Math.min(available / width, availableHeight / height, 1.4);
  if (scale < TEXT_BUDGETS.diagramScale) {
    warn(`${where}: the diagram renders at about ${Math.round(scale * 100)}% (about ${Math.round(width)}×${Math.round(height)} into ${Math.round(available)}×${availableHeight}), so its labels will be small.${advice}`);
  }
}

/** Width each block gets, mirroring how the columns layout splits the slide. */
function columnWidths(slide: TourSlide): Map<string, number> {
  const widths = new Map<string, number>();
  if (slide.layout !== "columns") return widths;
  const columns = new Map<number, SlideBlock[]>();
  let previous = 0;
  for (const block of slide.blocks) {
    const column = block.column ?? previous + 1;
    previous = column;
    columns.set(column, [...(columns.get(column) ?? []), block]);
  }
  const weights = [...columns.values()].map((members) => Math.max(...members.map((m) => m.span ?? 1)));
  const total = weights.reduce((a, w) => a + w, 0);
  const free = CONTENT_WIDTH - COLUMN_GAP * (columns.size - 1);
  [...columns.values()].forEach((members, i) => {
    for (const block of members) widths.set(block.id, (free * weights[i]) / total);
  });
  return widths;
}

function flatten(items: Array<{ id: string; text: string; items?: unknown[] }>): Array<{ id: string; text: string }> {
  return items.flatMap((item) => [item, ...flatten((item.items ?? []) as Array<{ id: string; text: string; items?: unknown[] }>)]);
}

function wordCount(text: string | undefined): number {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function rawStepsOf(raw: unknown): unknown[] | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const plan = (obj.plan ?? obj) as Record<string, unknown>;
  return Array.isArray(plan?.steps) ? plan.steps : null;
}

/** Plain-text report, one finding per line, errors first. */
export function formatLintReport(report: LintReport, file: string): string {
  const line = (kind: string, f: LintFinding) => `${kind} ${f.stop ? `stop ${f.stop}: ` : ""}${f.message}`;
  const out = [
    `${file}: ${report.stops} stops (${report.slides} slides), ${report.errors.length} error${report.errors.length === 1 ? "" : "s"}, ${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"}`,
    ...report.errors.map((f) => line("error", f)),
    ...report.warnings.map((f) => line("warning", f)),
  ];
  return out.join("\n");
}
