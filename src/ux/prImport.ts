import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { slugForFilename } from "../engine/tourSerialize";
import type { TourPlan } from "../engine/types";
import {
  currentBranch,
  fetchPullRequest,
  filesDifferingFrom,
  hasCommit,
  headCommit,
  listRemotes,
  listWorktrees,
  mergeBase,
  pullRequestFetchArgs,
  repoPathPrefix,
} from "../gitRepo";
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
  workingTreeFiles,
} from "../github/prTour";
import { parseGitHubRemote } from "../github/remotes";
import { findToursInMarkdown, FoundTour } from "../github/tourComments";
import { clearPendingImport, readPendingImport, writePendingImport } from "../storage/pendingImport";
import { listRepoTours, readRepoTour, REPO_TOURS_DIR } from "../storage/repoTours";
import { workspaceFileFor } from "../storage/workspaceFiles";
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

/** The user stopped the import; `message` says where, for the log. */
class Cancelled extends Error {}

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
  ctx.log.appendLine(`[pr-import] review link received for ${formatPrRef(request.pr)}`);
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
    if (options.fromLink && !(await confirmLink(request, ctx.controller.snapshot().plan?.title))) {
      throw new Cancelled("the link's confirmation was declined");
    }
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
    if (!picked) throw new Cancelled("no tour was picked");
    if (!(await confirmPoster(picked, pull, label))) throw new Cancelled(`the tour by @${picked.author} was declined`);
    const plan = picked.tour.plan;

    const clone = await pickCloneFolder(request, pull, options.preferredFolder);
    if (!clone) {
      await offerNoCloneActions(request, pull, picked, ctx);
      return;
    }
    ctx.log.appendLine(
      `[pr-import] using ${clone.folder.uri.fsPath} (remote ${clone.remote}); tour by ${picked.author} (${picked.authorAssociation})`,
    );
    if (!(await confirmCheckout(request, pull, plan, clone, ctx))) return;

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
    if (err instanceof Cancelled) {
      ctx.log.appendLine(`[pr-import] stopped: ${err.message || "cancelled"}`);
      return;
    }
    ctx.log.appendLine(`[pr-import] failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    vscode.window.showErrorMessage(`RepoTrail: couldn't import a tour from ${label}. ${plainMessageText(message(err))}`);
  }
}

let resuming = false;

/**
 * Resume an import another window handed to this one: "Open Folder…" when no
 * clone was open, or a folder that has the PR checked out. Runs when the
 * window starts and whenever it gains focus; `quiet` skips the log line for
 * imports waiting on other windows.
 */
export async function resumePendingPrImport(ctx: PrImportContext, options: { quiet?: boolean } = {}): Promise<void> {
  if (resuming) return;
  resuming = true;
  try {
    await resumePending(ctx, options.quiet ?? false);
  } finally {
    resuming = false;
  }
}

async function resumePending(ctx: PrImportContext, quiet: boolean): Promise<void> {
  const pending = await readPendingImport();
  if (!pending) return;
  if (Date.now() - pending.at > PENDING_IMPORT_TTL_MS || pending.at > Date.now() + 60_000) {
    await clearPendingImport();
    ctx.log.appendLine("[pr-import] dropped a pending import older than 15 minutes");
    return;
  }
  const folder = currentWorkspaceFolders().find((f) => samePath(f.uri.fsPath, pending.folder));
  if (!folder) {
    // Another window's import; that window picks it up.
    if (!quiet) ctx.log.appendLine(`[pr-import] a pending import is waiting for ${pending.folder}, which isn't open here`);
    return;
  }
  await clearPendingImport();
  let request: PrImportRequest;
  try {
    // Re-validate: the file is ours, but keep the same strict shapes.
    const { pr, commentId, head } = pending.request as PrImportRequest;
    request = parseReviewLink(
      "/review",
      `pr=${pr.owner}/${pr.repo}/${pr.number}${commentId ? `&comment=${commentId}` : ""}${head ? `&head=${head}` : ""}`,
    );
  } catch (err) {
    ctx.log.appendLine(`[pr-import] dropped an unreadable pending import: ${message(err)}`);
    return;
  }
  const pick = await vscode.window.showInformationMessage(
    `Continue opening the RepoTrail tour from ${formatPrRef(request.pr)}?`,
    { modal: true, detail: `You opened ${folder.name} to play the tour from ${formatPrRef(request.pr)}.` },
    "Open Tour",
  );
  if (pick !== "Open Tour") {
    ctx.log.appendLine(`[pr-import] stopped: continuing ${formatPrRef(request.pr)} in ${folder.name} was declined`);
    return;
  }
  await importTourFromPr(request, ctx, { preferredFolder: folder.uri.fsPath });
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
  if (diffRefs(plan).length > 0 && !sharedHeadRef(plan)) {
    notes.push("The link has no head SHA because the diff stops don't share one headRef.");
  }
  const pick = await vscode.window.showInformationMessage(notes.join(" "), "Open PR");
  if (pick === "Open PR") await vscode.env.openExternal(vscode.Uri.parse(prHtmlUrl(pr)));
}

