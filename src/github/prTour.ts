/**
 * Pure helpers for PR tours: the refs a tour needs, staleness, the agent setup
 * prompt, and the markdown for a PR comment. No `vscode`, no network.
 */

import { planToJson, slugForFilename } from "../engine/tourSerialize";
import type { TourPlan, TourRootRef } from "../engine/types";
import { formatPrRef, isFullSha, PrImportRequest, prHtmlUrl, PrRef, reviewLink, vscodeDevRedirect } from "./prRef";

/** GitHub rejects comment bodies longer than this many characters. */
export const GITHUB_COMMENT_LIMIT = 65_536;

export const MARKETPLACE_URL = "https://marketplace.visualstudio.com/items?itemName=repotrail.repotrail";

/** Distinct `diff.baseRef` / `diff.headRef` values, base refs first. */
export function diffRefs(plan: TourPlan): string[] {
  const refs = new Set<string>();
  for (const step of plan.steps) if (step.diff?.baseRef) refs.add(step.diff.baseRef);
  for (const step of plan.steps) if (step.diff?.headRef) refs.add(step.diff.headRef);
  return [...refs];
}

export function baseRefs(plan: TourPlan): string[] {
  return [...new Set(plan.steps.flatMap((step) => (step.diff?.baseRef ? [step.diff.baseRef] : [])))];
}

/**
 * The headRef every diff stop shares, if there is exactly one and no diff stop
 * compares against the working tree instead. Code-only stops are ignored:
 * they show the checked-out file and pin no commit.
 */
export function sharedHeadRef(plan: TourPlan): string | undefined {
  const diffSteps = plan.steps.filter((step) => step.diff);
  if (diffSteps.length === 0) return undefined;
  const heads = new Set(diffSteps.map((step) => step.diff?.headRef?.toLowerCase() ?? ""));
  if (heads.size !== 1 || heads.has("")) return undefined;
  return diffSteps[0].diff?.headRef;
}

/**
 * Warn when the tour was written for a different commit than the link expects
 * or the PR's current head. Returns null when it matches or can't be compared.
 */
export function staleHeadMessage(
  plan: TourPlan,
  heads: { expected?: string; current?: string },
): string | null {
  const tourHead = sharedHeadRef(plan);
  if (!tourHead || !/^[0-9a-f]{7,40}$/i.test(tourHead)) return null;
  const differs = (sha?: string) => Boolean(sha && !sameCommit(tourHead, sha));
  if (differs(heads.expected)) {
    return `This tour was written for commit ${short(tourHead)}, but the link expects ${short(heads.expected!)}. Stops show ${short(tourHead)}.`;
  }
  if (differs(heads.current)) {
    return `This tour was written for commit ${short(tourHead)}; the PR head is now ${short(heads.current!)}. Stops show the older commit.`;
  }
  return null;
}

function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

export function short(sha: string): string {
  return /^[0-9a-f]{8,}$/i.test(sha) ? sha.slice(0, 7) : sha;
}

/**
 * Copy of a plan that is safe to post: drops absolute root paths and the
 * workspace folder identities RepoTrail pins in multi-root windows, which can
 * be local paths. Root aliases keep their portable name/pathHint.
 */
export function portablePlan(plan: TourPlan): TourPlan {
  const looksAbsolute = (value: string) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
  let roots: Record<string, TourRootRef> | undefined;
  if (plan.roots) {
    roots = {};
    for (const [alias, ref] of Object.entries(plan.roots)) {
      const next: TourRootRef = {};
      if (ref.name) next.name = ref.name;
      if (ref.pathHint && !looksAbsolute(ref.pathHint)) next.pathHint = ref.pathHint;
      if (ref.workspaceFolder && !looksAbsolute(ref.workspaceFolder)) next.workspaceFolder = ref.workspaceFolder;
      if (!next.name && !next.pathHint && !next.workspaceFolder) next.pathHint = alias;
      roots[alias] = next;
    }
  }
  const steps = plan.steps.map((step) => {
    const copy = { ...step };
    if (copy.root || (copy.workspaceFolder && looksAbsolute(copy.workspaceFolder))) delete copy.workspaceFolder;
    delete (copy as { actions?: unknown }).actions;
    return copy;
  });
  const out: TourPlan = { ...plan, steps };
  if (roots) out.roots = roots;
  return out;
}

