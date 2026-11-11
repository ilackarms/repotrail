/**
 * Builds a slide's DOM on a fixed 1280×720 canvas.
 *
 * Browser-only. Everything comes from typed slide data: text goes in through
 * `textContent` or the escaping narration markdown renderer, SVG through
 * attributes. No agent-supplied markup is ever parsed.
 */

import type { SlideViewPayload } from "../../engine/slides/payload";
import { slideBeats, textVariants } from "../../engine/slides/timeline";
import type {
  SlideBlock,
  SlideBulletItem,
  SlideCalloutBlock,
  SlideCalloutTone,
  SlideCodeBlock,
  SlideTableBlock,
} from "../../engine/types";
import { renderNarrationMarkdown } from "../../ux/narrationMarkdown";
import { flip, refLabel, renderFlow, renderSequence, setTone, type DiagramContext } from "./diagrams";
import type { SlideRef } from "../../engine/types";

export interface RenderOptions {
  /** Where clicking a `ref` opens its file; without it refs only show a tooltip. */
  onOpenRef?: (ref: SlideRef) => void;
}

export const SLIDE_WIDTH = 1280;
export const SLIDE_HEIGHT = 720;

const MAX_FLOW_SCALE = 1.4;
const MIN_FIT = 0.6;
const MIN_CODE_FIT = 0.55;
const CALLOUT_LABELS: Record<SlideCalloutTone, string> = {
  info: "Note",
  warn: "Warning",
  risk: "Risk",
  decision: "Decision",
  question: "Open question",
};

export interface RenderedSlide {
  root: HTMLElement;
  ctx: DiagramContext;
  /** Where the current beat's narration shows, when captions are on. */
  caption: HTMLElement | null;
  /** One dot per position, when the slide has beats. */
  dots: HTMLElement | null;
}

export function renderSlide(payload: SlideViewPayload, options: RenderOptions = {}): RenderedSlide {
  const { slide } = payload;
  const ctx: DiagramContext = {
    appliers: new Map(),
    edgePaths: new Map(),
    variants: textVariants(slide),
    onOpenRef: options.onOpenRef,
  };
  const beats = slideBeats(slide);
  const root = el("div", `rt-slide layout-${slide.layout}`);
  root.style.setProperty("--fit", "1");

  const header = el("header", "rt-header");
  if (slide.eyebrow) header.append(el("div", "rt-eyebrow", slide.eyebrow));
  header.append(el("h1", "rt-title", payload.title));
  if (slide.subtitle) header.append(el("div", "rt-subtitle", slide.subtitle));
  root.append(header);

  const body = el("section", "rt-body");
  if (slide.layout === "columns") body.append(...renderColumns(slide.blocks, ctx));
  else for (const block of slide.blocks) body.append(renderBlock(block, ctx));
  root.append(body);

  let caption: HTMLElement | null = null;
  if (payload.captions && beats.some((beat) => beat.say)) {
    root.classList.add("has-captions");
    caption = el("div", "rt-caption");
    caption.setAttribute("aria-live", "polite");
    root.append(caption);
  }

  const footer = el("footer", "rt-footer");
  footer.append(el("span", "rt-position", `${payload.index + 1} / ${payload.total}`));
  let dots: HTMLElement | null = null;
  if (beats.length > 0) {
    dots = el("span", "rt-dots");
    dots.setAttribute("aria-label", "Beats");
    for (let i = 0; i <= beats.length; i++) dots.append(el("i"));
    footer.append(dots);
  }
  footer.append(el("span", "rt-source", payload.source ?? ""));
  root.append(footer);

  if (slide.warnings?.length) root.append(renderWarnings(slide.warnings));
  return { root, ctx, caption, dots };
}

/**
 * Size the slide's contents once it is in the document: shrink code until its
 * longest line fits, shrink text until nothing overflows, then scale each
 * diagram into the room it has left. Hidden elements keep their space, so this
 * runs once per slide and beats never move anything.
 */
export function fitSlide(root: HTMLElement): void {
  const hosts = [...root.querySelectorAll<HTMLElement>(".rt-flow-host")];
  for (const host of hosts) setSvgSize(host, 0, 0);

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
function renderColumns(blocks: SlideBlock[], ctx: DiagramContext): HTMLElement[] {
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
      for (const block of members) column.append(renderBlock(block, ctx));
      return column;
    });
}

function renderBlock(block: SlideBlock, ctx: DiagramContext): HTMLElement {
  const wrap = el("div", `rt-block rt-block-${block.type}`);
  wrap.dataset.id = block.id;
  // A callout carries its title inside the box.
  if (block.title && block.type !== "callout") wrap.append(el("div", "rt-block-title", block.title));
  switch (block.type) {
    case "text":
      wrap.append(markdown(block.md));
      break;
    case "bullets":
      wrap.append(renderBullets(block.items, block.ordered === true, ctx));
      break;
    case "table":
      wrap.append(renderTable(block, ctx));
      break;
    case "code":
      wrap.append(renderCode(block, ctx));
      break;
    case "callout":
      wrap.append(renderCallout(block));
      break;
    case "flow":
      wrap.append(renderFlow(block, ctx));
      break;
    case "sequence":
      wrap.append(renderSequence(block, ctx));
      break;
  }
  return wrap;
}

function renderBullets(items: SlideBulletItem[], ordered: boolean, ctx: DiagramContext): HTMLElement {
  const list = el(ordered ? "ol" : "ul", "rt-list");
  for (const item of items) {
    const li = el("li");
    li.dataset.id = item.id;
    const text = el("span", "rt-item-text");
    li.append(text);
    if (item.items?.length) li.append(renderBullets(item.items, false, ctx));
    list.append(li);
    let shown = "";
    ctx.appliers.set(item.id, (patch, animate) => {
      setTone(li, patch?.tone ?? item.tone, false);
      const next = patch?.label ?? item.text;
      if (next !== shown) {
        text.innerHTML = inlineMarkdown(next);
        if (animate && shown) flip(text);
        shown = next;
      }
    });
    ctx.appliers.get(item.id)!(undefined, false);
  }
  return list;
}

function renderTable(block: SlideTableBlock, ctx: DiagramContext): HTMLElement {
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
    const tr = el("tr");
    tr.dataset.id = row.id;
    for (const cell of row.cells) {
      const td = el("td");
      td.innerHTML = inlineMarkdown(cell);
      tr.append(td);
    }
    body.append(tr);
    ctx.appliers.set(row.id, (patch) => setTone(tr, patch?.tone ?? row.tone, false));
    ctx.appliers.get(row.id)!(undefined, false);
  }
  table.append(body);
  return table;
}

function renderCode(block: SlideCodeBlock, ctx: DiagramContext): HTMLElement {
  const code = el("div", "rt-code");
  if (block.ref) {
    const ref = block.ref;
    const link = el(ctx.onOpenRef ? "button" : "span", "rt-code-ref", `↗ ${refLabel(ref)}`);
    link.title = ctx.onOpenRef ? `Open ${refLabel(ref)}` : refLabel(ref);
    const open = ctx.onOpenRef;
    if (open) link.addEventListener("click", () => open(ref));
    code.append(link);
  } else if (block.language) code.append(el("div", "rt-code-lang", block.language));
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
export function inlineMarkdown(text: string): string {
  const html = renderNarrationMarkdown(text);
  const single = /^<p>([\s\S]*)<\/p>$/.exec(html);
  return single && !single[1].includes("<p>") ? single[1] : html;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className.trim()) node.className = className.trim();
  if (text !== undefined) node.textContent = text;
  return node;
}
