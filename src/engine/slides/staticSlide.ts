/**
 * A slide as static HTML and SVG, for pages that run no script (`render
 * --artifact`). It mirrors the slide webview's renderer (src/webview/slides/
 * render.ts and diagrams.ts): same markup and classes, so slides.css styles
 * both. The slide is drawn as it stands after its last beat; the page lists
 * the beats' captions beside it.
 *
 * Pure: text widths are estimated rather than measured, and every string from
 * the tour is escaped or goes through the escaping narration renderer.
 */

import { renderNarrationMarkdown } from "../narrationMarkdown";
import type {
  SlideBlock,
  SlideBulletItem,
  SlideCalloutTone,
  SlideCodeBlock,
  SlideElementPatch,
  SlideFlowBlock,
  SlideNodeShape,
  SlideRef,
  SlideSequenceBlock,
  SlideTableBlock,
  SlideTone,
  TourSlide,
} from "../types";
import { FLOW_METRICS, layoutFlow, wrap, type FlowFont, type FlowNodeBox, type FlowPoint, type TextMeasure } from "./flowLayout";
import { layoutSequence, SEQUENCE_METRICS } from "./sequenceLayout";
import { slideBeats, stateAt, textVariants } from "./timeline";

export interface StaticSlideInput {
  title: string;
  slide: TourSlide;
  /** 0-based stop index, for the footer and to keep SVG ids unique on the page. */
  index: number;
  total: number;
  source?: string;
}

/** How far a diagram may grow past its natural size. */
const MAX_DIAGRAM_SCALE = 1.4;
const TONES: SlideTone[] = ["default", "accent", "good", "warn", "bad", "muted"];
const CALLOUT_LABELS: Record<SlideCalloutTone, string> = {
  info: "Note",
  warn: "Warning",
  risk: "Risk",
  decision: "Decision",
  question: "Open question",
};

interface Ctx {
  hidden: Set<string>;
  patches: Record<string, SlideElementPatch>;
  variants: ReturnType<typeof textVariants>;
  /** Prefix for SVG ids (arrow markers), unique per diagram on the page. */
  idPrefix: string;
}

export function renderStaticSlide(input: StaticSlideInput): string {
  const { slide } = input;
  const beats = slideBeats(slide);
  const state = stateAt(slide, beats.length);
  const ctx: Ctx = { hidden: new Set(state.hidden), patches: state.patches, variants: textVariants(slide), idPrefix: `rt${input.index + 1}` };

  const header =
    (slide.eyebrow ? `<div class="rt-eyebrow">${esc(slide.eyebrow)}</div>` : "") +
    `<h3 class="rt-title">${esc(input.title)}</h3>` +
    (slide.subtitle ? `<div class="rt-subtitle">${esc(slide.subtitle)}</div>` : "");
  const body =
    slide.layout === "columns"
      ? renderColumns(slide.blocks, ctx)
      : slide.blocks.map((block, i) => renderBlock(block, ctx, i)).join("");
  const footer =
    `<span class="rt-position">${input.index + 1} / ${input.total}</span>` +
    `<span class="rt-source">${esc(input.source ?? "")}</span>`;
  const warnings = slide.warnings?.length
    ? `<details class="rt-warnings"><summary>⚠ ${slide.warnings.length} problem${slide.warnings.length === 1 ? "" : "s"} reading this slide</summary><ul>${slide.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></details>`
    : "";
  return (
    `<div class="rt-slide rt-static layout-${esc(slide.layout)}">` +
    `<header class="rt-header">${header}</header>` +
    `<section class="rt-body">${body}</section>` +
    `<footer class="rt-footer">${footer}</footer>${warnings}</div>`
  );
}

