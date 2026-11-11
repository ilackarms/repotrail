import type { SlideRef, TourSlide } from "../types";

/** Every source ref on a slide: code blocks, flow nodes and sequence participants. */
export function slideRefs(slide: TourSlide): SlideRef[] {
  const refs: SlideRef[] = [];
  for (const block of slide.blocks) {
    if (block.type === "code" && block.ref) refs.push(block.ref);
    if (block.type === "flow") for (const node of block.nodes) if (node.ref) refs.push(node.ref);
    if (block.type === "sequence") for (const p of block.participants) if (p.ref) refs.push(p.ref);
  }
  return refs;
}