async function confirmLink(request: PrImportRequest, openTourTitle?: string): Promise<boolean> {
  const { pr } = request;
  const lines = [
    `Repository: ${pr.owner}/${pr.repo}`,
    `Pull request: #${pr.number}`,
    `Comment: ${request.commentId ?? "any comment on the pull request"}`,
  ];
  if (request.head) lines.push(`Expected head: ${request.head}`);
  if (openTourTitle) lines.push("", `The tour it finds replaces the one you have open, "${plainMessageText(openTourTitle, 120)}".`);
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
    if (signal.aborted) throw new Cancelled("reading GitHub was cancelled");
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
    // Modal: an import the user just started shouldn't hinge on a toast they can miss.
    const pick = await vscode.window.showWarningMessage(
      `RepoTrail needs your GitHub sign-in to read ${label}.`,
      { modal: true, detail: `${reason} Sign in to read it with your GitHub account.` },
      SIGN_IN,
    );
    if (pick !== SIGN_IN) throw new Cancelled("GitHub sign-in was declined");
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
    ignoreFocusOut: true,
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
  const prHead = pull.headSha.toLowerCase();
  const atHead: CloneFolder[] = [];
  for (const match of matches) if ((await headCommit(match.folder.uri.fsPath)) === prHead) atHead.push(match);
  if (atHead.length === 1) return atHead[0];
  const pick = await vscode.window.showQuickPick(
    matches.map((match) => ({
      label: match.folder.name,
      description: `${match.remote} · ${match.folder.uri.fsPath}`,
      match,
    })),
    { title: `Open the tour in which clone of ${request.pr.owner}/${request.pr.repo}?`, placeHolder: "Folder", ignoreFocusOut: true },
  );
  if (!pick) throw new Cancelled("no clone was picked");
  return pick.match;
}

const OPEN_FOLDER = "Open Folder…";
const LOAD_HERE = "Load Here Anyway";

/**
 * Slides, file stops and slide refs read the working tree, so they need the
 * PR's files checked out; diff stops read commits and work from any checkout.
 * A review link opens in whichever window had focus, which may be a checkout
 * of another branch. When the clone's working tree doesn't match the PR's head
 * for the files the tour reads, say so and offer the worktree that has the
 * PR's head (VS Code switches to its window if it's open), another folder, or
 * loading here anyway. True to load in this clone.
 */
async function confirmCheckout(
  request: PrImportRequest,
  pull: GitHubPull,
  plan: TourPlan,
  clone: CloneFolder,
  ctx: PrImportContext,
): Promise<boolean> {
  const files = workingTreeFiles(plan);
  const prHead = pull.headSha.toLowerCase();
  if (files.length === 0 || !isFullSha(prHead)) return true;
  const folder = clone.folder.uri.fsPath;
  const head = await headCommit(folder);
  if (head === prHead) return true;
  const known = await hasCommit(folder, prHead);
  const differing = (known ? await filesDifferingFrom(folder, prHead, files) : undefined) ?? (await missingFiles(folder, files));
  const at = head ? short(head) : "no commit";
  if (differing.length === 0) {
    ctx.log.appendLine(
      `[pr-import] ${clone.folder.name} is at ${at}, not ${short(prHead)}, but the tour's ${files.length} working-tree file(s) ${known ? "match the PR's head" : "are all present (the PR's head isn't fetched here)"}`,
    );
    return true;
  }
  ctx.log.appendLine(
    `[pr-import] ${clone.folder.name} is at ${at}, not ${short(prHead)}; ${differing.length} of ${files.length} working-tree file(s) ${known ? "differ" : "are missing"}: ${differing.join(", ")}`,
  );

  const label = formatPrRef(request.pr);
  const branch = await currentBranch(folder);
  const where = branch ? `on ${branch}` : head ? `at ${short(head)}` : "not on a commit";
  const prefix = (await repoPathPrefix(folder)) ?? "";
  const worktree = (await listWorktrees(folder))
    .filter((w) => w.head === prHead)
    .map((w) => path.join(w.path, prefix))
    .find((candidate) => !samePath(candidate, folder));
  const worktreeName = worktree ? path.basename(worktree) : undefined;
  const shown = differing.slice(0, 3).join(", ") + (differing.length > 3 ? `, and ${differing.length - 3} more` : "");
  const detail = [
    `${clone.folder.name} is ${where}, not the PR's head (${short(prHead)}). The tour shows files from the working tree, and here ${
      differing.length === 1 ? "one is" : `${differing.length} are`
    } ${known ? "different or missing" : "missing"}: ${shown}.`,
    "",
    worktree
      ? `${worktreeName} has the PR's head checked out. Open it to play the tour there; if it's open in another window, VS Code switches to that window.`
      : `Check out the PR in ${clone.folder.name} (with GitHub Pull Requests, or gh pr checkout ${request.pr.number}) and open the tour again, or open a folder that has it checked out.`,
  ].join("\n");
  const openWorktree = worktreeName ? `Open ${worktreeName}` : undefined;
  const pick = await vscode.window.showWarningMessage(
    `${clone.folder.name} doesn't have ${label} checked out.`,
    { modal: true, detail },
    ...(openWorktree ? [openWorktree] : []),
    OPEN_FOLDER,
    LOAD_HERE,
  );
  if (pick === LOAD_HERE) {
    ctx.log.appendLine(`[pr-import] loading in ${clone.folder.name} anyway`);
    return true;
  }
  if (pick && pick === openWorktree && worktree) {
    await continueInWindow(request, worktree, ctx);
    return false;
  }
  if (pick === OPEN_FOLDER) {
    const folders = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(path.dirname(folder)),
      openLabel: "Open",
      title: `Open a folder that has ${label} checked out`,
    });
    if (!folders?.[0]) throw new Cancelled("no folder was opened");
    await continueInWindow(request, folders[0].fsPath, ctx);
    return false;
  }
  throw new Cancelled("the checkout warning was dismissed");
}

