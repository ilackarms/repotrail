/**
 * SVG for flow and sequence blocks. Each element carries `data-id` (or
 * `data-for` when it belongs to another element, like an edge's label) so the
 * animator can find it, and registers an applier that redraws it for `set`.
 */

import { FLOW_METRICS, layoutFlow, wrap, type FlowFont, type FlowNodeBox, type FlowPoint } from "../../engine/slides/flowLayout";
import { layoutSequence, SEQUENCE_METRICS } from "../../engine/slides/sequenceLayout";
import type {
  SlideElementPatch,
  SlideFlowBlock,
  SlideNodeShape,
  SlideSequenceBlock,
  SlideTone,
} from "../../engine/types";
import type { TextVariants } from "../../engine/slides/flowLayout";

const SVG_NS = "http://www.w3.org/2000/svg";
const TONES: SlideTone[] = ["default", "accent", "good", "warn", "bad", "muted"];

/** Redraws an element for its accumulated `set` change (undefined restores it). */
export type PatchApplier = (patch: SlideElementPatch | undefined, animate: boolean) => void;

export interface DiagramContext {
  appliers: Map<string, PatchApplier>;
  /** Paths tokens travel along, by edge id. */
  edgePaths: Map<string, SVGPathElement>;
  variants: TextVariants;
}

let markerSeq = 0;

export function renderFlow(block: SlideFlowBlock, ctx: DiagramContext): HTMLElement {
  const host = flowHost();
  const layout = layoutFlow(block, measureText, ctx.variants);
  const svg = diagramSvg(host, layout.width, layout.height, block.title ?? "Diagram");
  const markers = arrowMarkers(svg);
  const nodesById = new Map(block.nodes.map((n) => [n.id, n]));

  for (const box of layout.groups) {
    const group = block.groups.find((g) => g.id === box.id)!;
    const g = svg_("g", { class: `rt-group ${toneClass(group.tone)}`, "data-id": group.id });
    g.append(svg_("rect", { x: box.x, y: box.y, width: box.width, height: box.height, rx: 10, class: "rt-group-box" }));
    const label = group.label ? svgText(group.label, box.x + 12, box.y + 15, "rt-group-label", "start") : null;
    if (label) g.append(label);
    svg.append(g);
    ctx.appliers.set(group.id, (patch, animate) => {
      setTone(g, patch?.tone ?? group.tone, false);
      if (label && (patch?.label ?? group.label) !== label.textContent) {
        label.textContent = patch?.label ?? group.label ?? "";
        if (animate) flip(label);
      }
    });
  }

  const edgeLayer = svg_("g");
  const labelLayer = svg_("g");
  const nodeLayer = svg_("g");
  svg.append(edgeLayer, labelLayer, nodeLayer);

  for (const route of layout.edges) {
    const edge = block.edges.find((e) => e.id === route.id)!;
    const g = svg_("g", { class: `rt-edge ${edge.style === "dashed" ? "dashed" : ""}`, "data-id": edge.id });
    const path = svg_("path", { d: smoothPath(route.points), class: "rt-edge-path" }) as SVGPathElement;
    g.append(path);
    edgeLayer.append(g);
    ctx.edgePaths.set(edge.id, path);

    let labelGroup: SVGElement | null = null;
    if (route.label) {
      const { x, y, width, height, lines } = route.label;
      labelGroup = svg_("g", { class: "rt-edge-label", "data-for": edge.id });
      labelGroup.append(svg_("rect", { x, y, width, height, rx: 4 }));
      drawLines(labelGroup, lines, x + width / 2, y + 3 + FLOW_METRICS.edgeLine / 2, FLOW_METRICS.edgeLine, "", "middle");
      labelLayer.append(labelGroup);
    }
    const apply: PatchApplier = (patch, animate) => {
      const tone = patch?.tone ?? edge.tone;
      setTone(g, tone, false);
      if (edge.arrow !== "none") path.setAttribute("marker-end", `url(#${markers(tone)})`);
      if (edge.arrow === "both") path.setAttribute("marker-start", `url(#${markers(tone)})`);
      if (labelGroup && route.label) {
        const text = patch?.label ?? edge.label ?? "";
        const lines = text ? wrap(text, "edge", FLOW_METRICS.maxEdgeLabelWidth, measureText, 2) : [];
        if (lines.join("\n") !== labelGroup.dataset.text) {
          const { x, y, width } = route.label;
          for (const old of labelGroup.querySelectorAll("text")) old.remove();
          drawLines(labelGroup, lines, x + width / 2, y + 3 + FLOW_METRICS.edgeLine / 2, FLOW_METRICS.edgeLine, "", "middle");
          labelGroup.dataset.text = lines.join("\n");
          labelGroup.classList.toggle("empty", lines.length === 0);
          if (animate) flip(labelGroup);
        }
      }
    };
    apply(undefined, false);
    ctx.appliers.set(edge.id, apply);
  }

  for (const box of layout.nodes) {
    const node = nodesById.get(box.id)!;
    nodeLayer.append(renderNode(node, box, ctx));
  }
  return host;
}

