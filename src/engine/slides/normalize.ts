/**
 * Reads the `slide` object of a tour step into a TourSlide.
 *
 * Slides can come from a stranger's PR comment, so nothing here is trusted:
 * every field is type-checked, sizes are capped, and anything RepoTrail can't
 * use is dropped with a warning instead of failing the whole tour. Warnings
 * travel on `slide.warnings` so the slide panel can show them to the author.
 */

import type {
  SlideBeat,
  SlideBlock,
  SlideBulletItem,
  SlideBulletsBlock,
  SlideCalloutTone,
  SlideCodeBlock,
  SlideElementPatch,
  SlideFlowBlock,
  SlideFlowEdge,
  SlideFlowEffect,
  SlideFlowGroup,
  SlideFlowNode,
  SlideLayout,
  SlideNodeShape,
  SlideTableRow,
  SlideTone,
  TourSlide,
} from "../types";

export const SLIDE_LIMITS = {
  blocks: 12,
  bullets: 40,
  rows: 40,
  columns: 8,
  nodes: 40,
  edges: 80,
  groups: 12,
  beats: 40,
  codeLines: 120,
  text: 4000,
  label: 200,
} as const;

const TONES: readonly SlideTone[] = ["default", "accent", "good", "warn", "bad", "muted"];
const CALLOUT_TONES: readonly SlideCalloutTone[] = ["info", "warn", "risk", "decision", "question"];
const LAYOUTS: readonly SlideLayout[] = ["stack", "columns", "title"];
const SHAPES: readonly SlideNodeShape[] = [
  "box",
  "service",
  "store",
  "file",
  "actor",
  "device",
  "queue",
  "external",
  "decision",
  "note",
];
const ID_PATTERN = /^[^\s:]{1,64}$/;
const EDGE_PATTERN = /^(.+?)\s*(<-->|<->|-->|->|--)\s*(.+?)\s*(?::\s*(.*))?$/;
const CODE_LINE_REF = /^(.+):L(\d+)(?:-(\d+))?$/;

type Raw = Record<string, unknown>;
type BlockBase = { id: string; title?: string; column?: number; span?: number; build?: boolean };

/**
 * Normalize a raw slide value. Returns undefined when the value isn't an
 * object at all; otherwise a slide (possibly with no blocks) plus warnings.
 */
export function normalizeSlide(value: unknown): TourSlide | undefined {
  if (!isObject(value)) return undefined;
  const ctx = new SlideContext();
  const raw = value;

  let layout: SlideLayout = "stack";
  if (raw.layout !== undefined) {
    if (LAYOUTS.includes(raw.layout as SlideLayout)) layout = raw.layout as SlideLayout;
    else ctx.warn(`Unknown layout ${describe(raw.layout)}; using "stack".`);
  }

  const blocks: SlideBlock[] = [];
  const rawBlocks = Array.isArray(raw.blocks) ? raw.blocks : [];
  if (raw.blocks !== undefined && !Array.isArray(raw.blocks)) ctx.warn("`blocks` must be an array.");
  if (rawBlocks.length > SLIDE_LIMITS.blocks) {
    ctx.warn(`Only the first ${SLIDE_LIMITS.blocks} of ${rawBlocks.length} blocks are shown.`);
  }
  // Claim explicit block ids first so a default id never takes one an author chose.
  rawBlocks.slice(0, SLIDE_LIMITS.blocks).forEach((b) => {
    if (isObject(b) && typeof b.id === "string" && ID_PATTERN.test(b.id.trim())) ctx.reserve(b.id.trim());
  });
  rawBlocks.slice(0, SLIDE_LIMITS.blocks).forEach((rawBlock, i) => {
    const block = normalizeBlock(rawBlock, i, ctx);
    if (block) blocks.push(block);
  });

  const slide: TourSlide = { layout, blocks };
  const eyebrow = ctx.text(raw.eyebrow, "eyebrow", SLIDE_LIMITS.label);
  if (eyebrow) slide.eyebrow = eyebrow;
  const subtitle = ctx.text(raw.subtitle, "subtitle", SLIDE_LIMITS.label);
  if (subtitle) slide.subtitle = subtitle;

  const beats = normalizeBeats(raw.beats, ctx);
  if (beats.length > 0) slide.beats = beats;
  if (ctx.warnings.length > 0) slide.warnings = ctx.warnings;
  return slide;
}