/**
 * Continue the import in `target`: here if this window has it open, else in
 * the window on it. VS Code switches to the window that already has the
 * folder (or the `.code-workspace` holding it) open, or opens a new one;
 * resumePendingPrImport picks the import up there.
 */
async function continueInWindow(request: PrImportRequest, target: string, ctx: PrImportContext): Promise<void> {
  if (currentWorkspaceFolders().some((f) => samePath(f.uri.fsPath, target))) {
    await importTourFromPr(request, ctx, { preferredFolder: target });
    return;
  }
  const workspaceFile = await workspaceFileFor(target);
  await writePendingImport({ request, folder: target, at: Date.now() });
  ctx.log.appendLine(
    `[pr-import] handing ${formatPrRef(request.pr)} to the window on ${workspaceFile ?? target}${workspaceFile ? ` (holds ${target})` : ""}`,
  );
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(workspaceFile ?? target), { forceNewWindow: true });
}

async function missingFiles(folder: string, files: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const file of files) if (!(await exists(path.join(folder, file)))) missing.push(file);
  return missing;
}

async function offerNoCloneActions(
  request: PrImportRequest,
  pull: GitHubPull,
  picked: Candidate,
  ctx: PrImportContext,
): Promise<void> {
  const { pr } = request;
  const tourHead = sharedHeadRef(picked.tour.plan);
  const open = currentWorkspaceFolders().map((folder) => folder.name);
  ctx.log.appendLine(`[pr-import] no open folder is a clone of ${pr.owner}/${pr.repo}; open: ${open.join(", ") || "none"}`);
  // Modal: the link may have opened in a window other than the one with the
  // clone, and a toast there is easy to miss.
  const pick = await vscode.window.showWarningMessage(
    `No open folder in this window is a clone of ${pr.owner}/${pr.repo}.`,
    {
      modal: true,
      detail: [
        open.length > 0 ? `This window has ${open.join(", ")} open.` : "This window has no folder open.",
        "Open a clone of the repository, or copy a prompt that has your coding agent check out the PR and open the tour.",
      ].join(" "),
    },
    "Open Folder…",
    "Copy setup prompt",
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
    if (!folders?.[0]) {
      ctx.log.appendLine("[pr-import] stopped: no folder was opened");
      return;
    }
    await writePendingImport({ request, folder: folders[0].fsPath, at: Date.now() });
    await vscode.commands.executeCommand("vscode.openFolder", folders[0]);
    return;
  }
  ctx.log.appendLine("[pr-import] stopped: the no-clone dialog was dismissed");
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
          if (controller.signal.aborted) throw new Cancelled("the commit fetch was cancelled");
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
          if (token.isCancellationRequested) throw new Cancelled("the commit fetch was cancelled");
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
    if (token?.isCancellationRequested) throw new Cancelled("checking the tour's commits was cancelled");
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
