import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { slugForFilename } from "../engine/tourSerialize";
import type { TourPlan } from "../engine/types";
import { fetchPullRequest, hasCommit, listRemotes, mergeBase, pullRequestFetchArgs } from "../gitRepo";
import {
  commentBelongsTo,
  getIssueComment,
  getPull,
  GitHubApiError,
  GitHubComment,
  GitHubPull,
  listIssueComments,
} from "../github/api";
import {
  formatPrRef,
  isFullSha,
  parsePrInput,
  parsePrNumber,
  parseReviewLink,
  PrImportRequest,
  prHtmlUrl,
  PrRef,
  sameRepo,
} from "../github/prRef";
import {
  awkFenceIndexFor,
  composePrComment,
  composeSetupPrompt,
  diffRefs,
  GITHUB_COMMENT_LIMIT,
  isTrustedPoster,
  posterRole,
  rankTourCandidates,
  sharedHeadRef,
  short,
  TourCandidateInfo,
  tourRefWarnings,
} from "../github/prTour";
import { parseGitHubRemote } from "../github/remotes";
import { findToursInMarkdown, FoundTour } from "../github/tourComments";
import { listRepoTours, readRepoTour, REPO_TOURS_DIR } from "../storage/repoTours";
import { currentWorkspaceFolders, workspaceFolderInfos } from "../workspace";
import { plainMessageText } from "./messageText";
import type { TourController } from "./tourController";

/**
 * Import a RepoTrail tour posted in a GitHub pull request comment. Every entry
 * point (the review link, "Import Tour from GitHub PR", "Find Tours on a PR")
 * goes through importTourFromPr. Network and git work happens only here, only
 * after a user action, and the git fetch always asks first.
 */

export interface PrImportContext {
  controller: TourController;
  log: vscode.OutputChannel;
  globalState: vscode.Memento;
  extensionId: string;
}

interface ImportOptions {
  /** Review links come from untrusted pages and need a confirmation first. */
  fromLink?: boolean;
  /** Folder to use when it is one of the matching clones. */
  preferredFolder?: string;
}

interface Candidate extends TourCandidateInfo {
  tour: FoundTour;
  comment: GitHubComment;
}

interface CloneFolder {
  folder: vscode.WorkspaceFolder;
  remote: string;
}

class Cancelled extends Error {}

const PENDING_IMPORT_KEY = "repoTrail.pendingPrImport";
const PENDING_IMPORT_TTL_MS = 15 * 60 * 1000;
/** Imports check and fetch at most this many distinct commits. */
const MAX_IMPORT_COMMITS = 64;
const SIGN_IN = "Sign in to GitHub";

export async function handleReviewUri(uri: vscode.Uri, ctx: PrImportContext): Promise<void> {
  let request: PrImportRequest;
  try {
    request = parseReviewLink(uri.path, uri.query);
  } catch (err) {
    ctx.log.appendLine(`[pr-import] rejected link ${uri.toString(true)}: ${message(err)}`);
    vscode.window.showErrorMessage(`RepoTrail: ignored an invalid review link. ${plainMessageText(message(err))}`);
    return;
  }
  await importTourFromPr(request, ctx, { fromLink: true });
}

/** "RepoTrail: Import Tour from GitHub PR". */
export async function importTourFromPrCommand(ctx: PrImportContext): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: "Import RepoTrail tour from a GitHub pull request",
    prompt: "Pull request or comment URL, or owner/repo#number",
    placeHolder: "https://github.com/owner/repo/pull/123#issuecomment-456",
    ignoreFocusOut: true,
    validateInput: (input) => (input.trim() ? validationMessage(() => parsePrInput(input)) : null),
  });
  if (!value?.trim()) return;
  await importTourFromPr(parsePrInput(value), ctx);
}

