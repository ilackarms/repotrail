/**
 * A slide on screen and its beats.
 *
 * The slide is rendered and fitted once, with every element present. Moving to
 * a position computes that position's state (engine/slides/timeline) and
 * applies the difference: one step forward animates it and plays the beat's
 * effects; anything else (Back, jumps, live reload) snaps to it.
 */

import type { SlideMotion, SlideViewPayload } from "../../engine/slides/payload";
import { effectsEntering, slideBeats, stateAt, type SlideEffects, type SlideState } from "../../engine/slides/timeline";
import { flip, measureFont, setTone, svg_ } from "./diagrams";
import { fitSlide, inlineMarkdown, renderSlide, type RenderedSlide, type RenderOptions } from "./render";

const STAGGER_MS = 60;
const DRAW_MS = 420;
const FLOW_MS = 700;
const PULSE_MS = 520;
const MORPH_MS = 520;

/** Identity of a slide's content: the same key means only the position changed. */
export function slideKey(payload: SlideViewPayload): string {
  return JSON.stringify([payload.index, payload.total, payload.title, payload.source ?? null, payload.captions, payload.slide]);
}

export class SlideView {
  readonly key: string;
  readonly root: HTMLElement;
  position = -1;
  private readonly rendered: RenderedSlide;
  private state: SlideState | null = null;
  private readonly byId = new Map<string, Element[]>();
  private cancels: Array<() => void> = [];

  constructor(
    private readonly payload: SlideViewPayload,
    options: RenderOptions = {},
  ) {
    this.key = slideKey(payload);
    this.rendered = renderSlide(payload, options);
    this.root = this.rendered.root;
  }

  /** The stop this slide belongs to. */
  get index(): number {
    return this.payload.index;
  }

