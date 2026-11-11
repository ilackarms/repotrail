/**
 * Layout for `flow` blocks: node sizes, positions, edge routes and group boxes.
 *
 * Pure: no DOM and no `vscode`. Text widths come from an injected measurer, so
 * the slide webview passes real canvas measurements and tests pass an
 * approximation. Every element is laid out, including ones a beat reveals
 * later, so nothing moves when it appears.
 */

import type { SlideFlowBlock, SlideFlowNode } from "../types";

export type FlowFont = "label" | "sub" | "edge" | "group";
export type TextMeasure = (text: string, font: FlowFont) => number;

export interface FlowPoint {
  x: number;
  y: number;
}

export interface FlowNodeBox {
  id: string;
  /** Top-left corner and size of the node's shape. */
  x: number;
  y: number;
  width: number;
  height: number;
  labelLines: string[];
  subLines: string[];
  /** Center of the text block, which some shapes shift off-center. */
  textX: number;
  textY: number;
}

export interface FlowEdgeRoute {
  id: string;
  points: FlowPoint[];
  label?: { x: number; y: number; width: number; height: number; lines: string[] };
}

export interface FlowGroupBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FlowLayout {
  width: number;
  height: number;
  nodes: FlowNodeBox[];
  edges: FlowEdgeRoute[];
  groups: FlowGroupBox[];
}

/** Sizes in slide pixels (the canvas is 1280×720). Kept in sync with slides.css. */
export const FLOW_METRICS = {
  labelLine: 20,
  subLine: 17,
  edgeLine: 16,
  groupLabel: 22,
  padX: 18,
  padY: 11,
  minWidth: 112,
  maxTextWidth: 210,
  maxEdgeLabelWidth: 170,
  groupPad: 14,
  margin: 12,
} as const;

interface DagreNodeLabel {
  width: number;
  height: number;
  x: number;
  y: number;
}

interface DagreEdgeLabel {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  points?: FlowPoint[];
}

interface DagreGraph {
  setGraph(label: object): void;
  setDefaultEdgeLabel(fn: () => object): void;
  setNode(id: string, label: object): void;
  setParent(id: string, parent: string): void;
  setEdge(v: string, w: string, label: object, name: string): void;
  node(id: string): DagreNodeLabel;
  edge(v: string, w: string, name: string): DagreEdgeLabel;
}

interface DagreModule {
  graphlib: { Graph: new (options: object) => DagreGraph };
  layout(graph: DagreGraph): void;
}

// dagre ships ESM types that a CommonJS build can't import, so declare the
// small surface used here. esbuild bundles the package's CommonJS entry.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dagre = require("@dagrejs/dagre") as DagreModule;

