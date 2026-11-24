import * as vscode from "vscode";
import { commitsAheadOf, currentBranch, defaultBranchRef } from "../gitRepo";
import { isChangeBranch, RootCheckout } from "./agentSetupPrompt";
import { checkedOutPullRequest } from "./pullRequestReview";

/**
 * The change a workspace folder has checked out, for Agent Setup: the pull
 * request GitHub Pull Requests reports, or else a branch with commits the
 * default branch doesn't have (a PR checked out with git or `gh`, or local
 * work). Undefined on the default branch, outside a git repository, and for
 * folders that aren't on disk. Reads only.
 */
export async function checkedOutChange(folder: vscode.Uri): Promise<RootCheckout | undefined> {
  if (folder.scheme !== "file") return undefined;
  const dir = folder.fsPath;
  const [pr, branch, defaultBranch] = await Promise.all([
    checkedOutPullRequest(folder).catch(() => undefined),
    currentBranch(dir),
    defaultBranchRef(dir),
  ]);
  // Names go to the prompt as they are; it drops any that aren't plain refs.
  if (pr) return { kind: "pr", pr, branch, defaultRef: defaultBranch?.ref };
  if (!defaultBranch || !isChangeBranch(branch, defaultBranch.branch)) return undefined;
  const ahead = await commitsAheadOf(dir, defaultBranch.ref);
  return ahead ? { kind: "branch", branch, defaultRef: defaultBranch.ref, ahead } : undefined;
}