/** "RepoTrail: Find Tours on a PR": repo from the open folder's remote, number from the user. */
export async function findToursOnPrCommand(ctx: PrImportContext): Promise<void> {
  const repos = await openGitHubRepos();
  if (repos.length === 0) {
    vscode.window.showErrorMessage(
      "RepoTrail: no open folder has a github.com remote. Use “RepoTrail: Import Tour from GitHub PR” with a PR URL instead.",
    );
    return;
  }
  const chosen = repos.length === 1
    ? repos[0]
    : (await vscode.window.showQuickPick(
        repos.map((repo) => ({
          label: `${repo.owner}/${repo.repo}`,
          description: `${repo.folder.name} (${repo.remote})`,
          repo,
        })),
        { title: "Find RepoTrail tours on a PR", placeHolder: "Repository" },
      ))?.repo;
  if (!chosen) return;
  const value = await vscode.window.showInputBox({
    title: `Find RepoTrail tours on a pull request in ${chosen.owner}/${chosen.repo}`,
    prompt: "Pull request number",
    placeHolder: "123",
    ignoreFocusOut: true,
    validateInput: (input) => (input.trim() ? validationMessage(() => parsePrNumber(input)) : null),
  });
  if (!value?.trim()) return;
  const pr: PrRef = { owner: chosen.owner, repo: chosen.repo, number: parsePrNumber(value) };
  await importTourFromPr({ pr }, ctx, { preferredFolder: chosen.folder.uri.fsPath });
}

export async function importTourFromPr(
  request: PrImportRequest,
  ctx: PrImportContext,
  options: ImportOptions = {},
): Promise<void> {
  const { pr } = request;
  const label = formatPrRef(pr);
  try {
    if (options.fromLink && !(await confirmLink(request))) return;
    ctx.log.appendLine(
      `[pr-import] ${label}${request.commentId ? ` comment ${request.commentId}` : ""}${request.head ? ` head ${request.head}` : ""}`,
    );

    const { pull, comments } = await withGitHub(label, (token) =>
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `RepoTrail: reading ${label} from GitHub…`,
          cancellable: true,
        },
        (_progress, cancel) => {
          const abort = new AbortController();
          const sub = cancel.onCancellationRequested(() => abort.abort());
          return fetchPullAndComments(request, token, abort.signal).finally(() => sub.dispose());
        },
      ),
    );

    const found: Candidate[] = comments.flatMap((comment) =>
      findToursInMarkdown(comment.body).map((tour) => ({
        tour,
        comment,
        plan: tour.plan,
        author: comment.author,
        authorAssociation: comment.authorAssociation,
        createdAt: comment.createdAt,
      })),
    );
    ctx.log.appendLine(`[pr-import] ${comments.length} comment(s), ${found.length} tour(s)`);
    if (found.length === 0) {
      vscode.window.showInformationMessage(
        request.commentId
          ? `RepoTrail: comment ${request.commentId} on ${label} has no RepoTrail tour (a fenced json block with "repoTrailTour").`
          : `RepoTrail: no comment on ${label} has a RepoTrail tour (a fenced json block with "repoTrailTour").`,
      );
      return;
    }
    const candidates = rankTourCandidates(found, { prAuthor: pull.author, linkHead: request.head });
    const picked = await pickCandidate(candidates, label, pull.author);
    if (!picked) return;
    if (!(await confirmPoster(picked, pull, label))) return;
    const plan = picked.tour.plan;

    const clone = await pickCloneFolder(request, pull, options.preferredFolder);
    if (!clone) {
      await offerNoCloneActions(request, pull, picked, ctx);
      return;
    }
    ctx.log.appendLine(
      `[pr-import] using ${clone.folder.uri.fsPath} (remote ${clone.remote}); tour by ${picked.author} (${picked.authorAssociation})`,
    );

    await ensureCommits(plan, pr, clone, ctx);
    const base = await mergeBase(clone.folder.uri.fsPath, pull.baseSha, pull.headSha);

    await ctx.controller.loadPlan(plan, undefined, undefined, { importFolder: clone.folder.uri.fsPath, pullRequest: pr });
    await vscode.commands.executeCommand("repoTrail.tour.focus").then(undefined, () => {});
    ctx.log.appendLine(`[pr-import] loaded "${plan.title}" (${plan.steps.length} stops)`);

    const warnings = tourRefWarnings(plan, { prHead: pull.headSha, mergeBase: base, linkHead: request.head });
    if (warnings.length > 0) {
      ctx.log.appendLine(`[pr-import] ${warnings.join(" ")}`);
      void vscode.window.showWarningMessage(`RepoTrail: ${plainMessageText(warnings.join(" "), 600)}`);
    }
    void offerSave(picked, plan, clone.folder, label, ctx);
  } catch (err) {
    if (err instanceof Cancelled) return;
    ctx.log.appendLine(`[pr-import] failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    vscode.window.showErrorMessage(`RepoTrail: couldn't import a tour from ${label}. ${plainMessageText(message(err))}`);
  }
}