export function renderSequence(block: SlideSequenceBlock, ctx: DiagramContext): HTMLElement {
  const host = flowHost();
  const layout = layoutSequence(block, measureText, ctx.variants);
  const svg = diagramSvg(host, layout.width, layout.height, block.title ?? "Sequence");
  const markers = arrowMarkers(svg);
  const s = SEQUENCE_METRICS;

  for (const lifeline of layout.lifelines) {
    svg.append(svg_("path", { class: "rt-lifeline", "data-for": lifeline.id, d: `M${lifeline.x},${lifeline.y1} V${lifeline.y2}` }));
  }
  for (const box of layout.participants) {
    const participant = block.participants.find((p) => p.id === box.id)!;
    svg.append(renderNode(participant, box, ctx));
  }
  for (const note of layout.notes) {
    const item = block.messages.find((m) => m.id === note.id);
    if (!item || !("note" in item)) continue;
    const g = svg_("g", { class: "rt-seq-note", "data-id": note.id });
    g.append(svg_("rect", { x: note.x, y: note.y, width: note.width, height: note.height, rx: 4 }));
    drawLines(g, note.lines, note.x + note.width / 2, note.y + s.notePadY + s.line / 2, s.line, "", "middle");
    svg.append(g);
    ctx.appliers.set(note.id, (patch, animate) => {
      setTone(g, patch?.tone ?? item.tone, false);
      const text = patch?.label ?? item.note;
      if (text !== (g.dataset.text ?? item.note)) {
        for (const old of g.querySelectorAll("text")) old.remove();
        drawLines(g, wrap(text, "sub", s.noteMaxWidth, measureText, 3), note.x + note.width / 2, note.y + s.notePadY + s.line / 2, s.line, "", "middle");
        g.dataset.text = text;
        if (animate) flip(g);
      }
    });
  }
  for (const route of layout.messages) {
    const item = block.messages.find((m) => m.id === route.id);
    if (!item || "note" in item) continue;
    const g = svg_("g", { class: `rt-seq-message ${item.reply ? "dashed" : ""}`, "data-id": route.id });
    const d = route.self
      ? `M${route.x1},${route.y} H${route.x2} V${route.y + s.selfHeight} H${route.x1 + 2}`
      : `M${route.x1},${route.y} H${route.x2 + (route.x2 > route.x1 ? -2 : 2)}`;
    const path = svg_("path", { class: "rt-edge-path", d }) as SVGPathElement;
    g.append(path);
    const labelGroup = svg_("g");
    g.append(labelGroup);
    svg.append(g);
    ctx.edgePaths.set(route.id, path);
    const apply: PatchApplier = (patch, animate) => {
      const tone = patch?.tone ?? item.tone;
      setTone(g, tone, false);
      path.setAttribute("marker-end", `url(#${markers(tone)})`);
      const text = patch?.label ?? item.label ?? "";
      if (text !== labelGroup.dataset.text && route.label) {
        labelGroup.replaceChildren();
        const lines = text ? wrap(text, "sub", s.messageMaxWidth, measureText, 2) : [];
        drawLines(labelGroup, lines, route.label.x, route.label.y, s.line, "rt-seq-label", route.label.anchor);
        labelGroup.dataset.text = text;
        if (animate) flip(labelGroup);
      }
    };
    apply(undefined, false);
    ctx.appliers.set(route.id, apply);
  }
  return host;
}

interface NodeLike {
  id: string;
  label: string;
  sub?: string;
  shape: SlideNodeShape;
  tone?: SlideTone;
  badge?: string;
}