/** Group blocks into columns: a block without `column` starts the next one. */
function renderColumns(blocks: SlideBlock[], ctx: Ctx): string {
  const columns = new Map<number, Array<{ block: SlideBlock; index: number }>>();
  let previous = 0;
  blocks.forEach((block, index) => {
    const column = block.column ?? previous + 1;
    previous = column;
    columns.set(column, [...(columns.get(column) ?? []), { block, index }]);
  });
  return [...columns.keys()]
    .sort((a, b) => a - b)
    .map((key) => {
      const members = columns.get(key)!;
      const grow = Math.max(...members.map((m) => m.block.span ?? 1));
      return `<div class="rt-column" style="flex-grow:${grow}">${members.map((m) => renderBlock(m.block, ctx, m.index)).join("")}</div>`;
    })
    .join("");
}

function renderBlock(block: SlideBlock, ctx: Ctx, index: number): string {
  const title = block.title && block.type !== "callout" ? `<div class="rt-block-title">${esc(block.title)}</div>` : "";
  let content = "";
  switch (block.type) {
    case "text":
      content = markdown(block.md);
      break;
    case "bullets":
      content = renderBullets(block.items, block.ordered === true, ctx);
      break;
    case "table":
      content = renderTable(block, ctx);
      break;
    case "code":
      content = renderCode(block, ctx);
      break;
    case "callout":
      content = `<div class="rt-callout callout-${esc(block.tone)}"><div class="rt-callout-label">${esc(block.title ?? CALLOUT_LABELS[block.tone])}</div>${markdown(block.md)}</div>`;
      break;
    case "flow":
      content = renderFlow(block, { ...ctx, idPrefix: `${ctx.idPrefix}b${index}` });
      break;
    case "sequence":
      content = renderSequence(block, { ...ctx, idPrefix: `${ctx.idPrefix}b${index}` });
      break;
  }
  return `<div class="${cls("rt-block", `rt-block-${block.type}`, hiddenCls(ctx, block.id))}" data-id="${esc(block.id)}">${title}${content}</div>`;
}

function renderBullets(items: SlideBulletItem[], ordered: boolean, ctx: Ctx): string {
  const tag = ordered ? "ol" : "ul";
  const lis = items.map((item) => {
    const patch = ctx.patches[item.id];
    const nested = item.items?.length ? renderBullets(item.items, false, ctx) : "";
    return `<li class="${cls(toneCls(patch?.tone ?? item.tone, false), hiddenCls(ctx, item.id))}" data-id="${esc(item.id)}"><span class="rt-item-text">${inlineMarkdown(patch?.label ?? item.text)}</span>${nested}</li>`;
  });
  return `<${tag} class="rt-list">${lis.join("")}</${tag}>`;
}

function renderTable(block: SlideTableBlock, ctx: Ctx): string {
  const head = block.columns.some((c) => c.trim())
    ? `<thead><tr>${block.columns.map((c) => `<th>${inlineMarkdown(c)}</th>`).join("")}</tr></thead>`
    : "";
  const rows = block.rows.map((row) => {
    const tone = ctx.patches[row.id]?.tone ?? row.tone;
    return `<tr class="${cls(toneCls(tone, false), hiddenCls(ctx, row.id))}" data-id="${esc(row.id)}">${row.cells.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`;
  });
  return `<div class="rt-table-wrap"><table class="rt-table">${head}<tbody>${rows.join("")}</tbody></table></div>`;
}

function renderCode(block: SlideCodeBlock, ctx: Ctx): string {
  const label = block.ref
    ? `<span class="rt-code-ref" title="${esc(refLabel(block.ref))}">↗ ${esc(refLabel(block.ref))}</span>`
    : block.language
      ? `<div class="rt-code-lang">${esc(block.language)}</div>`
      : "";
  const first = block.startLine ?? 1;
  const lines = block.code.split("\n").map((text, i) => {
    const id = `${block.id}:L${first + i}`;
    return `<div class="${cls("rt-line", hiddenCls(ctx, id))}"><span class="rt-ln">${first + i}</span><span class="rt-tx">${esc(text || " ")}</span></div>`;
  });
  return `<div class="rt-code">${label}${lines.join("")}</div>`;
}

