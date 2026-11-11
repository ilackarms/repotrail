/**
 * Read-only GitHub REST calls used to import a tour from a pull request.
 * Pure of `vscode`: the caller supplies the token (from VS Code's GitHub
 * authentication) and, in tests, a fetch implementation. Requests go only to
 * api.github.com and only when the user asks to import a tour.
 */

import type { PrRef } from "./prRef";

export const GITHUB_API_ORIGIN = "https://api.github.com";

export interface GitHubComment {
  id: string;
  body: string;
  author: string;
  /** GitHub's author_association, e.g. OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE. */
  authorAssociation: string;
  createdAt: string;
  htmlUrl: string;
  /** API URL of the issue or pull request the comment belongs to. */
  issueUrl: string;
}

export interface GitHubPull {
  number: number;
  title: string;
  state: string;
  /** Login of the pull request's author. */
  author: string;
  headSha: string;
  baseSha: string;
  /** Canonical `owner/repo` of the base repository. */
  baseRepo: string;
  htmlUrl: string;
}

export interface GitHubClientOptions {
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Aborts in-flight requests, e.g. when the user cancels the progress notification. */
  signal?: AbortSignal;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly rateLimited = false,
  ) {
    super(message);
  }
}

const MAX_COMMENT_PAGES = 50;

export async function getPull(pr: PrRef, options: GitHubClientOptions): Promise<GitHubPull> {
  const raw = await getJson(`${repoPath(pr)}/pulls/${pr.number}`, options);
  const obj = asRecord(raw);
  const head = asRecord(obj.head);
  const base = asRecord(obj.base);
  const baseRepo = asRecord(base.repo);
  const user = asRecord(obj.user);
  if (typeof head.sha !== "string" || typeof base.sha !== "string") {
    throw new GitHubApiError("GitHub returned an unexpected pull request response.", 200);
  }
  return {
    number: typeof obj.number === "number" ? obj.number : pr.number,
    title: typeof obj.title === "string" ? obj.title : "",
    state: typeof obj.state === "string" ? obj.state : "",
    author: typeof user.login === "string" ? user.login : "",
    headSha: head.sha.toLowerCase(),
    baseSha: base.sha.toLowerCase(),
    baseRepo: typeof baseRepo.full_name === "string" ? baseRepo.full_name : `${pr.owner}/${pr.repo}`,
    htmlUrl: typeof obj.html_url === "string" ? obj.html_url : "",
  };
}

export async function getIssueComment(
  repo: { owner: string; repo: string },
  commentId: string,
  options: GitHubClientOptions,
): Promise<GitHubComment> {
  const raw = await getJson(`${repoPath(repo)}/issues/comments/${commentId}`, options);
  const comment = toComment(raw);
  if (!comment) throw new GitHubApiError("GitHub returned an unexpected comment response.", 200);
  return comment;
}

/** Every issue comment on the pull request, following `Link: rel="next"`. */
export async function listIssueComments(pr: PrRef, options: GitHubClientOptions): Promise<GitHubComment[]> {
  const comments: GitHubComment[] = [];
  let url: string | null = `${GITHUB_API_ORIGIN}${repoPath(pr)}/issues/${pr.number}/comments?per_page=100`;
  for (let page = 0; url && page < MAX_COMMENT_PAGES; page++) {
    if (options.signal?.aborted) throw new GitHubApiError("Cancelled.", 0);
    const res = await request(url, options);
    const raw = (await res.json()) as unknown;
    if (!Array.isArray(raw)) throw new GitHubApiError("GitHub returned an unexpected comments response.", res.status);
    for (const item of raw) {
      const comment = toComment(item);
      if (comment) comments.push(comment);
    }
    url = nextPageUrl(res.headers.get("link"));
  }
  return comments;
}

/** True when the comment's issue_url points at this pull request. */
export function commentBelongsTo(comment: GitHubComment, repoFullName: string, number: number): boolean {
  return comment.issueUrl.toLowerCase() === `${GITHUB_API_ORIGIN}/repos/${repoFullName}/issues/${number}`.toLowerCase();
}

/** Extract the next page from a Link header, only if it stays on api.github.com. */
export function nextPageUrl(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (!match) continue;
    try {
      const next = new URL(match[1]);
      return next.origin === GITHUB_API_ORIGIN ? next.toString() : null;
    } catch {
      return null;
    }
  }
  return null;
}

function repoPath(repo: { owner: string; repo: string }): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
}

async function getJson(path: string, options: GitHubClientOptions): Promise<unknown> {
  const res = await request(`${GITHUB_API_ORIGIN}${path}`, options);
  return (await res.json()) as unknown;
}

async function request(url: string, options: GitHubClientOptions): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "RepoTrail-VSCode",
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  // AbortSignal.any isn't in the Node that VS Code 1.85 ships, so combine by hand.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, signal: controller.signal });
  } catch (err) {
    if (options.signal?.aborted) throw new GitHubApiError("Cancelled.", 0);
    const detail = err instanceof Error ? err.message : String(err);
    throw new GitHubApiError(`Could not reach api.github.com: ${detail}`, 0);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
  if (res.ok) return res;
  const rateLimited =
    (res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0";
  let message = `GitHub answered ${res.status}`;
  try {
    const body = asRecord(await res.json());
    if (typeof body.message === "string") message += `: ${body.message}`;
  } catch {
    /* non-JSON error body */
  }
  throw new GitHubApiError(message, res.status, rateLimited);
}

function toComment(value: unknown): GitHubComment | null {
  const obj = asRecord(value);
  if (typeof obj.id !== "number" && typeof obj.id !== "string") return null;
  if (typeof obj.body !== "string" && obj.body !== null) return null;
  const user = asRecord(obj.user);
  return {
    id: String(obj.id),
    body: typeof obj.body === "string" ? obj.body : "",
    author: typeof user.login === "string" ? user.login : "unknown",
    authorAssociation: typeof obj.author_association === "string" ? obj.author_association : "NONE",
    createdAt: typeof obj.created_at === "string" ? obj.created_at : "",
    htmlUrl: typeof obj.html_url === "string" ? obj.html_url : "",
    issueUrl: typeof obj.issue_url === "string" ? obj.issue_url : "",
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