class SlideContext {
  readonly warnings: string[] = [];
  private readonly reserved = new Set<string>();
  private readonly used = new Set<string>();
  /** Every element id a beat may target. */
  readonly elements = new Set<string>();
  /** Code blocks by id with their line ranges, for `<block>:L<n>` targets. */
  readonly codeLines = new Map<string, { first: number; last: number }>();
  readonly edges = new Set<string>();

  warn(message: string): void {
    if (this.warnings.length < 50) this.warnings.push(message);
  }

  reserve(id: string): void {
    this.reserved.add(id);
  }

  /**
   * Claim an explicit id, or a default one when the explicit id is missing,
   * invalid or taken. Default ids skip any id an author reserved.
   */
  claim(explicit: unknown, fallback: string, what: string, reserved = false): string {
    if (explicit !== undefined) {
      const id = typeof explicit === "string" ? explicit.trim() : "";
      if (!ID_PATTERN.test(id)) {
        this.warn(`${what}: id ${describe(explicit)} isn't valid (1-64 characters, no spaces or colons); using a default id.`);
      } else if (this.used.has(id)) {
        this.warn(`${what}: id "${id}" is already used on this slide; using a default id.`);
      } else if (!reserved && this.reserved.has(id)) {
        this.warn(`${what}: id "${id}" is already used on this slide; using a default id.`);
      } else {
        return this.take(id);
      }
    }
    let candidate = fallback;
    for (let n = 2; this.used.has(candidate) || this.reserved.has(candidate); n++) candidate = `${fallback}#${n}`;
    return this.take(candidate);
  }

  private take(id: string): string {
    this.used.add(id);
    this.elements.add(id);
    return id;
  }

  /** A display string: strings and finite numbers, capped at `max` characters. */
  text(value: unknown, what: string, max: number): string | undefined {
    if (value === undefined || value === null) return undefined;
    let text: string;
    if (typeof value === "string") text = value;
    else if (typeof value === "number" && Number.isFinite(value)) text = String(value);
    else {
      this.warn(`${what} must be text; ignored ${describe(value)}.`);
      return undefined;
    }
    if (text.length > max) {
      this.warn(`${what} is longer than ${max} characters and was cut.`);
      text = `${text.slice(0, max - 1)}…`;
    }
    return text;
  }

  tone(value: unknown, what: string): SlideTone | undefined {
    if (value === undefined) return undefined;
    if (TONES.includes(value as SlideTone)) return value as SlideTone;
    this.warn(`${what}: unknown tone ${describe(value)}.`);
    return undefined;
  }
}

function normalizeBlock(value: unknown, index: number, ctx: SlideContext): SlideBlock | undefined {
  const where = `Block ${index + 1}`;
  if (!isObject(value)) {
    ctx.warn(`${where} isn't an object.`);
    return undefined;
  }
  const type = value.type;
  const known = ["text", "bullets", "table", "code", "callout", "flow"];
  if (typeof type !== "string" || !known.includes(type)) {
    ctx.warn(`${where}: unknown type ${describe(type)}. This RepoTrail version shows ${known.join(", ")}.`);
    return undefined;
  }
  const id = ctx.claim(value.id, `b${index + 1}`, where, true);
  const base: BlockBase = { id };
  const title = ctx.text(value.title, `${where} title`, SLIDE_LIMITS.label);
  if (title) base.title = title;
  if (value.column !== undefined) {
    if (Number.isInteger(value.column) && (value.column as number) >= 1 && (value.column as number) <= 4) base.column = value.column as number;
    else ctx.warn(`${where}: column must be a whole number from 1 to 4.`);
  }
  if (value.span !== undefined) {
    if (typeof value.span === "number" && value.span > 0 && value.span <= 12) base.span = value.span;
    else ctx.warn(`${where}: span must be a number from 1 to 12.`);
  }
  if (value.build === true) base.build = true;

  switch (type) {
    case "text": {
      const md = ctx.text(value.md ?? value.text, `${where} md`, SLIDE_LIMITS.text);
      if (!md) return missing(ctx, where, "md");
      return { ...base, type: "text", md };
    }
    case "callout": {
      const md = ctx.text(value.md ?? value.text, `${where} md`, SLIDE_LIMITS.text);
      if (!md) return missing(ctx, where, "md");
      let tone: SlideCalloutTone = "info";
      if (value.tone !== undefined) {
        if (CALLOUT_TONES.includes(value.tone as SlideCalloutTone)) tone = value.tone as SlideCalloutTone;
        else ctx.warn(`${where}: unknown callout tone ${describe(value.tone)}; using "info".`);
      }
      return { ...base, type: "callout", tone, md };
    }
    case "code": {
      const raw = ctx.text(value.code ?? value.text, `${where} code`, SLIDE_LIMITS.text * 4);
      if (raw === undefined) return missing(ctx, where, "code");
      let lines = raw.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
      if (lines.length > SLIDE_LIMITS.codeLines) {
        ctx.warn(`${where}: only the first ${SLIDE_LIMITS.codeLines} lines are shown.`);
        lines = lines.slice(0, SLIDE_LIMITS.codeLines);
      }
      const block: SlideCodeBlock = { ...base, type: "code", code: lines.join("\n") };
      const language = ctx.text(value.language, `${where} language`, 40);
      if (language) block.language = language;
      if (value.startLine !== undefined) {
        if (Number.isInteger(value.startLine) && (value.startLine as number) >= 1) block.startLine = value.startLine as number;
        else ctx.warn(`${where}: startLine must be a whole number of 1 or more.`);
      }
      const first = block.startLine ?? 1;
      ctx.codeLines.set(id, { first, last: first + lines.length - 1 });
      return block;
    }
    case "bullets": {
      const items = normalizeBullets(value.items, id, `${where}`, ctx, 0);
      if (items.length === 0) return missing(ctx, where, "items");
      const block: SlideBulletsBlock = { ...base, type: "bullets", items };
      if (value.ordered === true) block.ordered = true;
      return block;
    }
    case "table":
      return normalizeTable(value, base, where, ctx);
    case "flow":
      return normalizeFlow(value, base, where, ctx);
  }
  return undefined;
}

