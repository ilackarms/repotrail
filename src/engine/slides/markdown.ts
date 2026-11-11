/**
 * Slides as markdown, for the Markdown export: text, lists, tables and code
 * as themselves, flow and sequence diagrams as mermaid (GitHub renders it),
 * and beat narration as a numbered list.
 */

import type { SlideBlock, SlideBulletItem, SlideFlowBlock, SlideSequenceBlock, TourSlide } from "../types";
import { slideBeats } from "./timeline";

const CALLOUT_LABELS = { info: "Note", warn: "Warning", risk: "Risk", decision: "Decision", question: "Open question" } as const;

export function slideToMarkdown(slide: TourSlide): string[] {
  const lines: string[] = [];
  if (slide.eyebrow || slide.subtitle) {
    lines.push([slide.eyebrow ? `**${slide.eyebrow}**` : "", slide.subtitle ?? ""].filter(Boolean).join(" · "), "");
  }
  for (const block of slide.blocks) {
    if (block.title && block.type !== "callout") lines.push(`**${block.title}**`, "");
    lines.push(...blockToMarkdown(block), "");
  }
  const says = slideBeats(slide).map((beat) => beat.say).filter((say): say is string => Boolean(say));
  if (says.length > 0) {
    lines.push("_Narration:_", "");
    says.forEach((say, i) => lines.push(`${i + 1}. ${say}`));
    lines.push("");
  }
  return lines;
}

function blockToMarkdown(block: SlideBlock): string[] {
  switch (block.type) {
    case "text":
      return [block.md.trim()];
    case "callout":
      return block.md
        .trim()
        .split("\n")
        .map((line, i) => `> ${i === 0 ? `**${block.title ?? CALLOUT_LABELS[block.tone]}:** ` : ""}${line}`);
    case "bullets":
      return bullets(block.items, block.ordered === true, "");
    case "table": {
      const width = Math.max(block.columns.length, ...block.rows.map((r) => r.cells.length));
      const header = Array.from({ length: width }, (_, i) => cell(block.columns[i] ?? ""));
      return [
        `| ${header.join(" | ")} |`,
        `| ${header.map(() => "---").join(" | ")} |`,
        ...block.rows.map((row) => `| ${Array.from({ length: width }, (_, i) => cell(row.cells[i] ?? "")).join(" | ")} |`),
      ];
    }
    case "code": {
      const fence = block.code.includes("```") ? "~~~~" : "```";
      return [`${fence}${block.language ?? ""}`, block.code, fence];
    }
    case "flow":
      return ["```mermaid", ...flowToMermaid(block), "```"];
    case "sequence":
      return ["```mermaid", ...sequenceToMermaid(block), "```"];
  }
}

function bullets(items: SlideBulletItem[], ordered: boolean, indent: string): string[] {
  return items.flatMap((item, i) => [
    `${indent}${ordered ? `${i + 1}.` : "-"} ${item.text}`,
    ...(item.items ? bullets(item.items, false, `${indent}  `) : []),
  ]);
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Mermaid ids must be simple; slide ids may hold dots and dashes. */
function idMap(ids: string[], prefix: string): Map<string, string> {
  return new Map(ids.map((id, i) => [id, `${prefix}${i}`]));
}

/** Text inside a quoted mermaid label. */
function label(text: string): string {
  return text.replace(/"/g, "#quot;").replace(/[<>]/g, (c) => (c === "<" ? "#lt;" : "#gt;")).replace(/\n/g, " ");
}

export function flowToMermaid(block: SlideFlowBlock): string[] {
  const ids = idMap(block.nodes.map((n) => n.id), "n");
  const out = [`flowchart ${block.direction}`];
  const node = (id: string) => {
    const n = block.nodes.find((x) => x.id === id)!;
    const text = `"${label(n.label)}${n.sub ? `<br/><small>${label(n.sub)}</small>` : ""}"`;
    const key = ids.get(id)!;
    switch (n.shape) {
      case "store":
        return `${key}[(${text})]`;
      case "decision":
        return `${key}{${text}}`;
      case "actor":
      case "service":
        return `${key}([${text}])`;
      case "file":
      case "note":
        return `${key}>${text}]`;
      case "queue":
        return `${key}[[${text}]]`;
      default:
        return `${key}[${text}]`;
    }
  };
  for (const group of block.groups) {
    const members = block.nodes.filter((n) => n.group === group.id);
    if (members.length === 0) continue;
    out.push(`  subgraph g${block.groups.indexOf(group)}["${label(group.label ?? group.id)}"]`);
    for (const member of members) out.push(`    ${node(member.id)}`);
    out.push("  end");
  }
  for (const n of block.nodes) if (!n.group || !block.groups.some((g) => g.id === n.group)) out.push(`  ${node(n.id)}`);
  for (const edge of block.edges) {
    const dashed = edge.style === "dashed";
    const body = edge.arrow === "none" ? (dashed ? "-.-" : "---") : dashed ? "-.->" : "-->";
    const arrow = edge.arrow === "both" ? (dashed ? "<-.->" : "<-->") : body;
    const text = edge.label ? `|"${label(edge.label)}"|` : "";
    out.push(`  ${ids.get(edge.from)} ${arrow}${text} ${ids.get(edge.to)}`);
  }
  return out;
}

export function sequenceToMermaid(block: SlideSequenceBlock): string[] {
  const ids = idMap(block.participants.map((p) => p.id), "p");
  const text = (value: string) => value.replace(/[;#]/g, (c) => (c === ";" ? "," : "#35;")).replace(/\n/g, " ");
  const out = ["sequenceDiagram"];
  for (const p of block.participants) {
    out.push(`  ${p.shape === "actor" ? "actor" : "participant"} ${ids.get(p.id)} as ${text(p.label)}`);
  }
  for (const message of block.messages) {
    if ("note" in message) {
      out.push(`  Note over ${message.over.map((id) => ids.get(id)).join(",")}: ${text(message.note)}`);
    } else {
      out.push(`  ${ids.get(message.from)}${message.reply ? "-->>" : "->>"}${ids.get(message.to)}: ${text(message.label ?? "")}`);
    }
  }
  return out;
}
