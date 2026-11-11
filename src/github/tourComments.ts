/**
 * Find RepoTrail tours in GitHub comment markdown. Pure: no `vscode`, no
 * network. Only fenced `json` blocks whose top-level object carries a
 * `repoTrailTour` key count, and each must pass the normal tour parser. No
 * other part of a comment is used.
 */

import { parseTourJson } from "../engine/tourSerialize";
import type { TourPlan } from "../engine/types";

export interface FencedBlock {
  /** Lowercased first word of the info string, e.g. `json`. */
  language: string;
  content: string;
}

export interface FoundTour {
  plan: TourPlan;
  /** The fence's JSON text as written in the comment. */
  json: string;
  /** 1-based position among the comment's `json` fences. */
  jsonFenceIndex: number;
}

/**
 * CommonMark-style fenced code blocks: three or more backticks or tildes open
 * a block, and a line with at least as many of the same character closes it.
 * Indentation before a fence is tolerated so fences inside list items count.
 * An unclosed fence runs to the end of the text.
 */
export function fencedCodeBlocks(markdown: string): FencedBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: FencedBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!open) continue;
    const fence = open[1];
    const info = open[2].trim();
    if (fence[0] === "`" && info.includes("`")) continue;
    const content: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(lines[j]);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) break;
      content.push(lines[j]);
    }
    blocks.push({ language: (info.split(/\s+/)[0] ?? "").toLowerCase(), content: content.join("\n") });
    i = j;
  }
  return blocks;
}

/** Every tour in a comment body, in document order. */
export function findToursInMarkdown(markdown: string): FoundTour[] {
  const tours: FoundTour[] = [];
  let jsonFenceIndex = 0;
  for (const block of fencedCodeBlocks(markdown)) {
    if (block.language !== "json") continue;
    jsonFenceIndex++;
    if (!isTourEnvelope(block.content)) continue;
    const plan = parseTourJson(block.content);
    if (plan) tours.push({ plan, json: block.content, jsonFenceIndex });
  }
  return tours;
}

function isTourEnvelope(text: string): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return false;
  }
  return Boolean(raw && typeof raw === "object" && !Array.isArray(raw) && Object.hasOwn(raw, "repoTrailTour"));
}