function missing(ctx: SlideContext, where: string, field: string): undefined {
  ctx.warn(`${where}: \`${field}\` is missing or empty, so the block is skipped.`);
  return undefined;
}

function normalizeBullets(
  value: unknown,
  parentId: string,
  where: string,
  ctx: SlideContext,
  depth: number,
): SlideBulletItem[] {
  if (!Array.isArray(value)) return [];
  if (depth === 0 && value.length > SLIDE_LIMITS.bullets) {
    ctx.warn(`${where}: only the first ${SLIDE_LIMITS.bullets} bullets are shown.`);
  }
  const items: SlideBulletItem[] = [];
  value.slice(0, SLIDE_LIMITS.bullets).forEach((raw, i) => {
    const fallback = `${parentId}.${i + 1}`;
    const what = `${where} bullet ${i + 1}`;
    if (typeof raw === "string" || typeof raw === "number") {
      const text = ctx.text(raw, what, SLIDE_LIMITS.text);
      if (text) items.push({ id: ctx.claim(undefined, fallback, what), text });
      return;
    }
    if (!isObject(raw)) {
      ctx.warn(`${what} must be text or an object with \`text\`.`);
      return;
    }
    const text = ctx.text(raw.text, what, SLIDE_LIMITS.text);
    if (!text) {
      ctx.warn(`${what} has no \`text\`.`);
      return;
    }
    const item: SlideBulletItem = { id: ctx.claim(raw.id, fallback, what), text };
    const tone = ctx.tone(raw.tone, what);
    if (tone) item.tone = tone;
    if (raw.items !== undefined) {
      if (depth >= 1) ctx.warn(`${what}: bullets nest two levels deep at most.`);
      else {
        const children = normalizeBullets(raw.items, item.id, what, ctx, depth + 1);
        if (children.length > 0) item.items = children;
      }
    }
    items.push(item);
  });
  return items;
}