/** Folder name for a review checkout: the tour's single root hint, or `<repo>-pr-<n>`. */
export function reviewFolderName(plan: TourPlan, pr: PrRef): string {
  const refs = Object.values(plan.roots ?? {});
  if (refs.length === 1) {
    const hint = (refs[0].pathHint ?? refs[0].name ?? "").replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
    if (/^[A-Za-z0-9._-]{1,80}$/.test(hint) && hint !== "." && hint !== "..") return hint;
  }
  return `${pr.repo}-pr-${pr.number}`;
}

export interface SetupPromptInput {
  pr: PrRef;
  plan: TourPlan;
  /** Commit to check out; FETCH_HEAD when unknown. */
  headSha?: string;
  /** Where the tour lives: a known comment, or a marker in an unposted one. */
  source: { commentId: string; commentUrl?: string; jsonFenceIndex: number } | { marker: string };
}

/**
 * Agent prompt that checks out the PR into a temporary directory, saves the
 * tour into `.repotrail/`, and opens VS Code. For reviewers without a matching
 * clone, or without the extension.
 */
export function composeSetupPrompt(input: SetupPromptInput): string {
  const { pr, plan } = input;
  const repo = `${pr.owner}/${pr.repo}`;
  const folder = reviewFolderName(plan, pr);
  const file = `${slugForFilename(plan.title)}.json`;
  const commit = input.headSha && isFullSha(input.headSha) ? input.headSha.toLowerCase() : undefined;
  const target = commit ?? "FETCH_HEAD";
  const bases = baseRefs(plan).filter((ref) => isFullSha(ref));
  const fenceNumber = "commentId" in input.source ? input.source.jsonFenceIndex : 1;
  const awk = fenceNumber === 1
    ? `awk '{sub(/\\r$/, "")} /^\`\`\`json$/ {on=1; next} /^\`\`\`$/ {if (on) exit} on'`
    : `awk '{sub(/\\r$/, "")} /^\`\`\`json$/ {n++; if (n == ${fenceNumber}) {on=1; next}} /^\`\`\`$/ {if (on) exit} on'`;
  const fetchComment = "commentId" in input.source
    ? `gh api repos/${repo}/issues/comments/${input.source.commentId} --jq .body`
    : `gh api repos/${repo}/issues/${pr.number}/comments --paginate \\\n         --jq '.[] | select(.body | contains("${input.source.marker}")) | .body'`;
  const commentLabel = "commentId" in input.source
    ? `the PR comment ${input.source.commentUrl || input.source.commentId}`
    : `the PR comment that contains "${input.source.marker}"`;

  const lines = [
    `Set up a local review workspace for ${prHtmlUrl(pr)} so I can open its RepoTrail tour.`,
    "Don't change, reset or switch branches in any checkout I already have.",
    "",
    "1. Create a new temporary directory (mktemp -d) and call it DIR.",
    `2. Check out the PR at ${commit ? `commit ${commit}` : "its current head"} into DIR/${folder}, with full history:`,
    `   - If I already have a clone of ${repo}, run in it (use the remote that points at ${repo} in place of origin):`,
    `       git fetch origin pull/${pr.number}/head`,
    `       git worktree add --detach DIR/${folder} ${target}`,
    "   - Otherwise:",
    `       git clone https://github.com/${repo}.git DIR/${folder}`,
    `       git -C DIR/${folder} fetch origin pull/${pr.number}/head`,
    `       git -C DIR/${folder} checkout --detach ${target}`,
  ];
  if (bases.length > 0) {
    lines.push(`   Then check that the diff base${bases.length > 1 ? "s exist" : " exists"}:`);
    for (const base of bases) lines.push(`       git -C DIR/${folder} cat-file -e ${base}^{commit}`);
  }
  lines.push(
    `3. Save the tour file from ${commentLabel}:`,
    `       mkdir -p DIR/${folder}/.repotrail`,
    `       ${fetchComment} \\`,
    `         | ${awk} \\`,
    `         > DIR/${folder}/.repotrail/${file}`,
    `   Check that it parses as JSON and has ${plan.steps.length} entries under plan.steps. Don't commit it.`,
    `4. Write DIR/${folder}.code-workspace containing:`,
    `       {"folders": [{"name": "${folder}", "path": "${folder}"}]}`,
    "5. If the RepoTrail extension isn't installed (code --list-extensions), install it:",
    "       code --install-extension repotrail.repotrail",
    `6. Open the workspace: code DIR/${folder}.code-workspace`,
    "   Tell me DIR, so I can delete it when I'm done (and, if you used a worktree, run git worktree remove on it).",
  );
  return lines.join("\n");
}