/** Resume an import whose "Open Folder…" reopened the window on the chosen folder. */
export async function resumePendingPrImport(ctx: PrImportContext): Promise<void> {
  const pending = ctx.globalState.get<{ request: PrImportRequest; folder: string; at: number }>(PENDING_IMPORT_KEY);
  if (!pending) return;
  const folder = currentWorkspaceFolders().find((f) => samePath(f.uri.fsPath, pending.folder));
  if (Date.now() - pending.at > PENDING_IMPORT_TTL_MS) {
    await ctx.globalState.update(PENDING_IMPORT_KEY, undefined);
    return;
  }
  if (!folder) return;
  await ctx.globalState.update(PENDING_IMPORT_KEY, undefined);
  let request: PrImportRequest;
  try {
    // Re-validate: global state is ours, but keep the same strict shapes.
    const { pr, commentId, head } = pending.request;
    request = parseReviewLink(
      "/review",
      `pr=${pr.owner}/${pr.repo}/${pr.number}${commentId ? `&comment=${commentId}` : ""}${head ? `&head=${head}` : ""}`,
    );
  } catch {
    return;
  }
  const pick = await vscode.window.showInformationMessage(
    `RepoTrail: continue opening the tour from ${formatPrRef(request.pr)} in ${folder.name}?`,
    "Open Tour",
  );
  if (pick === "Open Tour") await importTourFromPr(request, ctx, { preferredFolder: folder.uri.fsPath });
}

/** "RepoTrail: Copy Tour as PR Comment". Copies markdown only; never posts. */
export async function copyTourAsPrComment(ctx: PrImportContext): Promise<void> {
  const choice = await pickTourToShare(ctx);
  if (!choice) return;
  const { plan, rootPath } = choice;

  const repo = rootPath ? (await githubReposForFolder(rootPath))[0] : (await openGitHubRepos())[0];
  const value = await vscode.window.showInputBox({
    title: `Copy "${plan.title}" as a PR comment`,
    prompt: "Pull request: owner/repo#number or a PR URL",
    value: repo ? `${repo.owner}/${repo.repo}#` : "",
    valueSelection: repo ? [repo.owner.length + repo.repo.length + 2, repo.owner.length + repo.repo.length + 2] : undefined,
    ignoreFocusOut: true,
    validateInput: (input) => (input.trim() ? validationMessage(() => parsePrInput(input)) : null),
  });
  if (!value?.trim()) return;
  const { pr } = parsePrInput(value);

  const result = composePrComment({
    plan,
    pr,
    exportedAt: new Date().toISOString(),
    extensionId: ctx.extensionId,
  });
  if (!result.ok) {
    vscode.window.showErrorMessage(
      `RepoTrail: this tour makes a ${result.length.toLocaleString("en-US")}-character comment; GitHub allows ${GITHUB_COMMENT_LIMIT.toLocaleString("en-US")}. Shorten the narration or split the tour.`,
    );
    return;
  }
  await vscode.env.clipboard.writeText(result.body);
  ctx.log.appendLine(`[pr-comment] copied ${result.body.length} characters for ${formatPrRef(pr)}; link ${result.link}`);
  const notes = [
    `RepoTrail: PR comment copied (${result.body.length.toLocaleString("en-US")} characters). Paste it into a comment on ${formatPrRef(pr)}.`,
  ];
  if (result.compactJson) notes.push("The tour JSON is compacted to fit GitHub's limit.");
  if (!sharedHeadRef(plan)) notes.push("The link has no head SHA because the diff stops don't share one headRef.");
  const pick = await vscode.window.showInformationMessage(notes.join(" "), "Open PR");
  if (pick === "Open PR") await vscode.env.openExternal(vscode.Uri.parse(prHtmlUrl(pr)));
}

