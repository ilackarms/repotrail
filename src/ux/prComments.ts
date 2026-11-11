import * as vscode from "vscode";
import type { TourPlan, TourStep } from "../engine/types";
import { repoPathPrefix } from "../gitRepo";
import { formatPrRef, prHtmlUrl, PrRef } from "../github/prRef";
import {
  GITHUB_PULL_REQUESTS_EXTENSION_ID,
  prFileUrl,
  pullRequestsCheckoutLink,
  samePr,
} from "../github/pullRequestsExtension";
import { normalizeWorkspaceFile, resolveStepUri } from "../workspace";
import { plainMessageText } from "./messageText";
import { checkedOutPullRequest, stopReviewState } from "./pullRequestReview";
import type { TourController } from "./tourController";

/**
 * "RepoTrail: Comment on PR". RepoTrail never posts to GitHub: comments go
 * through the GitHub Pull Requests extension, whose comment gutter appears on
 * workspace files of the PR it has checked out. This command gets the user
 * there from the current stop: it reopens the stop on the checked-out file,
 * or offers that extension's own checkout, or the PR's page on github.com.
 */

const INSTALL = "Install GitHub Pull Requests";
const CHECK_OUT = "Check Out PR";
const CHECK_OUT_ANOTHER = "Check Out a PR…";
const ON_GITHUB = "Comment on GitHub";

const CHECKOUT_WAIT_MS = 3 * 60_000;
const CHECKOUT_POLL_MS = 1_500;
let checkoutWatch: { cancel(): void } | undefined;

export async function commentOnPr(controller: TourController, log: vscode.OutputChannel): Promise<void> {
  const { plan, current: step } = controller.snapshot();
  if (!plan || !step) {
    vscode.window.showInformationMessage("RepoTrail: start a tour first, then comment from its stops.");
    return;
  }
  if (!step.file) {
    vscode.window.showInformationMessage(
      "RepoTrail: this slide has no source file to comment on. Comment from a code stop, or from a slide that names its doc section.",
    );
    return;
  }
  const tourPr = controller.activePullRequest ?? undefined;
  const state = await stopReviewState(step, plan, tourPr, { fresh: true });
  log.appendLine(
    `[pr-comments] ${state.kind}${"pr" in state ? ` ${formatPrRef(state.pr)}` : ""}${tourPr ? ` (tour PR ${formatPrRef(tourPr)})` : ""}`,
  );

  switch (state.kind) {
    case "no-extension": {
      const pick = await vscode.window.showInformationMessage(
        "RepoTrail: comments from a trail go through the GitHub Pull Requests extension. Install it and check out the PR; its comment gutter then works in the trail's diffs.",
        INSTALL,
        ...(tourPr ? [ON_GITHUB] : []),
      );
      if (pick === INSTALL) await showPullRequestsExtension();
      else if (pick === ON_GITHUB && tourPr) await openOnGitHub(tourPr, step, plan);
      return;
    }
    case "no-folder":
      vscode.window.showErrorMessage(
        `RepoTrail: can't find the open folder for ${plainMessageText(step.file)}, so there's nothing to comment on.`,
      );
      return;
    case "reviewing": {
      if (await showCommentableStop(controller, step, plan)) {
        vscode.window.showInformationMessage(
          `RepoTrail: ${formatPrRef(state.pr)} is checked out in GitHub Pull Requests. Hover a line the PR changes in ${plainMessageText(step.file)} and click + to comment.`,
        );
        return;
      }
      const pick = await vscode.window.showInformationMessage(
        `RepoTrail: ${plainMessageText(step.file)} isn't in your working tree (the PR may delete or move it), so GitHub Pull Requests can't take comments on it here.`,
        ON_GITHUB,
      );
      if (pick === ON_GITHUB) await openOnGitHub(tourPr ?? state.pr, step, plan);
      return;
    }
    case "other":
    case "none": {
      const folder = state.folder;
      const current = state.kind === "other" ? state.pr : undefined;
      if (!tourPr) {
        const why = current
          ? `GitHub Pull Requests has ${formatPrRef(current)} checked out in ${folder.name}, which doesn't contain the commit this stop shows.`
          : `Nothing is checked out for review in ${folder.name}.`;
        const pick = await vscode.window.showInformationMessage(
          `RepoTrail: ${why} Check out this tour's pull request with GitHub Pull Requests; the trail's diffs then get its comment gutter.`,
          CHECK_OUT_ANOTHER,
        );
        if (pick !== CHECK_OUT_ANOTHER) return;
        try {
          await vscode.commands.executeCommand("pr.checkoutByNumber");
        } catch (err) {
          log.appendLine(`[pr-comments] pr.checkoutByNumber failed: ${String(err)}`);
          vscode.window.showErrorMessage(
            "RepoTrail: GitHub Pull Requests couldn't start a checkout. Check out the PR from its Pull Requests view instead.",
          );
          return;
        }
        watchForCheckout(controller, folder.uri, { previous: current }, log);
        return;
      }
      const why = current
        ? `GitHub Pull Requests has ${formatPrRef(current)} checked out in ${folder.name}, not ${formatPrRef(tourPr)}.`
        : `${formatPrRef(tourPr)} isn't checked out in ${folder.name}.`;
      const pick = await vscode.window.showInformationMessage(
        `RepoTrail: ${why} Check it out with GitHub Pull Requests to comment from the trail; that switches ${folder.name} to the PR's branch.`,
        CHECK_OUT,
        ON_GITHUB,
      );
      if (pick === CHECK_OUT) {
        await openPullRequestsCheckout(tourPr);
        watchForCheckout(controller, folder.uri, { expected: tourPr }, log);
      } else if (pick === ON_GITHUB) {
        await openOnGitHub(tourPr, step, plan);
      }
      return;
    }
  }
}