function renderFlow(block: SlideFlowBlock, ctx: Ctx): string {
  const layout = layoutFlow(block, estimateTextWidth, ctx.variants);
  const markers = new Markers(ctx.idPrefix);
  const parts: string[] = [];

  for (const box of layout.groups) {
    const group = block.groups.find((g) => g.id === box.id)!;
    const patch = ctx.patches[group.id];
    // Layout only leaves room for a label the group has; a `set` can change it, not add one.
    const label = group.label ? (patch?.label ?? group.label) : undefined;
    parts.push(
      `<g class="${cls("rt-group", toneCls(patch?.tone ?? group.tone, false), hiddenCls(ctx, group.id))}" data-id="${esc(group.id)}">` +
        `<rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.width)}" height="${n(box.height)}" rx="10" class="rt-group-box"/>` +
        (label ? svgText(label, box.x + 12, box.y + 15, "rt-group-label", "start") : "") +
        `</g>`,
    );
  }

  const edges: string[] = [];
  const labels: string[] = [];
  for (const route of layout.edges) {
    const edge = block.edges.find((e) => e.id === route.id)!;
    const patch = ctx.patches[edge.id];
    const tone = patch?.tone ?? edge.tone;
    const marker = edge.arrow === "none" ? "" : ` marker-end="url(#${markers.id(tone)})"`;
    const markerStart = edge.arrow === "both" ? ` marker-start="url(#${markers.id(tone)})"` : "";
    edges.push(
      `<g class="${cls("rt-edge", edge.style === "dashed" ? "dashed" : "", toneCls(tone, false), hiddenCls(ctx, edge.id))}" data-id="${esc(edge.id)}">` +
        `<path d="${smoothPath(route.points)}" class="rt-edge-path"${marker}${markerStart}/></g>`,
    );
    if (route.label) {
      const { x, y, width, height } = route.label;
      const text = patch?.label ?? edge.label ?? "";
      const lines = text ? wrap(text, "edge", FLOW_METRICS.maxEdgeLabelWidth, estimateTextWidth, 2) : [];
      labels.push(
        `<g class="${cls("rt-edge-label", lines.length === 0 ? "empty" : "", hiddenCls(ctx, edge.id))}" data-for="${esc(edge.id)}">` +
          `<rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" rx="4"/>` +
          drawLines(lines, x + width / 2, y + 3 + FLOW_METRICS.edgeLine / 2, FLOW_METRICS.edgeLine, "", "middle") +
          `</g>`,
      );
    }
  }
  parts.push(`<g>${edges.join("")}</g>`, `<g>${labels.join("")}</g>`);

  const nodesById = new Map(block.nodes.map((node) => [node.id, node]));
  parts.push(`<g>${layout.nodes.map((box) => renderNode(nodesById.get(box.id)!, box, ctx)).join("")}</g>`);
  return diagram(layout.width, layout.height, block.title ?? "Diagram", markers, parts.join(""));
}

