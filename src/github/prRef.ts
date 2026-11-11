/**
 * Strict parsing for GitHub pull request references and RepoTrail review
 * links. Pure: no `vscode`, no network. Review links arrive from untrusted
 * pages, so every accepted value must match a narrow pattern; anything else is
 * rejected with a user-facing message.
 */

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export interface PrImportRequest {
  pr: PrRef;
  /** Issue comment id holding the tour. Kept as a string; ids exceed 2^31. */
  commentId?: string;
  /** Lowercase 40-character commit SHA the link expects as the PR head. */
  head?: string;
}

/** `<publisher>.<name>` from package.json; the review link's authority. */
export const REPOTRAIL_EXTENSION_ID = "repotrail.repotrail";
/** Path of the review link: `<scheme>://repotrail.repotrail/review?...`. */
export const REVIEW_LINK_PATH = "/review";

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const NUMBER_PATTERN = /^[1-9][0-9]{0,9}$/;
const COMMENT_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const SHA_PATTERN = /^[0-9a-fA-F]{40}$/;
const MAX_PR_NUMBER = 2_147_483_647;

export function isValidOwner(value: string): boolean {
  return OWNER_PATTERN.test(value);
}

export function isValidRepoName(value: string): boolean {
  return REPO_PATTERN.test(value) && value !== "." && value !== ".." && !/\.git$/i.test(value);
}

export function isFullSha(value: string | undefined): value is string {
  return typeof value === "string" && SHA_PATTERN.test(value);
}

export function prRef(owner: string, repo: string, number: string): PrRef {
  if (!isValidOwner(owner)) throw new Error(`"${clip(owner)}" isn't a valid GitHub owner.`);
  if (!isValidRepoName(repo)) throw new Error(`"${clip(repo)}" isn't a valid GitHub repository name.`);
  return { owner, repo, number: parsePrNumber(number) };
}

export function parsePrNumber(value: string): number {
  const trimmed = value.trim().replace(/^#/, "");
  const parsed = NUMBER_PATTERN.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed > MAX_PR_NUMBER) {
    throw new Error(`"${clip(value)}" isn't a pull request number.`);
  }
  return parsed;
}

export function parseCommentId(value: string): string {
  if (!COMMENT_ID_PATTERN.test(value)) throw new Error(`"${clip(value)}" isn't a GitHub comment id.`);
  return value;
}

export function parseSha(value: string): string {
  if (!isFullSha(value)) throw new Error(`"${clip(value)}" isn't a 40-character commit SHA.`);
  return value.toLowerCase();
}

export function formatPrRef(pr: PrRef): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}

export function prHtmlUrl(pr: PrRef): string {
  return `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`;
}

export function sameRepo(a: { owner: string; repo: string }, b: { owner: string; repo: string }): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
}

/**
 * Parse what a user types into "Import Tour from GitHub PR":
 *   - `https://github.com/<owner>/<repo>/pull/<n>` (optional trailing slash)
 *   - the same URL with `#issuecomment-<id>`
 *   - `<owner>/<repo>#<n>`
 *   - a RepoTrail review link (`<scheme>://<publisher>.<name>/review?pr=...`)
 * Query strings on github.com URLs are ignored; nothing from them is used.
 */
export function parsePrInput(text: string): PrImportRequest {
  const input = text.trim();
  if (!input) throw new Error("Enter a pull request URL or owner/repo#number.");

  const shorthand = /^([^/\s#]+)\/([^/\s#]+)#(\S+)$/.exec(input);
  if (shorthand) return { pr: prRef(shorthand[1], shorthand[2], shorthand[3]) };

  const reviewLink = /^[a-z][a-z0-9+.-]*:\/\/repotrail\.repotrail(\/[^?#]*)\?([^#]*)$/i.exec(input);
  if (reviewLink && !/^https?:/i.test(input)) return parseReviewLink(reviewLink[1], reviewLink[2]);

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Enter a pull request URL like https://github.com/owner/repo/pull/123, or owner/repo#123.");
  }
  if (url.protocol !== "https:") throw new Error("Pull request URLs must use https://github.com.");
  if (url.hostname.toLowerCase() !== "github.com" || url.port || url.username || url.password) {
    throw new Error("Only pull requests on github.com are supported.");
  }
  const segments = url.pathname.replace(/\/$/, "").split("/").slice(1);
  if (segments.length !== 4 || segments[2] !== "pull") {
    throw new Error("Use a pull request URL of the form https://github.com/owner/repo/pull/123.");
  }
  const request: PrImportRequest = { pr: prRef(segments[0], segments[1], segments[3]) };
  if (url.hash) {
    const comment = /^#issuecomment-(\d+)$/.exec(url.hash);
    if (!comment) throw new Error("Only #issuecomment-… links are supported; copy the comment's link from its menu.");
    request.commentId = parseCommentId(comment[1]);
  }
  return request;
}

/**
 * Parse the path and query of a review link. The query is
 * `pr=<owner>/<repo>/<n>[&comment=<id>][&head=<sha>]`. Each known key may
 * appear once. Other keys are ignored because redirectors add their own (for
 * example vscode.dev/redirect appends `url=`); they are never read.
 */
export function parseReviewLink(path: string, query: string): PrImportRequest {
  if (path !== REVIEW_LINK_PATH) throw new Error(`Unknown RepoTrail link path "${clip(path)}".`);
  const params = new URLSearchParams(query);
  const one = (key: string): string | undefined => {
    const values = params.getAll(key);
    if (values.length > 1) throw new Error(`The link repeats "${key}".`);
    return values[0];
  };
  const pr = one("pr");
  if (!pr) throw new Error("The link has no pr=<owner>/<repo>/<number>.");
  const parts = pr.split("/");
  if (parts.length !== 3) throw new Error("The link's pr must be <owner>/<repo>/<number>.");
  const request: PrImportRequest = { pr: prRef(parts[0], parts[1], parts[2]) };
  const comment = one("comment");
  if (comment !== undefined) request.commentId = parseCommentId(comment);
  const head = one("head");
  if (head !== undefined) request.head = parseSha(head);
  return request;
}

/** Build the canonical review link. `scheme` is e.g. `vscode`. */
export function reviewLink(scheme: string, extensionId: string, request: PrImportRequest): string {
  const { pr } = request;
  let query = `pr=${pr.owner}/${pr.repo}/${pr.number}`;
  if (request.commentId) query += `&comment=${request.commentId}`;
  if (request.head) query += `&head=${request.head.toLowerCase()}`;
  return `${scheme}://${extensionId.toLowerCase()}${REVIEW_LINK_PATH}?${query}`;
}

/**
 * GitHub strips `vscode://` hrefs from comments; vscode.dev/redirect answers
 * with a 302 to the `vscode:` or `vscode-insiders:` URL, so this https link
 * stays clickable and opens the desktop app.
 */
export function vscodeDevRedirect(link: string): string {
  return `https://vscode.dev/redirect?url=${encodeURIComponent(link)}`;
}

function clip(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}