function renderNode(node: NodeLike, box: FlowNodeBox, ctx: DiagramContext): SVGElement {
  const g = svg_("g", { class: `rt-node shape-${node.shape}`, "data-id": node.id });
  const { x, y, width: w, height: h } = box;
  switch (node.shape) {
    case "store": {
      const ry = 8;
      g.append(
        svg_("path", { class: "rt-shape", d: `M${x},${y + ry} a${w / 2},${ry} 0 0 1 ${w},0 v${h - 2 * ry} a${w / 2},${ry} 0 0 1 ${-w},0 Z` }),
        svg_("path", { class: "rt-shape-line", d: `M${x},${y + ry} a${w / 2},${ry} 0 0 0 ${w},0` }),
      );
      break;
    }
    case "file": {
      const f = 12;
      g.append(
        svg_("path", { class: "rt-shape", d: `M${x},${y} h${w - f} l${f},${f} v${h - f} h${-w} Z` }),
        svg_("path", { class: "rt-shape-line", d: `M${x + w - f},${y} v${f} h${f}` }),
      );
      break;
    }
    case "decision":
      g.append(svg_("polygon", { class: "rt-shape", points: `${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}` }));
      break;
    case "device":
      g.append(
        svg_("rect", { class: "rt-shape rt-shape-back", x: x + 6, y: y + 6, width: w - 6, height: h - 6, rx: 6 }),
        svg_("rect", { class: "rt-shape", x, y, width: w - 6, height: h - 6, rx: 6 }),
      );
      break;
    case "actor": {
      g.append(svg_("rect", { class: "rt-shape", x, y, width: w, height: h, rx: Math.min(h / 2, 22) }));
      const cx = x + 22;
      const cy = y + h / 2;
      g.append(
        svg_("circle", { class: "rt-glyph", cx, cy: cy - 6, r: 4.5 }),
        svg_("path", { class: "rt-glyph", d: `M${cx - 8},${cy + 10} a8,8 0 0 1 16,0` }),
      );
      break;
    }
    case "queue": {
      g.append(svg_("rect", { class: "rt-shape", x, y, width: w, height: h, rx: 6 }));
      for (let i = 0; i < 3; i++) {
        const lx = x + w - 20 + i * 6;
        g.append(svg_("path", { class: "rt-shape-line", d: `M${lx},${y + 9} v${h - 18}` }));
      }
      break;
    }
    default:
      g.append(svg_("rect", { class: "rt-shape", x, y, width: w, height: h, rx: node.shape === "service" ? 14 : node.shape === "note" ? 3 : 6 }));
  }

  const text = svg_("g", { class: "rt-node-text" });
  g.append(text);
  let shown = { label: "", sub: "", badge: "" };
  const apply: PatchApplier = (patch, animate) => {
    setTone(g, patch?.tone ?? node.tone, true);
    const next = { label: patch?.label ?? node.label, sub: patch?.sub ?? node.sub ?? "", badge: patch?.badge ?? node.badge ?? "" };
    if (next.label !== shown.label || next.sub !== shown.sub) {
      drawNodeText(text, box, next.label, next.sub);
      if (animate && shown.label) flip(text);
    }
    if (next.badge !== shown.badge) {
      g.querySelector(".rt-badge")?.remove();
      if (next.badge) {
        const badge = drawBadge(box, next.badge);
        g.append(badge);
        if (animate) pop(badge);
      }
    }
    shown = next;
  };
  apply(undefined, false);
  ctx.appliers.set(node.id, apply);
  return g;
}

function drawNodeText(text: SVGElement, box: FlowNodeBox, label: string, sub: string): void {
  const m = FLOW_METRICS;
  const labelLines = wrap(label, "label", m.maxTextWidth, measureText, 2);
  const subLines = sub ? wrap(sub, "sub", m.maxTextWidth, measureText, 2) : [];
  const height = labelLines.length * m.labelLine + (subLines.length > 0 ? 3 + subLines.length * m.subLine : 0);
  const top = box.textY - height / 2;
  text.replaceChildren();
  drawLines(text, labelLines, box.textX, top + m.labelLine / 2, m.labelLine, "rt-node-label", "middle");
  drawLines(text, subLines, box.textX, top + labelLines.length * m.labelLine + 3 + m.subLine / 2, m.subLine, "rt-node-sub", "middle");
}

function drawBadge(box: FlowNodeBox, label: string): SVGElement {
  const width = Math.ceil(measureFont(label, "600 11px")) + 14;
  const bx = box.x + box.width - width + 8;
  const by = box.y - 9;
  const badge = svg_("g", { class: "rt-badge" });
  badge.append(svg_("rect", { x: bx, y: by, width, height: 18, rx: 9 }), svgText(label, bx + width / 2, by + 9, "", "middle"));
  return badge;
}