async function confirmLink(request: PrImportRequest): Promise<boolean> {
  const { pr } = request;
  const lines = [
    `Repository: ${pr.owner}/${pr.repo}`,
    `Pull request: #${pr.number}`,
    `Comment: ${request.commentId ?? "any comment on the pull request"}`,
  ];
  if (request.head) lines.push(`Expected head: ${request.head}`);
  lines.push(
    "",
    "RepoTrail will read this pull request's comments from api.github.com and load the tour JSON it finds. Nothing in the comment is run, and tour file paths stay inside the folder you pick. Fetching missing commits asks separately.",
  );
  const detail = lines.join("\n");
  const pick = await vscode.window.showInformationMessage(
    "Open a RepoTrail tour from GitHub?",
    { modal: true, detail },
    "Continue",
  );
  return pick === "Continue";
}

async function fetchPullAndComments(
  request: PrImportRequest,
  token: string | undefined,
  signal: AbortSignal,
): Promise<{ pull: GitHubPull; comments: GitHubComment[] }> {
  const options = { token, signal };
  try {
    return await fetchPullAndCommentsWith(request, options);
  } catch (err) {
    if (signal.aborted) throw new Cancelled();
    throw err;
  }
}

async function fetchPullAndCommentsWith(
  request: PrImportRequest,
  options: { token: string | undefined; signal: AbortSignal },
): Promise<{ pull: GitHubPull; comments: GitHubComment[] }> {
  const pull = await getPull(request.pr, options);
  const [owner, repo] = pull.baseRepo.split("/");
  const canonical = owner && repo ? { owner, repo } : request.pr;
  if (!request.commentId) {
    return { pull, comments: await listIssueComments({ ...canonical, number: request.pr.number }, options) };
  }
  const comment = await getIssueComment(canonical, request.commentId, options);
  if (!commentBelongsTo(comment, `${canonical.owner}/${canonical.repo}`, request.pr.number)) {
    throw new Error(`Comment ${request.commentId} isn't on ${formatPrRef(request.pr)}.`);
  }
  return { pull, comments: [comment] };
}

/**
 * Run a GitHub read with the existing GitHub session if there is one. Without
 * a session, try anonymously; on 401/404 or an exhausted anonymous rate limit,
 * offer to sign in and retry once.
 */
async function withGitHub<T>(label: string, run: (token: string | undefined) => Thenable<T>): Promise<T> {
  let session: vscode.AuthenticationSession | undefined;
  try {
    session = await vscode.authentication.getSession("github", ["repo"], { createIfNone: false, silent: true });
  } catch {
    session = undefined;
  }
  try {
    return await run(session?.accessToken);
  } catch (err) {
    if (session || !(err instanceof GitHubApiError)) throw err;
    if (err.status !== 401 && err.status !== 404 && !err.rateLimited) throw err;
    const reason = err.rateLimited
      ? "GitHub's anonymous rate limit is used up."
      : `GitHub didn't find ${label} without signing in; it may be private.`;
    const pick = await vscode.window.showWarningMessage(`RepoTrail: ${reason}`, SIGN_IN);
    if (pick !== SIGN_IN) throw new Cancelled();
    const signedIn = await vscode.authentication.getSession("github", ["repo"], { createIfNone: true });
    return run(signedIn.accessToken);
  }
}