function renderSequence(block: SlideSequenceBlock, ctx: Ctx): string {
  const layout = layoutSequence(block, estimateTextWidth, ctx.variants);
  const markers = new Markers(ctx.idPrefix);
  const s = SEQUENCE_METRICS;
  const parts: string[] = [];

  for (const lifeline of layout.lifelines) {
    parts.push(
      `<path class="${cls("rt-lifeline", hiddenCls(ctx, lifeline.id))}" data-for="${esc(lifeline.id)}" d="M${n(lifeline.x)},${n(lifeline.y1)} V${n(lifeline.y2)}"/>`,
    );
  }
  for (const box of layout.participants) {
    const participant = block.participants.find((p) => p.id === box.id)!;
    parts.push(renderNode(participant, box, ctx));
  }
  for (const note of layout.notes) {
    const item = block.messages.find((m) => m.id === note.id);
    if (!item || !("note" in item)) continue;
    const patch = ctx.patches[note.id];
    const text = patch?.label ?? item.note;
    const lines = text === item.note ? note.lines : wrap(text, "sub", s.noteMaxWidth, estimateTextWidth, 3);
    parts.push(
      `<g class="${cls("rt-seq-note", toneCls(patch?.tone ?? item.tone, false), hiddenCls(ctx, note.id))}" data-id="${esc(note.id)}">` +
        `<rect x="${n(note.x)}" y="${n(note.y)}" width="${n(note.width)}" height="${n(note.height)}" rx="4"/>` +
        drawLines(lines, note.x + note.width / 2, note.y + s.notePadY + s.line / 2, s.line, "", "middle") +
        `</g>`,
    );
  }
  for (const route of layout.messages) {
    const item = block.messages.find((m) => m.id === route.id);
    if (!item || "note" in item) continue;
    const patch = ctx.patches[route.id];
    const tone = patch?.tone ?? item.tone;
    const d = route.self
      ? `M${n(route.x1)},${n(route.y)} H${n(route.x2)} V${n(route.y + s.selfHeight)} H${n(route.x1 + 2)}`
      : `M${n(route.x1)},${n(route.y)} H${n(route.x2 + (route.x2 > route.x1 ? -2 : 2))}`;
    const text = patch?.label ?? item.label ?? "";
    const label =
      route.label && text
        ? drawLines(wrap(text, "sub", s.messageMaxWidth, estimateTextWidth, 2), route.label.x, route.label.y, s.line, "rt-seq-label", route.label.anchor)
        : "";
    parts.push(
      `<g class="${cls("rt-seq-message", item.reply ? "dashed" : "", toneCls(tone, false), hiddenCls(ctx, route.id))}" data-id="${esc(route.id)}">` +
        `<path class="rt-edge-path" d="${d}" marker-end="url(#${markers.id(tone)})"/><g>${label}</g></g>`,
    );
  }
  return diagram(layout.width, layout.height, block.title ?? "Sequence", markers, parts.join(""));
}

interface NodeLike {
  id: string;
  label: string;
  sub?: string;
  shape: SlideNodeShape;
  tone?: SlideTone;
  badge?: string;
  ref?: SlideRef;
}

function renderNode(node: NodeLike, box: FlowNodeBox, ctx: Ctx): string {
  const patch = ctx.patches[node.id];
  const { x, y, width: w, height: h } = box;
  let shape: string;
  switch (node.shape) {
    case "store": {
      const ry = 8;
      shape =
        `<path class="rt-shape" d="M${n(x)},${n(y + ry)} a${n(w / 2)},${ry} 0 0 1 ${n(w)},0 v${n(h - 2 * ry)} a${n(w / 2)},${ry} 0 0 1 ${n(-w)},0 Z"/>` +
        `<path class="rt-shape-line" d="M${n(x)},${n(y + ry)} a${n(w / 2)},${ry} 0 0 0 ${n(w)},0"/>`;
      break;
    }
    case "file": {
      const f = 12;
      shape =
        `<path class="rt-shape" d="M${n(x)},${n(y)} h${n(w - f)} l${f},${f} v${n(h - f)} h${n(-w)} Z"/>` +
        `<path class="rt-shape-line" d="M${n(x + w - f)},${n(y)} v${f} h${f}"/>`;
      break;
    }
    case "decision":
      shape = `<polygon class="rt-shape" points="${n(x + w / 2)},${n(y)} ${n(x + w)},${n(y + h / 2)} ${n(x + w / 2)},${n(y + h)} ${n(x)},${n(y + h / 2)}"/>`;
      break;
    case "device":
      shape =
        `<rect class="rt-shape rt-shape-back" x="${n(x + 6)}" y="${n(y + 6)}" width="${n(w - 6)}" height="${n(h - 6)}" rx="6"/>` +
        `<rect class="rt-shape" x="${n(x)}" y="${n(y)}" width="${n(w - 6)}" height="${n(h - 6)}" rx="6"/>`;
      break;
    case "actor": {
      const cx = x + 22;
      const cy = y + h / 2;
      shape =
        `<rect class="rt-shape" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(Math.min(h / 2, 22))}"/>` +
        `<circle class="rt-glyph" cx="${n(cx)}" cy="${n(cy - 6)}" r="4.5"/>` +
        `<path class="rt-glyph" d="M${n(cx - 8)},${n(cy + 10)} a8,8 0 0 1 16,0"/>`;
      break;
    }
    case "queue": {
      shape = `<rect class="rt-shape" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="6"/>`;
      for (let i = 0; i < 3; i++) shape += `<path class="rt-shape-line" d="M${n(x + w - 20 + i * 6)},${n(y + 9)} v${n(h - 18)}"/>`;
      break;
    }
    default:
      shape = `<rect class="rt-shape" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${node.shape === "service" ? 14 : node.shape === "note" ? 3 : 6}"/>`;
  }

  const label = patch?.label ?? node.label;
  const sub = patch?.sub ?? node.sub ?? "";
  const badge = patch?.badge ?? node.badge ?? "";
  const tip = node.ref ? `<title>${esc(refLabel(node.ref))}</title>` : "";
  return (
    `<g class="${cls("rt-node", `shape-${node.shape}`, toneCls(patch?.tone ?? node.tone, true), hiddenCls(ctx, node.id))}" data-id="${esc(node.id)}">` +
    tip +
    shape +
    `<g class="rt-node-text">${nodeText(box, label, sub)}</g>` +
    (badge ? drawBadge(box, badge) : "") +
    `</g>`
  );
}