function normalizeTable(
  value: Raw,
  base: BlockBase,
  where: string,
  ctx: SlideContext,
): SlideBlock | undefined {
  let columns: string[] = [];
  if (value.columns !== undefined) {
    if (Array.isArray(value.columns)) {
      columns = value.columns
        .slice(0, SLIDE_LIMITS.columns)
        .map((c, i) => ctx.text(c, `${where} column ${i + 1}`, SLIDE_LIMITS.label) ?? "");
      if (value.columns.length > SLIDE_LIMITS.columns) {
        ctx.warn(`${where}: only the first ${SLIDE_LIMITS.columns} columns are shown.`);
      }
    } else {
      ctx.warn(`${where}: \`columns\` must be an array of headings.`);
    }
  }
  if (!Array.isArray(value.rows) || value.rows.length === 0) return missing(ctx, where, "rows");
  if (value.rows.length > SLIDE_LIMITS.rows) ctx.warn(`${where}: only the first ${SLIDE_LIMITS.rows} rows are shown.`);
  const rawRows = value.rows.slice(0, SLIDE_LIMITS.rows);
  const width =
    columns.length > 0
      ? columns.length
      : Math.min(
          SLIDE_LIMITS.columns,
          Math.max(...rawRows.map((r) => (Array.isArray(r) ? r.length : isObject(r) && Array.isArray(r.cells) ? r.cells.length : 0))),
        );
  if (width === 0) return missing(ctx, where, "columns");
  const rows: SlideTableRow[] = [];
  rawRows.forEach((raw, i) => {
    const what = `${where} row ${i + 1}`;
    const rawCells = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.cells) ? raw.cells : undefined;
    if (!rawCells) {
      ctx.warn(`${what} must be an array of cells or an object with \`cells\`.`);
      return;
    }
    if (rawCells.length > width) ctx.warn(`${what} has ${rawCells.length} cells for ${width} columns; extra cells are dropped.`);
    const cells = Array.from({ length: width }, (_, c) => ctx.text(rawCells[c] ?? "", `${what} cell ${c + 1}`, SLIDE_LIMITS.label * 2) ?? "");
    const row: SlideTableRow = { id: ctx.claim(isObject(raw) ? raw.id : undefined, `${base.id}.${i + 1}`, what), cells };
    const tone = isObject(raw) ? ctx.tone(raw.tone, what) : undefined;
    if (tone) row.tone = tone;
    rows.push(row);
  });
  if (rows.length === 0) return missing(ctx, where, "rows");
  return { ...base, type: "table", columns, rows };
}