async function pickCandidate(candidates: Candidate[], label: string, prAuthor: string): Promise<Candidate | undefined> {
  if (candidates.length === 1) return candidates[0];
  const items = candidates.map((candidate) => ({
    label: candidate.plan.title,
    description: `@${candidate.author} (${posterRole(candidate, prAuthor)}) · ${formatDate(candidate.createdAt)}`,
    detail: `${candidate.plan.steps.length} stops · comment ${candidate.comment.id}`,
    candidate,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    title: `RepoTrail tours on ${label}`,
    placeHolder: "Choose a tour (the PR author's and collaborators' tours are listed first)",
    matchOnDescription: true,
  });
  return pick?.candidate;
}

/**
 * Anyone can comment on a public pull request. Ask before loading a tour from
 * someone who is neither the PR's author nor a collaborator.
 */
async function confirmPoster(picked: Candidate, pull: GitHubPull, label: string): Promise<boolean> {
  if (isTrustedPoster(picked, pull.author)) return true;
  const pick = await vscode.window.showWarningMessage(
    `Open a tour posted by @${picked.author}?`,
    {
      modal: true,
      detail: [
        `@${picked.author} isn't the author of ${label} or a collaborator on the repository.`,
        "",
        "Anyone can comment on a public pull request. A tour's stops show whichever commits it names, which may not be this pull request's changes.",
      ].join("\n"),
    },
    "Open Tour",
  );
  return pick === "Open Tour";
}

async function pickCloneFolder(
  request: PrImportRequest,
  pull: GitHubPull,
  preferredFolder?: string,
): Promise<CloneFolder | null> {
  const [baseOwner, baseRepo] = pull.baseRepo.split("/");
  const targets = [request.pr, ...(baseOwner && baseRepo ? [{ owner: baseOwner, repo: baseRepo }] : [])];
  const matches: CloneFolder[] = [];
  for (const folder of currentWorkspaceFolders()) {
    const remotes = await listRemotes(folder.uri.fsPath);
    const remote = remotes.find((r) => {
      const parsed = parseGitHubRemote(r.url);
      return parsed && targets.some((target) => sameRepo(parsed, target));
    });
    if (remote) matches.push({ folder, remote: remote.name });
  }
  if (matches.length === 0) return null;
  const preferred = preferredFolder && matches.find((m) => samePath(m.folder.uri.fsPath, preferredFolder));
  if (preferred) return preferred;
  if (matches.length === 1) return matches[0];
  const pick = await vscode.window.showQuickPick(
    matches.map((match) => ({
      label: match.folder.name,
      description: `${match.remote} · ${match.folder.uri.fsPath}`,
      match,
    })),
    { title: `Open the tour in which clone of ${request.pr.owner}/${request.pr.repo}?`, placeHolder: "Folder" },
  );
  if (!pick) throw new Cancelled();
  return pick.match;
}

async function offerNoCloneActions(
  request: PrImportRequest,
  pull: GitHubPull,
  picked: Candidate,
  ctx: PrImportContext,
): Promise<void> {
  const { pr } = request;
  const tourHead = sharedHeadRef(picked.tour.plan);
  const pick = await vscode.window.showWarningMessage(
    `RepoTrail: no open folder is a clone of ${pr.owner}/${pr.repo}. Open one, or copy a prompt that has your coding agent check out the PR and open the tour.`,
    "Copy setup prompt",
    "Open Folder…",
  );
  if (pick === "Copy setup prompt") {
    const prompt = composeSetupPrompt({
      pr,
      plan: picked.tour.plan,
      headSha: isFullSha(tourHead) ? tourHead : pull.headSha,
      source: setupSource(picked),
    });
    await vscode.env.clipboard.writeText(prompt);
    ctx.log.appendLine(`[pr-import] copied setup prompt for ${formatPrRef(pr)}`);
    const show = await vscode.window.showInformationMessage(
      "RepoTrail: setup prompt copied. Paste it into your coding agent.",
      "Show Prompt",
    );
    if (show === "Show Prompt") {
      const doc = await vscode.workspace.openTextDocument({ content: prompt, language: "markdown" });
      await vscode.window.showTextDocument(doc, { preview: true });
    }
    return;
  }
  if (pick === "Open Folder…") {
    const folders = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Open Clone",
      title: `Open a clone of ${pr.owner}/${pr.repo}`,
    });
    if (!folders?.[0]) return;
    await ctx.globalState.update(PENDING_IMPORT_KEY, { request, folder: folders[0].fsPath, at: Date.now() });
    await vscode.commands.executeCommand("vscode.openFolder", folders[0]);
  }
}

/** Point the setup prompt at the comment if awk can extract the tour from it, else embed the JSON. */
function setupSource(picked: Candidate) {
  const commentUrl = picked.comment.htmlUrl;
  const awkFenceIndex = awkFenceIndexFor(picked.comment.body, picked.tour.json);
  return awkFenceIndex
    ? { commentId: picked.comment.id, commentUrl, awkFenceIndex }
    : { commentId: picked.comment.id, commentUrl, json: picked.tour.json };
}

/**
 * Check the tour's commit SHAs with `git cat-file -e`. If any are missing, ask,
 * then fetch `pull/<n>/head` and, one at a time, any SHA still missing. Fetch
 * failures are reported and the tour still loads; cancelling stops the import.
 * Refs that aren't full SHAs are never checked or fetched here; the ref
 * warnings after loading call them out.
 */