function nodeText(box: FlowNodeBox, label: string, sub: string): string {
  const m = FLOW_METRICS;
  const labelLines = wrap(label, "label", m.maxTextWidth, estimateTextWidth, 2);
  const subLines = sub ? wrap(sub, "sub", m.maxTextWidth, estimateTextWidth, 2) : [];
  const height = labelLines.length * m.labelLine + (subLines.length > 0 ? 3 + subLines.length * m.subLine : 0);
  const top = box.textY - height / 2;
  return (
    drawLines(labelLines, box.textX, top + m.labelLine / 2, m.labelLine, "rt-node-label", "middle") +
    drawLines(subLines, box.textX, top + labelLines.length * m.labelLine + 3 + m.subLine / 2, m.subLine, "rt-node-sub", "middle")
  );
}

function drawBadge(box: FlowNodeBox, label: string): string {
  const width = Math.ceil(estimateWidth(label, 11, true)) + 14;
  const bx = box.x + box.width - width + 8;
  const by = box.y - 9;
  return `<g class="rt-badge"><rect x="${n(bx)}" y="${n(by)}" width="${width}" height="18" rx="9"/>${svgText(label, bx + width / 2, by + 9, "", "middle")}</g>`;
}

/** One arrowhead marker per tone, emitted only for the tones a diagram uses. */
class Markers {
  private readonly made = new Map<string, string>();
  constructor(private readonly prefix: string) {}

  id(tone: SlideTone | undefined): string {
    const key = tone && tone !== "default" && TONES.includes(tone) ? tone : "edge";
    let id = this.made.get(key);
    if (!id) {
      id = `${this.prefix}-arrow-${key}`;
      this.made.set(key, id);
    }
    return id;
  }

  defs(): string {
    const markers = [...this.made].map(
      ([key, id]) =>
        `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto-start-reverse">` +
        `<path d="M1,1 L9,5 L1,9 Z" class="${cls("rt-arrowhead", key === "edge" ? "" : `tone-${key}`)}"/></marker>`,
    );
    return markers.length ? `<defs>${markers.join("")}</defs>` : "";
  }
}

function diagram(width: number, height: number, title: string, markers: Markers, content: string): string {
  const w = Math.ceil(width);
  const h = Math.ceil(height);
  return (
    `<div class="rt-flow-host"><svg class="rt-flow-svg" role="img" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="--w:${w}px;max-width:${Math.round(w * MAX_DIAGRAM_SCALE)}px">` +
    `<title>${esc(title)}</title>${markers.defs()}${content}</svg></div>`
  );
}