export function layoutFlow(block: SlideFlowBlock, measure: TextMeasure): FlowLayout {
  const m = FLOW_METRICS;
  const graph = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  graph.setGraph({
    rankdir: block.direction,
    nodesep: block.direction === "LR" ? 28 : 40,
    ranksep: block.direction === "LR" ? 56 : 44,
    edgesep: 14,
    marginx: 0,
    marginy: 0,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  const sized = new Map<string, { width: number; height: number; labelLines: string[]; subLines: string[]; textDy: number; textDx: number }>();
  for (const node of block.nodes) {
    const size = nodeSize(node, measure);
    sized.set(node.id, size);
    graph.setNode(node.id, { width: size.width, height: size.height });
  }
  const groupIds = new Set(block.nodes.flatMap((n) => (n.group ? [n.group] : [])));
  for (const group of block.groups) {
    if (!groupIds.has(group.id)) continue;
    graph.setNode(`group:${group.id}`, {});
  }
  for (const node of block.nodes) {
    if (node.group) graph.setParent(node.id, `group:${node.group}`);
  }

  const edgeLabels = new Map<string, { width: number; height: number; lines: string[] }>();
  for (const edge of block.edges) {
    const label: Record<string, unknown> = {};
    if (edge.label) {
      const lines = wrap(edge.label, "edge", m.maxEdgeLabelWidth, measure, 2);
      const width = Math.ceil(Math.max(...lines.map((l) => measure(l, "edge")))) + 12;
      const height = lines.length * m.edgeLine + 6;
      edgeLabels.set(edge.id, { width, height, lines });
      Object.assign(label, { width, height, labelpos: "c" });
    }
    graph.setEdge(edge.from, edge.to, label, edge.id);
  }

  dagre.layout(graph);

  const nodes: FlowNodeBox[] = block.nodes.map((node) => {
    const placed = graph.node(node.id);
    const size = sized.get(node.id)!;
    return {
      id: node.id,
      x: placed.x - size.width / 2,
      y: placed.y - size.height / 2,
      width: size.width,
      height: size.height,
      labelLines: size.labelLines,
      subLines: size.subLines,
      textX: placed.x + size.textDx,
      textY: placed.y + size.textDy,
    };
  });

  const edges: FlowEdgeRoute[] = block.edges.map((edge) => {
    const placed = graph.edge(edge.from, edge.to, edge.id);
    const route: FlowEdgeRoute = { id: edge.id, points: (placed.points ?? []).map((p) => ({ x: p.x, y: p.y })) };
    const label = edgeLabels.get(edge.id);
    if (label && placed.x !== undefined && placed.y !== undefined) {
      route.label = { x: placed.x - label.width / 2, y: placed.y - label.height / 2, width: label.width, height: label.height, lines: label.lines };
    }
    return route;
  });

  // dagre's cluster box hugs its members; make room for the group's label.
  const groups: FlowGroupBox[] = block.groups
    .filter((group) => groupIds.has(group.id))
    .map((group) => {
      const members = nodes.filter((n) => block.nodes.find((bn) => bn.id === n.id)?.group === group.id);
      const left = Math.min(...members.map((n) => n.x)) - m.groupPad;
      const right = Math.max(...members.map((n) => n.x + n.width)) + m.groupPad;
      const top = Math.min(...members.map((n) => n.y)) - m.groupPad - (group.label ? m.groupLabel : 0);
      const bottom = Math.max(...members.map((n) => n.y + n.height)) + m.groupPad;
      return { id: group.id, x: left, y: top, width: right - left, height: bottom - top };
    });

  return normalizeOrigin({ width: 0, height: 0, nodes, edges, groups }, m.margin);
}

function nodeSize(node: SlideFlowNode, measure: TextMeasure) {
  const m = FLOW_METRICS;
  const labelLines = wrap(node.label, "label", m.maxTextWidth, measure, 2);
  const subLines = node.sub ? wrap(node.sub, "sub", m.maxTextWidth, measure, 2) : [];
  const textWidth = Math.max(...labelLines.map((l) => measure(l, "label")), ...subLines.map((l) => measure(l, "sub")));
  const textHeight = labelLines.length * m.labelLine + (subLines.length > 0 ? 3 + subLines.length * m.subLine : 0);
  let width = Math.max(m.minWidth, Math.ceil(textWidth) + 2 * m.padX);
  let height = textHeight + 2 * m.padY;
  let textDy = 0;
  let textDx = 0;
  switch (node.shape) {
    case "store":
      height += 16; // the cylinder's top and bottom caps
      textDy = 4;
      break;
    case "decision":
      width = Math.max(140, Math.ceil(textWidth * 1.45) + 36);
      height = Math.max(72, Math.ceil(textHeight * 1.9) + 16);
      break;
    case "actor":
      width += 26; // the person glyph left of the label
      textDx = 11;
      break;
    case "device":
      width += 6; // the stacked card behind the front one
      height += 6;
      textDx = -3;
      textDy = -3;
      break;
    case "queue":
      width += 18; // the slots on the right
      textDx = -8;
      break;
    case "file":
      width += 8; // the folded corner
      break;
  }
  return { width, height, labelLines, subLines, textDx, textDy };
}

/** Greedy word wrap into at most `maxLines` lines; a long word stays whole. */
export function wrap(text: string, font: FlowFont, maxWidth: number, measure: TextMeasure, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = words[0];
  for (const word of words.slice(1)) {
    const candidate = `${line} ${word}`;
    if (measure(candidate, font) <= maxWidth) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  lines.push(line);
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines - 1), lines.slice(maxLines - 1).join(" ")];
}

/** Shift everything so the drawing starts at `margin`, and size the canvas. */
function normalizeOrigin(layout: FlowLayout, margin: number): FlowLayout {
  const xs: number[] = [];
  const ys: number[] = [];
  const add = (x: number, y: number, w = 0, h = 0) => {
    xs.push(x, x + w);
    ys.push(y, y + h);
  };
  layout.nodes.forEach((n) => add(n.x, n.y, n.width, n.height));
  layout.groups.forEach((g) => add(g.x, g.y, g.width, g.height));
  layout.edges.forEach((e) => {
    e.points.forEach((p) => add(p.x, p.y));
    if (e.label) add(e.label.x, e.label.y, e.label.width, e.label.height);
  });
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const dx = margin - minX;
  const dy = margin - minY;
  const round = (v: number) => Math.round(v * 10) / 10;
  return {
    width: Math.ceil(Math.max(...xs) - minX + 2 * margin),
    height: Math.ceil(Math.max(...ys) - minY + 2 * margin),
    nodes: layout.nodes.map((n) => ({ ...n, x: round(n.x + dx), y: round(n.y + dy), textX: round(n.textX + dx), textY: round(n.textY + dy) })),
    groups: layout.groups.map((g) => ({ ...g, x: round(g.x + dx), y: round(g.y + dy) })),
    edges: layout.edges.map((e) => ({
      ...e,
      points: e.points.map((p) => ({ x: round(p.x + dx), y: round(p.y + dy) })),
      label: e.label ? { ...e.label, x: round(e.label.x + dx), y: round(e.label.y + dy) } : undefined,
    })),
  };
}