async function ensureCommits(plan: TourPlan, pr: PrRef, clone: CloneFolder, ctx: PrImportContext): Promise<void> {
  const folder = clone.folder.uri.fsPath;
  const shas = [...new Set(diffRefs(plan).filter((ref) => isFullSha(ref)).map((ref) => ref.toLowerCase()))];
  if (shas.length === 0) return;
  if (shas.length > MAX_IMPORT_COMMITS) {
    ctx.log.appendLine(`[pr-import] ${shas.length} distinct commits; checking none`);
    void vscode.window.showWarningMessage(
      `RepoTrail: this tour names ${shas.length} different commits, more than the ${MAX_IMPORT_COMMITS} RepoTrail checks or fetches. Stops whose commits are missing won't open.`,
    );
    return;
  }
  const missingShas = (token?: vscode.CancellationToken) => findMissing(folder, shas, token);
  let missing = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "RepoTrail: checking the tour's commits…", cancellable: true },
    (_progress, token) => missingShas(token),
  );
  if (missing.length === 0) return;
  ctx.log.appendLine(`[pr-import] missing commits: ${missing.join(", ")}`);

  const command = `git ${pullRequestFetchArgs(clone.remote, pr.number).join(" ")}`;
  const pick = await vscode.window.showWarningMessage(
    `Fetch ${formatPrRef(pr)} into ${clone.folder.name}?`,
    {
      modal: true,
      detail: [
        `The tour needs commits that aren't in this clone: ${missing.map(short).join(", ")}.`,
        "",
        `RepoTrail will run:\n${command}`,
        `and then fetch, from ${clone.remote}, any of those commits that is still missing.`,
        "",
        "This downloads objects and updates FETCH_HEAD. It doesn't create branches or change your checkout.",
      ].join("\n"),
    },
    "Fetch",
  );
  if (pick !== "Fetch") {
    void vscode.window.showWarningMessage(
      `RepoTrail: ${missing.length} commit(s) the tour needs aren't in ${clone.folder.name}; those diff stops won't open.`,
    );
    return;
  }

  const failures: string[] = [];
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `RepoTrail: ${command}`, cancellable: true },
    async (_progress, token) => {
      const controller = new AbortController();
      const sub = token.onCancellationRequested(() => controller.abort());
      const attempt = async (shasToFetch?: string[]) => {
        try {
          await fetchPullRequest(folder, clone.remote, pr.number, { shas: shasToFetch, signal: controller.signal });
        } catch (err) {
          if (controller.signal.aborted) throw new Cancelled();
          const what = shasToFetch ? shasToFetch.map(short).join(", ") : `pull/${pr.number}/head`;
          failures.push(`${what}: ${message(err)}`);
          ctx.log.appendLine(`[pr-import] fetch of ${what} failed: ${message(err)}`);
        }
      };
      try {
        await attempt();
        missing = await missingShas(token);
        for (const sha of missing) {
          await attempt([sha]);
          if (token.isCancellationRequested) throw new Cancelled();
        }
        missing = await missingShas(token);
      } finally {
        sub.dispose();
      }
    },
  );
  if (missing.length > 0) {
    ctx.log.appendLine(`[pr-import] still missing after fetch: ${missing.join(", ")}`);
    const reason = failures.length > 0 ? ` Git said: ${plainMessageText(failures[0], 200)}` : "";
    void vscode.window.showWarningMessage(
      `RepoTrail: still missing ${missing.map(short).join(", ")} after fetching; those diff stops won't open.${reason}`,
    );
  }
}

async function findMissing(folder: string, shas: string[], token?: vscode.CancellationToken): Promise<string[]> {
  const missing: string[] = [];
  for (const sha of shas) {
    if (token?.isCancellationRequested) throw new Cancelled();
    if (!(await hasCommit(folder, sha))) missing.push(sha);
  }
  return missing;
}