/**
 * Reopen the stop and make sure the visible editor is the workspace file
 * comments attach to. False when the file isn't in the working tree.
 */
async function showCommentableStop(controller: TourController, step: TourStep, plan: TourPlan): Promise<boolean> {
  await controller.revealCurrent();
  let uri: vscode.Uri | null = null;
  try {
    uri = resolveStepUri(step, plan);
  } catch {
    uri = null;
  }
  if (!uri) return false;
  if (activeTabShows(uri)) return true;
  // A diff the working tree can't stand in for (built from inline text, or
  // scoped to a hunk): open the file itself, where the gutter covers the
  // PR's changed lines.
  await controller.openCurrentSource();
  return activeTabShows(uri);
}

function activeTabShows(uri: vscode.Uri): boolean {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const key = uri.toString();
  if (input instanceof vscode.TabInputTextDiff) return input.modified.toString() === key;
  if (input instanceof vscode.TabInputText) return input.uri.toString() === key;
  return false;
}

/**
 * The extension's own checkout link, the one github.com's "Open in VS Code"
 * uses. It asks before switching branches; VS Code may first ask to allow
 * the extension to open the link.
 */
async function openPullRequestsCheckout(pr: PrRef): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(pullRequestsCheckoutLink(vscode.env.uriScheme, pr)));
}

/**
 * Once GitHub Pull Requests reports the checkout (the expected PR, or with no
 * expected PR any PR other than `previous`), reopen the current stop so its
 * diff shows the checked-out file. Gives up after a few minutes.
 */
function watchForCheckout(
  controller: TourController,
  folder: vscode.Uri,
  target: { expected?: PrRef; previous?: PrRef },
  log: vscode.OutputChannel,
): void {
  checkoutWatch?.cancel();
  const tourId = controller.activeTourId;
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const watch = {
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  };
  const done = () => {
    if (checkoutWatch === watch) checkoutWatch = undefined;
  };
  const tick = async () => {
    if (cancelled || controller.activeTourId !== tourId) return done();
    const pr = await checkedOutPullRequest(folder, { fresh: true });
    if (cancelled || controller.activeTourId !== tourId) return done();
    const arrived = pr && (target.expected ? samePr(pr, target.expected) : !target.previous || !samePr(pr, target.previous));
    if (pr && arrived) {
      done();
      log.appendLine(`[pr-comments] ${formatPrRef(pr)} checked out; reopening the current stop`);
      try {
        await controller.revealCurrent();
        const { plan, current } = controller.snapshot();
        if (!plan || !current) return;
        let uri: vscode.Uri | null = null;
        try {
          uri = resolveStepUri(current, plan);
        } catch {
          uri = null;
        }
        // Say what the screen now shows: the checked-out file takes comments.
        const commentable = uri !== null && activeTabShows(uri);
        const state = commentable
          ? undefined
          : await stopReviewState(current, plan, controller.activePullRequest ?? undefined);
        vscode.window.setStatusBarMessage(
          commentable
            ? `RepoTrail: ${formatPrRef(pr)} is checked out. Click + beside a line it changes to comment.`
            : state?.kind === "reviewing"
              ? `RepoTrail: ${formatPrRef(pr)} is checked out. Run Comment on PR to open this stop's file for comments.`
              : `RepoTrail: ${formatPrRef(pr)} is checked out, but it doesn't hold this stop's commit.`,
          10_000,
        );
      } catch (err) {
        log.appendLine(`[pr-comments] reopening the stop after checkout failed: ${String(err)}`);
      }
      return;
    }
    if (Date.now() - started > CHECKOUT_WAIT_MS) return done();
    timer = setTimeout(() => void tick(), CHECKOUT_POLL_MS);
  };
  checkoutWatch = watch;
  timer = setTimeout(() => void tick(), CHECKOUT_POLL_MS);
}

async function showPullRequestsExtension(): Promise<void> {
  try {
    await vscode.commands.executeCommand("extension.open", GITHUB_PULL_REQUESTS_EXTENSION_ID);
  } catch {
    await vscode.commands.executeCommand("workbench.extensions.search", `@id:${GITHUB_PULL_REQUESTS_EXTENSION_ID}`);
  }
}

/** The PR's "Files changed" page at this stop's file (and line, for a diff pinned to a commit). */
async function openOnGitHub(pr: PrRef, step: TourStep, plan: TourPlan): Promise<void> {
  let url = `${prHtmlUrl(pr)}/files`;
  try {
    const file = normalizeWorkspaceFile(step.diff?.headFile ?? step.file ?? "");
    const uri = resolveStepUri(step, plan);
    const folder = uri ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
    const prefix = folder ? (await repoPathPrefix(folder.uri.fsPath)) ?? "" : "";
    const line = step.diff?.headRef ? step.range?.startLine : undefined;
    url = prFileUrl(pr, `${prefix}${file}`, line);
  } catch {
    /* fall back to the Files changed tab */
  }
  await vscode.env.openExternal(vscode.Uri.parse(url));
}