  /**
   * Shared-element transition from the slide on screen before this one. Nodes
   * and participants with the same id on both slides glide from their old
   * place and size to the new one; everything else cross-fades as the old
   * slide fades out on top. Both slides must be mounted and placed the same
   * way. Returns how long the old slide should take to fade.
   */
  morphFrom(previous: SlideView, motion: SlideMotion): number {
    if (effectiveMotion(motion) !== "full") return 200;
    const before = new Map<string, Element>();
    for (const node of previous.root.querySelectorAll(".rt-node[data-id]:not(.rt-hidden)")) {
      before.set(node.getAttribute("data-id")!, node);
    }
    let moved = 0;
    for (const node of this.root.querySelectorAll<SVGGraphicsElement>(".rt-node[data-id]:not(.rt-hidden)")) {
      const old = before.get(node.getAttribute("data-id")!);
      const oldShape = old?.querySelector(".rt-shape");
      const newShape = node.querySelector(".rt-shape");
      const ctm = node.getScreenCTM?.();
      if (!old || !oldShape || !newShape || !ctm || !node.animate) continue;
      const a = oldShape.getBoundingClientRect();
      const b = newShape.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      // Screen pixels to this SVG's user units, which CSS transforms on SVG use.
      const dx = (a.left + a.width / 2 - (b.left + b.width / 2)) / ctm.a;
      const dy = (a.top + a.height / 2 - (b.top + b.height / 2)) / ctm.d;
      const scale = Math.max(0.5, Math.min(2, (a.width / b.width + a.height / b.height) / 2));
      const animation = node.animate(
        [{ transform: `translate(${dx}px, ${dy}px) scale(${scale})` }, { transform: "none" }],
        { duration: MORPH_MS, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" },
      );
      this.cancels.push(() => animation.cancel());
      (old as SVGElement).style.opacity = "0";
      moved++;
    }
    if (moved === 0) return 200;
    // Edges would sit at the nodes' final places while they're still moving.
    this.root.classList.add("rt-morphing");
    const timer = setTimeout(() => this.root.classList.remove("rt-morphing"), MORPH_MS - 120);
    this.cancels.push(() => {
      clearTimeout(timer);
      this.root.classList.remove("rt-morphing");
    });
    return 320;
  }

  /** Fit and show the starting position. Call once the root is in the document. */
  mount(): void {
    fitSlide(this.root);
    for (const el of this.root.querySelectorAll("[data-id], [data-for]")) {
      const id = el.getAttribute("data-id") ?? el.getAttribute("data-for")!;
      this.byId.set(id, [...(this.byId.get(id) ?? []), el]);
    }
    this.goTo(this.payload.position, { animate: false, motion: this.payload.motion });
  }

  goTo(position: number, options: { animate: boolean; motion: SlideMotion }): void {
    const motion = effectiveMotion(options.motion);
    for (const m of ["full", "reduced", "off"]) this.root.classList.toggle(`rt-motion-${m}`, m === motion);
    const previous = this.state;
    const next = stateAt(this.payload.slide, position);
    const animate = options.animate && motion !== "off" && previous !== null && next.position === previous.position + 1;
    this.cancelEffects();
    const effects = animate ? effectsEntering(this.payload.slide, next.position) : null;

    if (!animate) this.root.classList.add("rt-snap");
    this.applyHidden(next, effects, motion);
    this.applyPatches(previous, next, animate);
    this.applyAttention(next);
    this.applyCaption(next, animate);
    this.applyDots(next);
    if (!animate) {
      void this.root.offsetWidth; // commit the snapped styles before transitions come back
      this.root.classList.remove("rt-snap");
    }
    if (effects && motion === "full") this.playEffects(effects);
    this.state = next;
    this.position = next.position;
  }

  dispose(): void {
    this.cancelEffects();
  }

  private elements(id: string): Element[] {
    return this.byId.get(id) ?? [];
  }

  private applyHidden(next: SlideState, effects: SlideEffects | null, motion: SlideMotion): void {
    const hidden = new Set(next.hidden);
    for (const [id, els] of this.byId) for (const el of els) el.classList.toggle("rt-hidden", hidden.has(id));
    if (!effects) return;
    effects.appear.forEach((id, i) => {
      const delay = Math.min(i, 8) * STAGGER_MS;
      for (const el of this.elements(id)) {
        if (delay > 0) this.delayTransition(el as HTMLElement | SVGElement, delay);
        if (motion === "full") this.draw(el, delay);
      }
    });
  }

  /** Draw an appearing edge or message from its source to its target. */
  private draw(el: Element, delay: number): void {
    if (!el.matches(".rt-edge:not(.dashed), .rt-seq-message:not(.dashed)")) return;
    const path = el.querySelector<SVGPathElement>(".rt-edge-path");
    if (!path?.animate) return;
    const length = path.getTotalLength();
    const dash = `${length} ${length}`;
    const animation = path.animate(
      [
        { strokeDasharray: dash, strokeDashoffset: length },
        { strokeDasharray: dash, strokeDashoffset: 0 },
      ],
      { duration: DRAW_MS, delay, easing: "ease-out", fill: "backwards" },
    );
    this.cancels.push(() => animation.cancel());
  }

  private delayTransition(el: HTMLElement | SVGElement, delay: number): void {
    el.style.transitionDelay = `${delay}ms`;
    const timer = setTimeout(() => (el.style.transitionDelay = ""), delay + 400);
    this.cancels.push(() => {
      clearTimeout(timer);
      el.style.transitionDelay = "";
    });
  }

  private applyPatches(previous: SlideState | null, next: SlideState, animate: boolean): void {
    const before = previous?.patches ?? {};
    const ids = new Set([...Object.keys(before), ...Object.keys(next.patches)]);
    for (const id of ids) {
      if (JSON.stringify(before[id]) === JSON.stringify(next.patches[id])) continue;
      const applier = this.rendered.ctx.appliers.get(id);
      if (applier) applier(next.patches[id], animate);
      else for (const el of this.elements(id)) setTone(el, next.patches[id]?.tone, false);
    }
  }

  /** Highlight rings, and focus: dim everything that isn't, or doesn't hold, a focused element. */
  private applyAttention(next: SlideState): void {
    for (const el of this.root.querySelectorAll(".rt-dim, .rt-focus, .rt-highlight")) {
      el.classList.remove("rt-dim", "rt-focus", "rt-highlight");
    }
    for (const id of next.highlight) for (const el of this.elements(id)) el.classList.add("rt-highlight");
    if (next.focus.length === 0) return;
    const focused = new Set(next.focus.flatMap((id) => this.elements(id)));
    for (const el of focused) el.classList.add("rt-focus");
    const visit = (container: Element) => {
      for (const child of targetChildren(container)) {
        if (focused.has(child) || child.classList.contains("rt-hidden")) continue;
        if ([...focused].some((f) => child.contains(f))) visit(child);
        else child.classList.add("rt-dim");
      }
    };
    const body = this.root.querySelector(".rt-body");
    if (body) visit(body);
  }

  private applyCaption(next: SlideState, animate: boolean): void {
    const caption = this.rendered.caption;
    if (!caption) return;
    const say = next.position > 0 ? slideBeats(this.payload.slide)[next.position - 1]?.say ?? "" : "";
    if (caption.dataset.say === say) return;
    caption.dataset.say = say;
    caption.innerHTML = say ? inlineMarkdown(say) : "";
    caption.classList.toggle("empty", !say);
    if (animate && say) flip(caption);
  }

  private applyDots(next: SlideState): void {
    const dots = this.rendered.dots;
    if (!dots) return;
    [...dots.children].forEach((dot, i) => {
      dot.classList.toggle("on", i <= next.position);
      dot.classList.toggle("current", i === next.position);
    });
    dots.setAttribute("aria-label", `Beat ${next.position} of ${dots.children.length - 1}`);
  }

  private playEffects(effects: SlideEffects): void {
    const lead = effects.appear.length > 0 ? 180 : 0;
    const perSlot = new Map<number, number>();
    for (const flow of effects.flows) {
      const path = this.rendered.ctx.edgePaths.get(flow.edge);
      if (!path) continue;
      const nth = perSlot.get(flow.slot) ?? 0;
      perSlot.set(flow.slot, nth + 1);
      this.token(path, flow.reverse === true, flow.label, flow.tone, lead + flow.slot * FLOW_MS + nth * 70);
    }
    for (const id of effects.pulse) {
      const appeared = effects.appear.includes(id);
      for (const el of this.elements(id)) {
        if (el.hasAttribute("data-for") || !el.animate) continue;
        const animation = el.animate(
          [{ transform: "scale(1)" }, { transform: "scale(1.07)" }, { transform: "scale(1)" }],
          { duration: PULSE_MS, delay: appeared ? 260 : 60, easing: "ease-in-out" },
        );
        this.cancels.push(() => animation.cancel());
      }
    }
  }

  /** A dot (with an optional label) that travels along an edge once. */
  private token(path: SVGPathElement, reverse: boolean, label: string | undefined, tone: string | undefined, delay: number): void {
    const svg = path.ownerSVGElement;
    if (!svg) return;
    const token = svg_("g", { class: `rt-token ${tone && tone !== "default" ? `tone-${tone}` : ""}` });
    token.append(svg_("circle", { r: 6 }));
    if (label) {
      const width = Math.ceil(measureFont(label, "600 11px")) + 12;
      const chip = svg_("g", { transform: "translate(0,-17)" });
      const text = svg_("text", { x: 0, y: 0, "text-anchor": "middle", "dominant-baseline": "central" });
      text.textContent = label;
      chip.append(svg_("rect", { x: -width / 2, y: -9, width, height: 18, rx: 9 }), text);
      token.append(chip);
    }
    token.style.opacity = "0";
    svg.append(token);
    const length = path.getTotalLength();
    let frame = 0;
    let start: number | null = null;
    const step = (now: number) => {
      start ??= now + delay;
      const t = Math.min(1, Math.max(0, (now - start) / FLOW_MS));
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const point = path.getPointAtLength((reverse ? 1 - eased : eased) * length);
      token.setAttribute("transform", `translate(${point.x},${point.y})`);
      token.style.opacity = now < start ? "0" : String(Math.min(1, t * 8, (1 - t) * 8 + 0.15));
      if (t < 1) frame = requestAnimationFrame(step);
      else token.remove();
    };
    frame = requestAnimationFrame(step);
    this.cancels.push(() => {
      cancelAnimationFrame(frame);
      token.remove();
    });
  }

  private cancelEffects(): void {
    const cancels = this.cancels;
    this.cancels = [];
    for (const cancel of cancels) cancel();
  }
}

/** The nearest descendants that are beat targets (`data-id` or `data-for`). */
function targetChildren(container: Element): Element[] {
  const out: Element[] = [];
  const walk = (node: Element) => {
    for (const child of node.children) {
      if (child.hasAttribute("data-id") || child.hasAttribute("data-for")) out.push(child);
      else walk(child);
    }
  };
  walk(container);
  return out;
}

function effectiveMotion(motion: SlideMotion): SlideMotion {
  if (motion === "full" && typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return "reduced";
  }
  return motion;
}