async function offerSave(
  picked: Candidate,
  plan: TourPlan,
  folder: vscode.WorkspaceFolder,
  label: string,
  ctx: PrImportContext,
): Promise<void> {
  const tourHead = sharedHeadRef(plan);
  const headNote = tourHead ? ` at ${short(tourHead)}` : "";
  const pick = await vscode.window.showInformationMessage(
    plainMessageText(
      `RepoTrail: playing "${plan.title}" from ${label}${headNote} (${plan.steps.length} stops), posted by @${picked.author}.`,
      300,
    ),
    `Save to ${REPO_TOURS_DIR}/`,
  );
  if (pick !== `Save to ${REPO_TOURS_DIR}/`) return;
  const file = path.join(folder.uri.fsPath, REPO_TOURS_DIR, `${slugForFilename(plan.title)}.json`);
  try {
    if (await exists(file)) {
      const replace = await vscode.window.showWarningMessage(
        `${REPO_TOURS_DIR}/${path.basename(file)} already exists in ${folder.name}. Replace it?`,
        { modal: true },
        "Replace",
      );
      if (replace !== "Replace") return;
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    // The fence text already parsed as a tour; keep the author's formatting.
    await fs.writeFile(file, `${picked.tour.json.trimEnd()}\n`, "utf8");
    ctx.log.appendLine(`[pr-import] saved ${file}`);
    vscode.window.setStatusBarMessage(`RepoTrail: saved ${REPO_TOURS_DIR}/${path.basename(file)}.`, 4000);
  } catch (err) {
    ctx.log.appendLine(`[pr-import] save failed: ${message(err)}`);
    vscode.window.showErrorMessage(`RepoTrail: couldn't save the tour. ${plainMessageText(message(err))}`);
  }
}

async function pickTourToShare(
  ctx: PrImportContext,
): Promise<{ plan: TourPlan; rootPath?: string } | undefined> {
  const snap = ctx.controller.snapshot();
  const active = ctx.controller.activeRepoTourSource;
  const roots = workspaceFolderInfos().map((info) => ({
    rootPath: info.path,
    workspaceFolder: info.workspaceFolder,
    workspaceName: info.name,
  }));
  const repoTours = await listRepoTours(roots);
  type Item = vscode.QuickPickItem & { load: () => Promise<{ plan: TourPlan; rootPath?: string } | undefined> };
  const items: Item[] = [];
  if (snap.plan) {
    const plan = snap.plan;
    items.push({
      label: plan.title,
      description: "Active tour",
      detail: `${plan.steps.length} stops`,
      load: async () =>
        active
          ? { plan: (await readRepoTour(active.rootPath, active.file)) ?? plan, rootPath: active.rootPath }
          : { plan },
    });
  }
  for (const tour of repoTours) {
    if (active && samePath(active.rootPath, tour.rootPath) && active.file === tour.file) continue;
    items.push({
      label: tour.title,
      description: `${tour.workspaceName ?? path.basename(tour.rootPath)}/${REPO_TOURS_DIR}/${tour.file}`,
      detail: `${tour.stepCount} stops`,
      load: async () => {
        const plan = await readRepoTour(tour.rootPath, tour.file);
        return plan ? { plan, rootPath: tour.rootPath } : undefined;
      },
    });
  }
  if (items.length === 0) {
    vscode.window.showInformationMessage(`RepoTrail: no active tour and no ${REPO_TOURS_DIR}/*.json tours to share.`);
    return undefined;
  }
  const pick = items.length === 1
    ? items[0]
    : await vscode.window.showQuickPick(items, { title: "Copy which tour as a PR comment?", placeHolder: "Tour" });
  return pick ? pick.load() : undefined;
}

async function openGitHubRepos(): Promise<Array<{ owner: string; repo: string; remote: string; folder: vscode.WorkspaceFolder }>> {
  const out: Array<{ owner: string; repo: string; remote: string; folder: vscode.WorkspaceFolder }> = [];
  for (const folder of currentWorkspaceFolders()) {
    for (const repo of await githubReposForFolder(folder.uri.fsPath)) {
      if (!out.some((existing) => sameRepo(existing, repo))) out.push({ ...repo, folder });
    }
  }
  return out;
}

/** GitHub repos behind a folder's remotes, `upstream` first since PRs usually target it. */
async function githubReposForFolder(folderPath: string): Promise<Array<{ owner: string; repo: string; remote: string }>> {
  const remotes = await listRemotes(folderPath);
  const order = (name: string) => (name === "upstream" ? 0 : name === "origin" ? 1 : 2);
  return remotes
    .sort((a, b) => order(a.name) - order(b.name))
    .flatMap((remote) => {
      const parsed = parseGitHubRemote(remote.url);
      return parsed ? [{ ...parsed, remote: remote.name }] : [];
    })
    .filter((repo, index, all) => all.findIndex((other) => sameRepo(other, repo)) === index);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(0, 10);
}

function validationMessage(check: () => unknown): string | null {
  try {
    check();
    return null;
  } catch (err) {
    return message(err);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