function drawLines(parent: SVGElement, lines: string[], x: number, firstY: number, step: number, className: string, anchor: "start" | "middle"): void {
  lines.forEach((line, i) => parent.append(svgText(line, x, firstY + i * step, className, anchor)));
}

/** Swap an element's tone class; nodes also get `toned` for tinted fills. */
export function setTone(el: Element, tone: SlideTone | undefined, nodeLike: boolean): void {
  for (const t of TONES) el.classList.remove(`tone-${t}`);
  el.classList.remove("toned");
  if (tone && tone !== "default") {
    el.classList.add(`tone-${tone}`);
    if (nodeLike) el.classList.add("toned");
  }
}

/** One arrowhead marker per tone, created on first use. */
function arrowMarkers(svg: SVGElement): (tone: SlideTone | undefined) => string {
  const defs = svg_("defs");
  svg.prepend(defs);
  const made = new Map<string, string>();
  return (tone) => {
    const key = tone && tone !== "default" ? tone : "edge";
    let id = made.get(key);
    if (id) return id;
    id = `rt-arrow-${++markerSeq}`;
    const marker = svg_("marker", {
      id,
      viewBox: "0 0 10 10",
      refX: 9,
      refY: 5,
      markerWidth: 10,
      markerHeight: 10,
      markerUnits: "userSpaceOnUse",
      orient: "auto-start-reverse",
    });
    marker.append(svg_("path", { d: "M1,1 L9,5 L1,9 Z", class: `rt-arrowhead ${key === "edge" ? "" : `tone-${key}`}` }));
    defs.append(marker);
    made.set(key, id);
    return id;
  };
}

/** A curve through dagre's bend points, straight where it leaves and enters nodes. */
function smoothPath(points: FlowPoint[]): string {
  if (points.length === 0) return "";
  const p = (pt: FlowPoint) => `${pt.x},${pt.y}`;
  if (points.length === 2) return `M${p(points[0])} L${p(points[1])}`;
  const mid = (a: FlowPoint, b: FlowPoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  let d = `M${p(points[0])} L${p(mid(points[0], points[1]))}`;
  for (let i = 1; i < points.length - 1; i++) {
    const end = i === points.length - 2 ? points[i + 1] : mid(points[i], points[i + 1]);
    d += ` Q${p(points[i])} ${p(end)}`;
  }
  return d;
}

function flowHost(): HTMLElement {
  const host = document.createElement("div");
  host.className = "rt-flow-host";
  return host;
}

function diagramSvg(host: HTMLElement, width: number, height: number, title: string): SVGElement {
  host.dataset.width = String(width);
  host.dataset.height = String(height);
  const svg = svg_("svg", { viewBox: `0 0 ${width} ${height}`, class: "rt-flow-svg", role: "img" });
  const label = svg_("title");
  label.textContent = title;
  svg.append(label);
  host.append(svg);
  return svg;
}

/** Fade new text in after a `set` change. */
export function flip(el: Element): void {
  el.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: "ease-out" });
}

function pop(el: Element): void {
  el.animate?.([{ opacity: 0, transform: "scale(0.6)" }, { opacity: 1, transform: "scale(1)" }], { duration: 260, easing: "ease-out" });
}

function toneClass(tone: SlideTone | undefined): string {
  return tone && tone !== "default" && TONES.includes(tone) ? `tone-${tone}` : "";
}

const FONTS: Record<FlowFont, string> = {
  label: "600 15px",
  sub: "13px",
  edge: "12px",
  group: "600 12px",
};

let measureContext: CanvasRenderingContext2D | null = null;

export function measureFont(text: string, font: string): number {
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (!measureContext) return text.length * 8;
  measureContext.font = `${font} ${getComputedStyle(document.body).fontFamily || "sans-serif"}`;
  return measureContext.measureText(text).width;
}

export function measureText(text: string, font: FlowFont): number {
  return measureFont(text, FONTS[font]);
}

export function svg_(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const node = document.createElementNS(SVG_NS, tag) as SVGElement;
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") {
      const cls = String(value).replace(/\s+/g, " ").trim();
      if (cls) node.setAttribute("class", cls);
    } else {
      node.setAttribute(key, String(value));
    }
  }
  return node;
}

function svgText(text: string, x: number, y: number, className: string, anchor: "start" | "middle"): SVGElement {
  const node = svg_("text", { x, y, class: className, "text-anchor": anchor, "dominant-baseline": "central" });
  node.textContent = text;
  return node;
}
