import * as vscode from "vscode";
import { effectiveDiffScope } from "../diffMaterialize";
import type { TourPlan, TourStep } from "../engine/types";
import { headContains, remoteBranchesContaining } from "../gitRepo";
import type { PrRef } from "../github/prRef";
import {
  checkedOutPr,
  defaultBranchOf,
  GITHUB_PULL_REQUESTS_EXTENSION_ID,
  PullRequestsRepositoryDescription,
  remoteBranchesInclude,
  samePr,
} from "../github/pullRequestsExtension";
import { resolveStepWorkspaceFolder } from "../workspace";

/**
 * What the GitHub Pull Requests extension has checked out, as it bears on a
 * tour stop. That extension draws its comment gutter only on workspace files
 * of the PR it has checked out, so a stop is commentable when that PR is the
 * tour's and the stop shows the working-tree file. Reads the extension's
 * published API (getRepositoryDescription) and nothing else of it.
 */

interface PullRequestsApi {
  getRepositoryDescription?(uri: vscode.Uri): Thenable<PullRequestsRepositoryDescription | undefined>;
}

interface Checkout {
  pr: PrRef;
  defaultBranch?: string;
}

export type StopReviewState =
  | { kind: "no-extension" }
  | { kind: "no-folder" }
  /** Nothing checked out in the stop's folder. */
  | { kind: "none"; folder: vscode.WorkspaceFolder }
  /** The tour's PR is checked out (or, with no known PR, one that holds the stop's unmerged commit). */
  | { kind: "reviewing"; folder: vscode.WorkspaceFolder; pr: PrRef }
  /** A different PR is checked out. */
  | { kind: "other"; folder: vscode.WorkspaceFolder; pr: PrRef };

const LOOKUP_TIMEOUT_MS = 2_000;
const CACHE_MS = 3_000;
const MERGED_CACHE_MS = 5 * 60_000;

/**
 * One call into the extension per folder at a time. Every caller races its own
 * timeout against the shared call, so a slow or hung extension never collects
 * more than one pending call per folder.
 */
interface FolderLookup {
  call: Promise<Checkout | undefined>;
  settled: boolean;
  result?: Checkout;
  at: number;
  /** A caller gave up on this call before it settled. */
  missed: boolean;
}
const lookups = new Map<string, FolderLookup>();
/** Whether a commit is already on the default branch, by folder, commit and branch. */
const mergedCache = new Map<string, { at: number; value: Promise<boolean | undefined> }>();

const lateCheckout = new vscode.EventEmitter<vscode.Uri>();
/**
 * Fires when a lookup that timed out (typically while GitHub Pull Requests was
 * still activating at startup) later finds a checked-out PR, so the stop that
 * was shown without it can be shown again. At most once per extension call.
 */
export const onDidFindLateCheckout = lateCheckout.event;

let logger: vscode.OutputChannel | null = null;
export function setPullRequestReviewLogger(channel: vscode.OutputChannel): void {
  logger = channel;
}

export function pullRequestsExtensionInstalled(): boolean {
  return vscode.extensions.getExtension(GITHUB_PULL_REQUESTS_EXTENSION_ID) !== undefined;
}

/** The PR GitHub Pull Requests has checked out in this folder. Cached briefly; `fresh` skips the cache. */
export async function checkedOutPullRequest(
  folder: vscode.Uri,
  options: { fresh?: boolean } = {},
): Promise<PrRef | undefined> {
  return (await checkoutIn(folder, options))?.pr;
}

function checkoutIn(folder: vscode.Uri, options: { fresh?: boolean }): Promise<Checkout | undefined> {
  const key = folder.toString();
  let entry = lookups.get(key);
  const reusable = entry && (!entry.settled || (!options.fresh && Date.now() - entry.at < CACHE_MS));
  if (!entry || !reusable) {
    entry = startLookup(folder);
    lookups.set(key, entry);
  }
  if (entry.settled) return Promise.resolve(entry.result);
  return withTimeout(entry, folder);
}

function startLookup(folder: vscode.Uri): FolderLookup {
  const key = folder.toString();
  const entry: FolderLookup = { call: Promise.resolve(undefined), settled: false, at: Date.now(), missed: false };
  entry.call = callExtension(folder)
    .catch((err) => {
      logger?.appendLine(`[pr-review] GitHub Pull Requests lookup failed for ${folder.fsPath}: ${String(err)}`);
      return undefined;
    })
    .then((result) => {
      entry.settled = true;
      entry.result = result;
      entry.at = Date.now();
      if (entry.missed && result && lookups.get(key) === entry) {
        logger?.appendLine(`[pr-review] GitHub Pull Requests answered late for ${folder.fsPath}`);
        lateCheckout.fire(folder);
      }
      return result;
    });
  return entry;
}

