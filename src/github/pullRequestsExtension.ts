/**
 * Pure helpers for handing PR comments to the GitHub Pull Requests extension
 * (GitHub.vscode-pull-request-github). RepoTrail never posts to GitHub; that
 * extension owns comments. It draws its comment gutter only on workspace
 * files of the pull request it has checked out ("review mode"), so RepoTrail
 * asks it which PR a folder has checked out and, on request, opens its
 * checkout link. No `vscode`, no network.
 */

import * as crypto from "node:crypto";
import { prHtmlUrl, PrRef, prRef } from "./prRef";

export const GITHUB_PULL_REQUESTS_EXTENSION_ID = "GitHub.vscode-pull-request-github";

/**
 * The part of the extension's exported API RepoTrail reads
 * (`getRepositoryDescription` in its published api.d.ts). `pullRequest` is
 * the PR checked out in the folder that holds the URI. `owner` and
 * `repositoryName` describe the folder's first GitHub remote, which for a fork
 * is the fork, so the PR's own `url` names it more reliably.
 */
export interface PullRequestsRepositoryDescription {
  owner?: unknown;
  repositoryName?: unknown;
  defaultBranch?: unknown;
  pullRequest?: { number?: unknown; url?: unknown } | null;
}

const PULL_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/([0-9]+)\/?$/i;

/** The PR a repository description says is checked out, if it names a valid one. */
export function checkedOutPr(description: PullRequestsRepositoryDescription | undefined | null): PrRef | undefined {
  const pull = description?.pullRequest;
  if (!pull) return undefined;
  const fromUrl = typeof pull.url === "string" ? PULL_URL.exec(pull.url.trim()) : null;
  try {
    if (fromUrl) return prRef(fromUrl[1], fromUrl[2], fromUrl[3]);
  } catch {
    /* fall through to the description's own repository */
  }
  const { owner, repositoryName } = description;
  if (typeof owner !== "string" || typeof repositoryName !== "string") return undefined;
  if (typeof pull.number !== "number" || !Number.isSafeInteger(pull.number)) return undefined;
  try {
    return prRef(owner, repositoryName, String(pull.number));
  } catch {
    return undefined;
  }
}

/** The repository's default branch from a description, when it is a plain branch name. */
export function defaultBranchOf(description: PullRequestsRepositoryDescription | undefined | null): string | undefined {
  const branch = description?.defaultBranch;
  if (typeof branch !== "string") return undefined;
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(branch) || branch.startsWith("-") || branch.includes("..")) return undefined;
  return branch;
}

/**
 * Whether `git branch -r --contains` output (one `<remote>/<branch>` per line)
 * includes the default branch on some remote: the commit is already merged.
 */
export function remoteBranchesInclude(output: string, branch: string): boolean {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line.includes("/") && line.slice(line.indexOf("/") + 1) === branch);
}

export function samePr(a: PrRef, b: PrRef): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase() && a.number === b.number;
}

/**
 * The extension's own "check out this PR" link
 * (`<scheme>://github.vscode-pull-request-github/checkout-pull-request?uri=...`),
 * the one github.com uses. `scheme` is vscode.env.uriScheme.
 */
export function pullRequestsCheckoutLink(scheme: string, pr: PrRef): string {
  return `${scheme}://${GITHUB_PULL_REQUESTS_EXTENSION_ID.toLowerCase()}/checkout-pull-request?uri=${encodeURIComponent(prHtmlUrl(pr))}`;
}

/**
 * The PR's "Files changed" page scrolled to one file, and to a line on its
 * new side when given. `repoPath` is relative to the repository root.
 */
export function prFileUrl(pr: PrRef, repoPath: string, line?: number): string {
  const file = repoPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const anchor = `diff-${crypto.createHash("sha256").update(file).digest("hex")}`;
  const lineAnchor = line !== undefined && Number.isSafeInteger(line) && line > 0 ? `R${line}` : "";
  return `${prHtmlUrl(pr)}/files#${anchor}${lineAnchor}`;
}