function normalizeFlow(
  value: Raw,
  base: BlockBase,
  where: string,
  ctx: SlideContext,
): SlideFlowBlock | undefined {
  let direction: "LR" | "TB" = "LR";
  if (value.direction !== undefined) {
    const dir = typeof value.direction === "string" ? value.direction.toUpperCase() : value.direction;
    if (dir === "LR" || dir === "TB") direction = dir;
    else ctx.warn(`${where}: direction must be "LR" or "TB".`);
  }

  const groups: SlideFlowGroup[] = [];
  if (value.groups !== undefined && !Array.isArray(value.groups)) ctx.warn(`${where}: \`groups\` must be an array.`);
  const rawGroups = Array.isArray(value.groups) ? value.groups : [];
  if (rawGroups.length > SLIDE_LIMITS.groups) ctx.warn(`${where}: only the first ${SLIDE_LIMITS.groups} groups are used.`);
  rawGroups.slice(0, SLIDE_LIMITS.groups).forEach((raw, i) => {
    const what = `${where} group ${i + 1}`;
    const obj: Raw = typeof raw === "string" ? { id: raw } : isObject(raw) ? raw : {};
    if (obj.id === undefined) {
      ctx.warn(`${what} has no id.`);
      return;
    }
    const before = ctx.warnings.length;
    const id = ctx.claim(obj.id, `${base.id}.g${i + 1}`, what);
    if (ctx.warnings.length > before) return; // explicit group ids must be usable as-is
    const group: SlideFlowGroup = { id };
    const label = ctx.text(obj.label, `${what} label`, SLIDE_LIMITS.label);
    if (label) group.label = label;
    const tone = ctx.tone(obj.tone, what);
    if (tone) group.tone = tone;
    groups.push(group);
  });
  const groupIds = new Set(groups.map((g) => g.id));

  const nodes: SlideFlowNode[] = [];
  const rawNodes = Array.isArray(value.nodes) ? value.nodes : [];
  if (rawNodes.length === 0) return missing(ctx, where, "nodes");
  if (rawNodes.length > SLIDE_LIMITS.nodes) ctx.warn(`${where}: only the first ${SLIDE_LIMITS.nodes} nodes are shown.`);
  rawNodes.slice(0, SLIDE_LIMITS.nodes).forEach((raw, i) => {
    const what = `${where} node ${i + 1}`;
    const obj: Raw = typeof raw === "string" ? { id: raw } : isObject(raw) ? raw : {};
    if (typeof obj.id !== "string" || !ID_PATTERN.test(obj.id.trim())) {
      ctx.warn(`${what} needs an id (1-64 characters, no spaces or colons) so edges can point at it.`);
      return;
    }
    const before = ctx.warnings.length;
    const id = ctx.claim(obj.id, obj.id.trim(), what);
    if (ctx.warnings.length > before) return; // a node whose id was taken can't be an edge endpoint
    const label = ctx.text(obj.label, `${what} label`, SLIDE_LIMITS.label) ?? id;
    let shape: SlideNodeShape = "box";
    if (obj.shape !== undefined) {
      if (SHAPES.includes(obj.shape as SlideNodeShape)) shape = obj.shape as SlideNodeShape;
      else ctx.warn(`${what}: unknown shape ${describe(obj.shape)}; using "box".`);
    }
    const node: SlideFlowNode = { id, label, shape };
    const sub = ctx.text(obj.sub, `${what} sub`, SLIDE_LIMITS.label);
    if (sub) node.sub = sub;
    const badge = ctx.text(obj.badge, `${what} badge`, 40);
    if (badge) node.badge = badge;
    const tone = ctx.tone(obj.tone, what);
    if (tone) node.tone = tone;
    if (obj.group !== undefined) {
      if (typeof obj.group === "string" && groupIds.has(obj.group)) node.group = obj.group;
      else ctx.warn(`${what}: group ${describe(obj.group)} isn't defined in \`groups\`.`);
    }
    nodes.push(node);
  });
  if (nodes.length === 0) return missing(ctx, where, "nodes");
  const nodeIds = new Set(nodes.map((n) => n.id));

  const edges: SlideFlowEdge[] = [];
  if (value.edges !== undefined && !Array.isArray(value.edges)) ctx.warn(`${where}: \`edges\` must be an array.`);
  const rawEdges = Array.isArray(value.edges) ? value.edges : [];
  if (rawEdges.length > SLIDE_LIMITS.edges) ctx.warn(`${where}: only the first ${SLIDE_LIMITS.edges} edges are shown.`);
  rawEdges.slice(0, SLIDE_LIMITS.edges).forEach((raw, i) => {
    const what = `${where} edge ${i + 1}`;
    const parsed = parseEdge(raw);
    if (!parsed) {
      ctx.warn(`${what} must be "a -> b: label" or an object with \`from\` and \`to\`.`);
      return;
    }
    const unknown = [parsed.from, parsed.to].filter((end) => !nodeIds.has(end));
    if (unknown.length > 0) {
      ctx.warn(`${what}: ${unknown.map((u) => `"${u}"`).join(" and ")} ${unknown.length === 1 ? "isn't a node" : "aren't nodes"} in this flow.`);
      return;
    }
    const edge: SlideFlowEdge = {
      id: ctx.claim(parsed.id, `${parsed.from}->${parsed.to}`, what),
      from: parsed.from,
      to: parsed.to,
      style: parsed.style,
      arrow: parsed.arrow,
    };
    ctx.edges.add(edge.id);
    const label = ctx.text(parsed.label, `${what} label`, SLIDE_LIMITS.label);
    if (label) edge.label = label;
    const tone = ctx.tone(parsed.tone, what);
    if (tone) edge.tone = tone;
    edges.push(edge);
  });

  return { ...base, type: "flow", direction, nodes, edges, groups };
}

interface ParsedEdge {
  id?: unknown;
  from: string;
  to: string;
  label?: unknown;
  tone?: unknown;
  style: "solid" | "dashed";
  arrow: "end" | "both" | "none";
}

/** Parse `a -> b: label` (also `-->`, `<->`, `<-->`, `--`) or an edge object. */
export function parseEdge(value: unknown): ParsedEdge | undefined {
  if (typeof value === "string") {
    const m = EDGE_PATTERN.exec(value.trim());
    if (!m) return undefined;
    const op = m[2];
    return {
      from: m[1].trim(),
      to: m[3].trim(),
      label: m[4]?.trim() || undefined,
      style: op === "-->" || op === "<-->" ? "dashed" : "solid",
      arrow: op.startsWith("<") ? "both" : op === "--" ? "none" : "end",
    };
  }
  if (!isObject(value) || typeof value.from !== "string" || typeof value.to !== "string") return undefined;
  const style = value.style === "dashed" || value.dashed === true ? "dashed" : "solid";
  const arrow = value.arrow === "both" || value.arrow === "none" ? value.arrow : "end";
  return {
    id: value.id,
    from: value.from.trim(),
    to: value.to.trim(),
    label: value.label,
    tone: value.tone,
    style,
    arrow,
  };
}