async function callExtension(folder: vscode.Uri): Promise<Checkout | undefined> {
  const ext = vscode.extensions.getExtension<PullRequestsApi>(GITHUB_PULL_REQUESTS_EXTENSION_ID);
  if (!ext) return undefined;
  const api = ext.isActive ? ext.exports : await ext.activate();
  if (typeof api?.getRepositoryDescription !== "function") return undefined;
  const description = await api.getRepositoryDescription(folder);
  const pr = checkedOutPr(description);
  return pr ? { pr, defaultBranch: defaultBranchOf(description) } : undefined;
}

async function withTimeout(entry: FolderLookup, folder: vscode.Uri): Promise<Checkout | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      if (!entry.missed) {
        logger?.appendLine(`[pr-review] GitHub Pull Requests didn't answer for ${folder.fsPath} within ${LOOKUP_TIMEOUT_MS} ms`);
      }
      entry.missed = true;
      resolve(undefined);
    }, LOOKUP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([entry.call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function stopReviewState(
  step: TourStep,
  plan: TourPlan | undefined,
  tourPr: PrRef | undefined,
  options: { fresh?: boolean } = {},
): Promise<StopReviewState> {
  if (!pullRequestsExtensionInstalled()) return { kind: "no-extension" };
  let folder: vscode.WorkspaceFolder | null;
  try {
    folder = resolveStepWorkspaceFolder(step, plan);
  } catch {
    folder = null;
  }
  if (!folder) return { kind: "no-folder" };
  const checkout = await checkoutIn(folder.uri, options);
  if (!checkout) return { kind: "none", folder };
  const { pr } = checkout;
  if (tourPr) return samePr(pr, tourPr) ? { kind: "reviewing", folder, pr } : { kind: "other", folder, pr };
  // Unknown tour PR: trust the checkout only if it holds the commit this stop
  // shows and that commit isn't merged yet (a tour of past commits isn't a PR
  // under review, whatever branch is checked out).
  const head = step.diff?.headRef;
  if (head && !(await holdsUnmergedCommit(folder.uri.fsPath, head, checkout.defaultBranch))) {
    return { kind: "other", folder, pr };
  }
  return { kind: "reviewing", folder, pr };
}

async function holdsUnmergedCommit(folder: string, commit: string, defaultBranch: string | undefined): Promise<boolean> {
  if (!(await headContains(folder, commit).catch(() => false))) return false;
  if (!defaultBranch) return true;
  // When git can't say, don't treat the checkout as this tour's PR.
  return (await mergedIntoDefault(folder, commit, defaultBranch)) === false;
}

/**
 * Whether a remote's copy of the default branch already holds the commit.
 * `git branch -r --contains` can be slow in big repositories and tours share a
 * few commits, so answers are kept for a few minutes.
 */
function mergedIntoDefault(folder: string, commit: string, defaultBranch: string): Promise<boolean | undefined> {
  const key = `${folder}\0${commit.toLowerCase()}\0${defaultBranch}`;
  const hit = mergedCache.get(key);
  if (hit && Date.now() - hit.at < MERGED_CACHE_MS) return hit.value;
  const value = remoteBranchesContaining(folder, commit)
    .then((branches) => (branches === undefined ? undefined : remoteBranchesInclude(branches, defaultBranch)))
    .catch(() => undefined);
  mergedCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * The checked-out PR when a diff stop should show the working-tree file as its
 * new side: a whole-file diff with a headRef whose PR is checked out in the
 * stop's folder. The working tree is then that PR (possibly newer than the
 * tour's commit), and it is the document GitHub Pull Requests comments on.
 */
export async function stopShowsReviewCheckout(
  step: TourStep,
  plan: TourPlan | undefined,
  tourPr: PrRef | undefined,
): Promise<PrRef | undefined> {
  if (!step.diff?.headRef || effectiveDiffScope(step) !== "file") return undefined;
  const state = await stopReviewState(step, plan, tourPr);
  return state.kind === "reviewing" ? state.pr : undefined;
}