/** A curve through the layout's bend points, straight where it leaves and enters nodes. */
function smoothPath(points: FlowPoint[]): string {
  if (points.length === 0) return "";
  const p = (pt: FlowPoint) => `${n(pt.x)},${n(pt.y)}`;
  if (points.length === 2) return `M${p(points[0])} L${p(points[1])}`;
  const mid = (a: FlowPoint, b: FlowPoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  let d = `M${p(points[0])} L${p(mid(points[0], points[1]))}`;
  for (let i = 1; i < points.length - 1; i++) {
    const end = i === points.length - 2 ? points[i + 1] : mid(points[i], points[i + 1]);
    d += ` Q${p(points[i])} ${p(end)}`;
  }
  return d;
}

function drawLines(lines: string[], x: number, firstY: number, step: number, className: string, anchor: "start" | "middle"): string {
  return lines.map((line, i) => svgText(line, x, firstY + i * step, className, anchor)).join("");
}

function svgText(text: string, x: number, y: number, className: string, anchor: "start" | "middle"): string {
  const klass = className ? ` class="${className}"` : "";
  return `<text x="${n(x)}" y="${n(y)}"${klass} text-anchor="${anchor}" dominant-baseline="central">${esc(text)}</text>`;
}

const FONT_SIZES: Record<FlowFont, { size: number; bold: boolean }> = {
  label: { size: 15, bold: true },
  sub: { size: 13, bold: false },
  edge: { size: 12, bold: false },
  group: { size: 12, bold: true },
};

/**
 * Text width without a browser, from per-character widths of a typical system
 * sans-serif, rounded up a little so labels fit the boxes laid out for them.
 */
export const estimateTextWidth: TextMeasure = (text, font) => {
  const { size, bold } = FONT_SIZES[font];
  return estimateWidth(text, size, bold);
};

function estimateWidth(text: string, size: number, bold: boolean): number {
  let em = 0;
  for (const ch of text) em += charWidth(ch);
  return em * size * (bold ? 1.07 : 1) * 1.04;
}

function charWidth(ch: string): number {
  if (ch === " ") return 0.28;
  if ("il.,:;'|!`".includes(ch)) return 0.25;
  if ("jftrI()[]{}/\\\"-".includes(ch)) return 0.34;
  if ("mM".includes(ch)) return 0.84;
  if ("wW@%".includes(ch)) return 0.82;
  if (/[0-9]/.test(ch)) return 0.56;
  if (/[a-z]/.test(ch)) return 0.54;
  if (/[A-Z]/.test(ch)) return 0.68;
  if (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/u.test(ch)) return 1;
  return 0.6;
}

function refLabel(ref: SlideRef): string {
  if (!ref.range) return ref.file;
  const { startLine, endLine } = ref.range;
  return startLine === endLine ? `${ref.file}:${startLine}` : `${ref.file}:${startLine}-${endLine}`;
}

function markdown(md: string): string {
  return `<div class="rt-md">${renderNarrationMarkdown(md)}</div>`;
}

/** Markdown for one line: emphasis and code, without the paragraph wrapper. */
function inlineMarkdown(text: string): string {
  const html = renderNarrationMarkdown(text);
  const single = /^<p>([\s\S]*)<\/p>$/.exec(html);
  return single && !single[1].includes("<p>") ? single[1] : html;
}

function toneCls(tone: SlideTone | undefined, nodeLike: boolean): string {
  if (!tone || tone === "default" || !TONES.includes(tone)) return "";
  return nodeLike ? `tone-${tone} toned` : `tone-${tone}`;
}

function hiddenCls(ctx: Ctx, id: string): string {
  return ctx.hidden.has(id) ? "rt-hidden" : "";
}

function cls(...names: string[]): string {
  return names.filter(Boolean).join(" ");
}

/** Coordinates rounded to two decimals, to keep the SVG short. */
function n(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
