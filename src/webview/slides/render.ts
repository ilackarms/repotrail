/**
 * Builds a slide's DOM on a fixed 1280×720 canvas.
 *
 * Browser-only. Everything comes from typed slide data: text goes in through
 * `textContent` or the escaping narration markdown renderer, SVG through
 * attributes. No agent-supplied markup is ever parsed.
 */

import { layoutFlow, type FlowFont, type FlowNodeBox, type FlowPoint } from "../../engine/slides/flowLayout";
import type { SlideViewPayload } from "../../engine/slides/payload";
import type {
  SlideBlock,
  SlideBulletItem,
  SlideCalloutBlock,
  SlideCalloutTone,
  SlideCodeBlock,
  SlideFlowBlock,
  SlideFlowNode,
  SlideTableBlock,
  SlideTone,
} from "../../engine/types";
import { renderNarrationMarkdown } from "../../ux/narrationMarkdown";

export const SLIDE_WIDTH = 1280;
export const SLIDE_HEIGHT = 720;

const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_FLOW_SCALE = 1.4;
const MIN_FIT = 0.6;
const MIN_CODE_FIT = 0.55;
const TONES: SlideTone[] = ["default", "accent", "good", "warn", "bad", "muted"];
const CALLOUT_LABELS: Record<SlideCalloutTone, string> = {
  info: "Note",
  warn: "Warning",
  risk: "Risk",
  decision: "Decision",
  question: "Open question",
};

let markerSeq = 0;

export function renderSlide(payload: SlideViewPayload): HTMLElement {
  const { slide } = payload;
  const root = el("div", `rt-slide layout-${slide.layout}`);
  root.style.setProperty("--fit", "1");

  const header = el("header", "rt-header");
  if (slide.eyebrow) header.append(el("div", "rt-eyebrow", slide.eyebrow));
  header.append(el("h1", "rt-title", payload.title));
  if (slide.subtitle) header.append(el("div", "rt-subtitle", slide.subtitle));
  root.append(header);

  const body = el("section", "rt-body");
  if (slide.layout === "columns") body.append(...renderColumns(slide.blocks));
  else for (const block of slide.blocks) body.append(renderBlock(block));
  root.append(body);

  const footer = el("footer", "rt-footer");
  footer.append(el("span", "rt-position", `${payload.index + 1} / ${payload.total}`));
  if (payload.source) footer.append(el("span", "rt-source", payload.source));
  root.append(footer);

  if (slide.warnings?.length) root.append(renderWarnings(slide.warnings));
  return root;
}

/**
 * Size the slide's contents once it is in the document: shrink text until
 * nothing overflows, then scale each flow diagram into the room it has left.
 */
export function fitSlide(root: HTMLElement): void {
  const hosts = [...root.querySelectorAll<HTMLElement>(".rt-flow-host")];
  for (const host of hosts) setSvgSize(host, 0, 0);

  // Code shrinks on its own until its longest line fits, before anything is cut.
  for (const code of root.querySelectorAll<HTMLElement>(".rt-code")) {
    let codeFit = 1;
    code.style.setProperty("--code-fit", "1");
    const lines = [...code.querySelectorAll<HTMLElement>(".rt-tx")];
    while (codeFit > MIN_CODE_FIT && lines.some((line) => line.scrollWidth > line.clientWidth + 1)) {
      codeFit = Math.round((codeFit - 0.05) * 100) / 100;
      code.style.setProperty("--code-fit", String(codeFit));
    }
  }

  let fit = 1;
  root.style.setProperty("--fit", "1");
  while (fit > MIN_FIT && overflows(root)) {
    fit = Math.max(MIN_FIT, Math.round((fit - 0.05) * 100) / 100);
    root.style.setProperty("--fit", String(fit));
  }

  for (const host of hosts) {
    const width = Number(host.dataset.width);
    const height = Number(host.dataset.height);
    // A host that isn't stretched by its layout (the title layout) gets the
    // diagram's natural size.
    const scale = Math.min((host.clientWidth || width) / width, (host.clientHeight || height) / height, MAX_FLOW_SCALE);
    setSvgSize(host, Math.max(0, Math.floor(width * scale)), Math.max(0, Math.floor(height * scale)));
  }
}

function overflows(root: HTMLElement): boolean {
  const boxes = [root.querySelector<HTMLElement>(".rt-body"), ...root.querySelectorAll<HTMLElement>(".rt-column, .rt-block, .rt-code")];
  return boxes.some((box) => box && (box.scrollHeight > box.clientHeight + 1 || box.scrollWidth > box.clientWidth + 1));
}

function setSvgSize(host: HTMLElement, width: number, height: number): void {
  const svg = host.querySelector("svg");
  if (!svg) return;
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
}