export interface PrCommentInput {
  plan: TourPlan;
  pr: PrRef;
  exportedAt: string;
  extensionId: string;
}

export type PrCommentResult =
  | { ok: true; body: string; link: string; compactJson: boolean }
  | { ok: false; length: number };

/** Hidden marker that lets the setup prompt find the comment before it has an id. */
export function tourCommentMarker(plan: TourPlan): string {
  return `<!-- repotrail-tour:${slugForFilename(plan.title)} -->`;
}

/**
 * Markdown for a PR comment: a one-line intro, the review link (https
 * redirect plus the raw link for the terminal), a collapsed agent setup prompt,
 * and a collapsed `json` block with the tour. Falls back to compact JSON when
 * the pretty body is over GitHub's limit.
 */
export function composePrComment(input: PrCommentInput): PrCommentResult {
  const plan = portablePlan(input.plan);
  const head = sharedHeadRef(plan);
  const request: PrImportRequest = { pr: input.pr };
  if (isFullSha(head)) request.head = head.toLowerCase();
  const link = reviewLink("vscode", input.extensionId, request);
  const marker = tourCommentMarker(plan);
  const prompt = composeSetupPrompt({ pr: input.pr, plan, headSha: request.head, source: { marker } });
  const file = `${slugForFilename(plan.title)}.json`;
  const stops = `${plan.steps.length} stop${plan.steps.length === 1 ? "" : "s"}`;

  const build = (json: string) =>
    [
      marker,
      `**RepoTrail review tour for ${formatPrRef(input.pr)}:** ${escapeInline(plan.title)} (${stops}).`,
      "",
      `[Open it in VS Code](${vscodeDevRedirect(link)}) with the [RepoTrail extension](${MARKETPLACE_URL}) and any clone of this repo. If the link doesn't open VS Code, run \`code --open-url '${link}'\`.`,
      "",
      "<details>",
      "<summary>No RepoTrail or no clone? Prompt for your coding agent</summary>",
      "",
      "```text",
      prompt,
      "```",
      "",
      "</details>",
      "",
      "<details>",
      `<summary>Tour file: ${file}</summary>`,
      "",
      "```json",
      json,
      "```",
      "",
      "</details>",
      "",
    ].join("\n");

  const pretty = build(planToJson(plan, input.exportedAt));
  if (pretty.length <= GITHUB_COMMENT_LIMIT) return { ok: true, body: pretty, link, compactJson: false };
  const compactJson = JSON.stringify(JSON.parse(planToJson(plan, input.exportedAt)));
  const compact = build(compactJson);
  if (compact.length <= GITHUB_COMMENT_LIMIT) return { ok: true, body: compact, link, compactJson: true };
  return { ok: false, length: compact.length };
}

function escapeInline(text: string): string {
  return text.replace(/[\\`*_[\]<>|]/g, (ch) => `\\${ch}`).replace(/\s+/g, " ").trim();
}
