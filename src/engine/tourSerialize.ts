/**
 * Pure (de)serialization for shareable tours.
 *
 * Lives in the engine layer: no `vscode`, no filesystem. The UX layer owns the
 * save/open dialogs and file IO; this module only turns a TourPlan into a
 * portable string and back. Markdown is the human-readable artifact; JSON is
 * the re-importable one.
 */

import {
  formatStepPath,
  TourAction,
  TourKind,
  TourPlan,
  TourStep,
  TourStepDiff,
  TourStepViewMode,
} from "./types";

const EXPORT_VERSION = 1;

interface TourExportEnvelope {
  repoTrailTour: number; // schema version marker
  exportedAt: string;
  plan: TourPlan;
}

/** Serialize a plan to a re-importable JSON envelope. */
export function planToJson(plan: TourPlan, exportedAt: string): string {
  const envelope: TourExportEnvelope = {
    repoTrailTour: EXPORT_VERSION,
    exportedAt,
    plan,
  };
  return JSON.stringify(envelope, null, 2);
}

/**
 * Parse a previously-exported tour. Accepts three shapes for resilience:
 *   1. the export envelope `{ repoTrailTour, plan }`
 *   2. a stored TourRecord `{ plan, ... }`
 *   3. a bare TourPlan `{ kind, title, steps }`
 * Returns null if nothing plan-shaped is found.
 */
export function parseTourJson(text: string): TourPlan | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const candidate = (obj.plan as unknown) ?? raw;
  return normalizePlan(candidate);
}

function normalizePlan(value: unknown): TourPlan | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  if (!Array.isArray(p.steps)) return null;
  const steps = p.steps
    .map(normalizeStep)
    .filter((s): s is TourStep => s !== null);
  if (steps.length === 0) return null;
  return {
    kind: normalizeKind(p.kind),
    title: typeof p.title === "string" && p.title.trim() ? p.title : "Imported tour",
    summary: typeof p.summary === "string" ? p.summary : "",
    steps,
  };
}

function normalizeStep(value: unknown): TourStep | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  if (typeof s.file !== "string" || typeof s.title !== "string") return null;
  const range = normalizeRange(s.range);
  const diff = normalizeDiff(s.diff);
  const viewMode = normalizeViewMode(s.viewMode, diff);
  return {
    title: s.title,
    workspaceFolder: typeof s.workspaceFolder === "string" ? s.workspaceFolder : undefined,
    file: s.file,
    explanation: typeof s.explanation === "string" ? s.explanation : "",
    range,
    viewMode,
    diff,
    symbol: typeof s.symbol === "string" ? s.symbol : undefined,
    anchor: typeof s.anchor === "string" ? s.anchor : undefined,
    actions: defaultActions(range, diff, viewMode),
  };
}

function normalizeRange(value: unknown): TourStep["range"] {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  if (typeof r.startLine !== "number" || typeof r.endLine !== "number") return undefined;
  return {
    startLine: num(r.startLine, 1),
    startColumn: num(r.startColumn, 1),
    endLine: num(r.endLine, r.startLine as number),
    endColumn: num(r.endColumn, 1),
  };
}

function normalizeDiff(value: unknown): TourStepDiff | undefined {
  if (!value || typeof value !== "object") return undefined;
  const d = value as Record<string, unknown>;
  if (typeof d.beforeText !== "string") return undefined;
  return {
    beforeText: d.beforeText,
    afterText: typeof d.afterText === "string" ? d.afterText : undefined,
    beforeLabel: typeof d.beforeLabel === "string" ? d.beforeLabel : undefined,
    afterLabel: typeof d.afterLabel === "string" ? d.afterLabel : undefined,
    languageId: typeof d.languageId === "string" ? d.languageId : undefined,
  };
}

function normalizeViewMode(value: unknown, diff: TourStepDiff | undefined): TourStepViewMode | undefined {
  if (value === "code" || value === "diff" || value === "both") {
    return diff || value === "code" ? value : undefined;
  }
  return diff ? "both" : undefined;
}

function defaultActions(
  range: TourStep["range"],
  diff: TourStepDiff | undefined,
  viewMode: TourStepViewMode | undefined,
): TourAction[] {
  const mode = diff ? viewMode ?? "both" : "code";
  const actions: TourAction[] = [];
  if (mode !== "diff") {
    actions.push("openFile");
    if (range) actions.push("highlightRange");
  }
  if (diff && mode !== "code") actions.push("showDiff");
  actions.push("showNarration");
  return actions;
}

const KINDS: TourKind[] = [
  "architecture",
  "pr-diff",
  "file-walkthrough",
  "request-lifecycle",
  "bug-investigation",
];

function normalizeKind(value: unknown): TourKind {
  return KINDS.includes(value as TourKind) ? (value as TourKind) : "architecture";
}

/**
 * Render a plan as a readable markdown document. Each stop carries a
 * `file:line` reference so a reader can jump there; the explanation is kept
 * verbatim (it's already markdown).
 */
export function planToMarkdown(plan: TourPlan, exportedAt: string): string {
  const lines: string[] = [];
  lines.push(`# ${plan.title || "RepoTrail tour"}`);
  lines.push("");
  lines.push(`_${plan.kind} tour · ${plan.steps.length} stops · exported ${exportedAt}_`);
  lines.push("");
  if (plan.summary.trim()) {
    lines.push(plan.summary.trim());
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  plan.steps.forEach((step, i) => {
    lines.push(`## ${i + 1}. ${step.title}`);
    lines.push("");
    lines.push(`\`${stepLocation(step)}\``);
    lines.push("");
    if (step.diff) {
      lines.push(`_Diff view: ${step.viewMode ?? "both"}_`);
      lines.push("");
    }
    if (step.explanation.trim()) {
      lines.push(step.explanation.trim());
      lines.push("");
    }
  });
  return lines.join("\n");
}

function stepLocation(step: TourStep): string {
  const target = formatStepPath(step);
  if (!step.range) return target;
  const { startLine, endLine } = step.range;
  return startLine === endLine
    ? `${target}:${startLine}`
    : `${target}:${startLine}-${endLine}`;
}

/** Filesystem-safe slug for a default export filename. */
export function slugForFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return slug || "tour";
}