/** Group blocks into columns: a block without `column` starts the next one. */
function renderColumns(blocks: SlideBlock[]): HTMLElement[] {
  const columns = new Map<number, SlideBlock[]>();
  let previous = 0;
  for (const block of blocks) {
    const column = block.column ?? previous + 1;
    previous = column;
    columns.set(column, [...(columns.get(column) ?? []), block]);
  }
  return [...columns.keys()]
    .sort((a, b) => a - b)
    .map((key) => {
      const members = columns.get(key)!;
      const column = el("div", "rt-column");
      column.style.flexGrow = String(Math.max(...members.map((b) => b.span ?? 1)));
      for (const block of members) column.append(renderBlock(block));
      return column;
    });
}

function renderBlock(block: SlideBlock): HTMLElement {
  const wrap = el("div", `rt-block rt-block-${block.type}`);
  wrap.dataset.id = block.id;
  // A callout carries its title inside the box.
  if (block.title && block.type !== "callout") wrap.append(el("div", "rt-block-title", block.title));
  switch (block.type) {
    case "text":
      wrap.append(markdown(block.md));
      break;
    case "bullets":
      wrap.append(renderBullets(block.items, block.ordered === true));
      break;
    case "table":
      wrap.append(renderTable(block));
      break;
    case "code":
      wrap.append(renderCode(block));
      break;
    case "callout":
      wrap.append(renderCallout(block));
      break;
    case "flow":
      wrap.append(renderFlow(block));
      break;
  }
  return wrap;
}

function renderBullets(items: SlideBulletItem[], ordered: boolean): HTMLElement {
  const list = el(ordered ? "ol" : "ul", "rt-list");
  for (const item of items) {
    const li = el("li", toneClass(item.tone));
    li.dataset.id = item.id;
    const text = el("span", "rt-item-text");
    text.innerHTML = inlineMarkdown(item.text);
    li.append(text);
    if (item.items?.length) li.append(renderBullets(item.items, false));
    list.append(li);
  }
  return list;
}