function normalizeBeats(value: unknown, ctx: SlideContext): SlideBeat[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    ctx.warn("`beats` must be an array.");
    return [];
  }
  if (value.length > SLIDE_LIMITS.beats) ctx.warn(`Only the first ${SLIDE_LIMITS.beats} beats are used.`);
  const beats: SlideBeat[] = [];
  value.slice(0, SLIDE_LIMITS.beats).forEach((raw, i) => {
    const where = `Beat ${i + 1}`;
    if (!isObject(raw)) {
      ctx.warn(`${where} isn't an object.`);
      return;
    }
    const beat: SlideBeat = {};
    const say = ctx.text(raw.say, `${where} say`, SLIDE_LIMITS.text);
    if (say) beat.say = say;
    for (const key of ["show", "hide", "focus", "highlight", "pulse"] as const) {
      const ids = targetList(raw[key], `${where} ${key}`, ctx);
      if (ids.length > 0) beat[key] = ids;
    }
    if (raw.set !== undefined) {
      if (!isObject(raw.set)) ctx.warn(`${where}: \`set\` must map element ids to changes.`);
      else {
        const set: Record<string, SlideElementPatch> = {};
        for (const [id, patch] of Object.entries(raw.set)) {
          if (!ctx.elements.has(id)) {
            ctx.warn(`${where} set: unknown id "${id}".`);
            continue;
          }
          if (!isObject(patch)) continue;
          const out: SlideElementPatch = {};
          for (const field of ["label", "sub", "badge"] as const) {
            const text = ctx.text(patch[field], `${where} set ${id}.${field}`, SLIDE_LIMITS.label);
            if (text !== undefined) out[field] = text;
          }
          const tone = ctx.tone(patch.tone, `${where} set ${id}`);
          if (tone) out.tone = tone;
          if (Object.keys(out).length > 0) set[id] = out;
        }
        if (Object.keys(set).length > 0) beat.set = set;
      }
    }
    if (raw.flow !== undefined) {
      const flows: SlideFlowEffect[] = [];
      for (const entry of Array.isArray(raw.flow) ? raw.flow : [raw.flow]) {
        const effect: SlideFlowEffect | undefined =
          typeof entry === "string"
            ? { edge: entry }
            : isObject(entry) && typeof entry.edge === "string"
              ? { edge: entry.edge }
              : undefined;
        if (!effect) {
          ctx.warn(`${where} flow: each entry is an edge id or { edge, label?, tone?, reverse? }.`);
          continue;
        }
        if (!ctx.edges.has(effect.edge)) {
          ctx.warn(`${where} flow: "${effect.edge}" isn't an edge on this slide.`);
          continue;
        }
        if (isObject(entry)) {
          const label = ctx.text(entry.label, `${where} flow label`, SLIDE_LIMITS.label);
          if (label) effect.label = label;
          const tone = ctx.tone(entry.tone, `${where} flow`);
          if (tone) effect.tone = tone;
          if (entry.reverse === true) effect.reverse = true;
        }
        flows.push(effect);
      }
      if (flows.length > 0) beat.flow = flows;
    }
    beats.push(beat);
  });
  return beats;
}

function targetList(value: unknown, where: string, ctx: SlideContext): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const ids: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") {
      ctx.warn(`${where}: ids must be strings.`);
      continue;
    }
    if (isTarget(entry, ctx)) ids.push(entry);
    else ctx.warn(`${where}: unknown id "${entry}".`);
  }
  return ids;
}

function isTarget(id: string, ctx: SlideContext): boolean {
  if (ctx.elements.has(id)) return true;
  const m = CODE_LINE_REF.exec(id);
  if (!m) return false;
  const lines = ctx.codeLines.get(m[1]);
  if (!lines) return false;
  const start = Number(m[2]);
  const end = m[3] ? Number(m[3]) : start;
  return start >= lines.first && end >= start && end <= lines.last;
}

function isObject(value: unknown): value is Raw {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (typeof value === "string") return `"${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`;
  if (value === undefined) return "(missing)";
  try {
    const json = JSON.stringify(value);
    return json.length > 40 ? `${json.slice(0, 40)}…` : json;
  } catch {
    return typeof value;
  }
}