function renderTable(block: SlideTableBlock): HTMLElement {
  const table = el("table", "rt-table");
  if (block.columns.some((c) => c.trim())) {
    const head = el("thead");
    const tr = el("tr");
    for (const column of block.columns) {
      const th = el("th");
      th.innerHTML = inlineMarkdown(column);
      tr.append(th);
    }
    head.append(tr);
    table.append(head);
  }
  const body = el("tbody");
  for (const row of block.rows) {
    const tr = el("tr", toneClass(row.tone));
    tr.dataset.id = row.id;
    for (const cell of row.cells) {
      const td = el("td");
      td.innerHTML = inlineMarkdown(cell);
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);
  return table;
}

function renderCode(block: SlideCodeBlock): HTMLElement {
  const code = el("div", "rt-code");
  if (block.language) code.append(el("div", "rt-code-lang", block.language));
  const first = block.startLine ?? 1;
  block.code.split("\n").forEach((text, i) => {
    const line = el("div", "rt-line");
    line.dataset.id = `${block.id}:L${first + i}`;
    line.append(el("span", "rt-ln", String(first + i)), el("span", "rt-tx", text || " "));
    code.append(line);
  });
  return code;
}

function renderCallout(block: SlideCalloutBlock): HTMLElement {
  const box = el("div", `rt-callout callout-${block.tone}`);
  box.append(el("div", "rt-callout-label", block.title ?? CALLOUT_LABELS[block.tone]), markdown(block.md));
  return box;
}

function renderFlow(block: SlideFlowBlock): HTMLElement {
  const host = el("div", "rt-flow-host");
  const layout = layoutFlow(block, measureText);
  host.dataset.width = String(layout.width);
  host.dataset.height = String(layout.height);

  const svg = svg_("svg", { viewBox: `0 0 ${layout.width} ${layout.height}`, class: "rt-flow-svg", role: "img" });
  const title = svg_("title");
  title.textContent = block.title ?? "Diagram";
  svg.append(title);

  const markers = arrowMarkers(svg);
  const nodesById = new Map(block.nodes.map((n) => [n.id, n]));

  for (const box of layout.groups) {
    const group = block.groups.find((g) => g.id === box.id)!;
    const g = svg_("g", { class: `rt-group ${toneClass(group.tone)}`, "data-id": group.id });
    g.append(svg_("rect", { x: box.x, y: box.y, width: box.width, height: box.height, rx: 10, class: "rt-group-box" }));
    if (group.label) g.append(svgText(group.label, box.x + 12, box.y + 15, "rt-group-label", "start"));
    svg.append(g);
  }

  for (const route of layout.edges) {
    const edge = block.edges.find((e) => e.id === route.id)!;
    const tone = edge.tone && edge.tone !== "default" ? edge.tone : "edge";
    const g = svg_("g", { class: `rt-edge ${toneClass(edge.tone)} ${edge.style === "dashed" ? "dashed" : ""}`, "data-id": edge.id });
    const path = svg_("path", { d: smoothPath(route.points), class: "rt-edge-path" });
    if (edge.arrow !== "none") path.setAttribute("marker-end", `url(#${markers(tone)})`);
    if (edge.arrow === "both") path.setAttribute("marker-start", `url(#${markers(tone)})`);
    g.append(path);
    svg.append(g);
  }

  for (const route of layout.edges) {
    if (!route.label) continue;
    const { x, y, width, height, lines } = route.label;
    const g = svg_("g", { class: "rt-edge-label", "data-for": route.id });
    g.append(svg_("rect", { x, y, width, height, rx: 4 }));
    lines.forEach((line, i) => g.append(svgText(line, x + width / 2, y + 3 + 8 + i * 16, "", "middle")));
    svg.append(g);
  }

  for (const box of layout.nodes) svg.append(renderNode(nodesById.get(box.id)!, box));

  host.append(svg);
  return host;
}

function renderNode(node: SlideFlowNode, box: FlowNodeBox): SVGElement {
  const toned = node.tone && node.tone !== "default";
  const g = svg_("g", { class: `rt-node shape-${node.shape} ${toneClass(node.tone)}${toned ? " toned" : ""}`, "data-id": node.id });
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

  const labelHeight = box.labelLines.length * 20;
  const subHeight = box.subLines.length > 0 ? 3 + box.subLines.length * 17 : 0;
  let top = box.textY - (labelHeight + subHeight) / 2;
  for (const line of box.labelLines) {
    g.append(svgText(line, box.textX, top + 10, "rt-node-label", "middle"));
    top += 20;
  }
  top += 3;
  for (const line of box.subLines) {
    g.append(svgText(line, box.textX, top + 8.5, "rt-node-sub", "middle"));
    top += 17;
  }

  if (node.badge) {
    const width = Math.ceil(measureFont(node.badge, "600 11px")) + 14;
    const bx = x + w - width + 8;
    const by = y - 9;
    const badge = svg_("g", { class: "rt-badge" });
    badge.append(svg_("rect", { x: bx, y: by, width, height: 18, rx: 9 }), svgText(node.badge, bx + width / 2, by + 9, "", "middle"));
    g.append(badge);
  }
  return g;
}

/** One arrowhead marker per tone, created on first use. */
function arrowMarkers(svg: SVGElement): (tone: string) => string {
  const defs = svg_("defs");
  svg.append(defs);
  const made = new Map<string, string>();
  return (tone) => {
    let id = made.get(tone);
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
    marker.append(svg_("path", { d: "M1,1 L9,5 L1,9 Z", class: `rt-arrowhead ${tone === "edge" ? "" : `tone-${tone}`}` }));
    defs.append(marker);
    made.set(tone, id);
    return id;
  };
}

/** A curve through dagre's bend points, straight where it leaves and enters nodes. */
function smoothPath(points: FlowPoint[]): string {
  if (points.length === 0) return "";
  const p = (pt: FlowPoint) => `${pt.x},${pt.y}`;
  if (points.length === 2) return `M${p(points[0])} L${p(points[1])}`;
  let d = `M${p(points[0])}`;
  const mid = (a: FlowPoint, b: FlowPoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  d += ` L${p(mid(points[0], points[1]))}`;
  for (let i = 1; i < points.length - 1; i++) {
    const end = i === points.length - 2 ? points[i + 1] : mid(points[i], points[i + 1]);
    d += ` Q${p(points[i])} ${p(end)}`;
  }
  return d;
}

function renderWarnings(warnings: string[]): HTMLElement {
  const details = el("details", "rt-warnings");
  details.append(el("summary", "", `⚠ ${warnings.length} problem${warnings.length === 1 ? "" : "s"} reading this slide`));
  const list = el("ul");
  for (const warning of warnings) list.append(el("li", "", warning));
  details.append(list);
  return details;
}

function markdown(md: string): HTMLElement {
  const div = el("div", "rt-md");
  div.innerHTML = renderNarrationMarkdown(md);
  return div;
}

/** Markdown for one line: emphasis and code, without the paragraph wrapper. */
function inlineMarkdown(text: string): string {
  const html = renderNarrationMarkdown(text);
  const single = /^<p>([\s\S]*)<\/p>$/.exec(html);
  return single && !single[1].includes("<p>") ? single[1] : html;
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

function measureFont(text: string, font: string): number {
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (!measureContext) return text.length * 8;
  measureContext.font = `${font} ${getComputedStyle(document.body).fontFamily || "sans-serif"}`;
  return measureContext.measureText(text).width;
}

function measureText(text: string, font: FlowFont): number {
  return measureFont(text, FONTS[font]);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className.trim()) node.className = className.trim();
  if (text !== undefined) node.textContent = text;
  return node;
}

function svg_(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
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
