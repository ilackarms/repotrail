import * as childProcess from "node:child_process";
import { normalizeGitRef } from "./gitBlob";
import { GitRemote, parseGitRemoteVerbose } from "./github/remotes";

/**
 * Git calls for PR tours: importing one, and checking what a review checkout
 * contains. Everything here runs through execFile with fixed argument lists,
 * never a shell. `fetchPullRequest` is the only call that writes to the
 * repository (objects and FETCH_HEAD), and callers ask the user before
 * running it.
 */

const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export async function listRemotes(folder: string): Promise<GitRemote[]> {
  try {
    const { stdout } = await git(["-C", folder, "remote", "-v"], 10_000);
    return parseGitRemoteVerbose(stdout).filter((remote) => REMOTE_NAME_PATTERN.test(remote.name));
  } catch {
    return [];
  }
}

/** `git cat-file -e <ref>^{commit}`: does this commit exist locally? */
export async function hasCommit(folder: string, ref: string): Promise<boolean> {
  const safeRef = normalizeGitRef(ref);
  try {
    await git(["-C", folder, "cat-file", "-e", `${safeRef}^{commit}`], 10_000);
    return true;
  } catch {
    return false;
  }
}

/** `git merge-base <a> <b>` for two full SHAs; undefined when either is missing. */
export async function mergeBase(folder: string, a: string, b: string): Promise<string | undefined> {
  if (!/^[0-9a-f]{40}$/i.test(a) || !/^[0-9a-f]{40}$/i.test(b)) return undefined;
  try {
    const { stdout } = await git(["-C", folder, "merge-base", a, b], 20_000);
    const sha = stdout.trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** `git merge-base --is-ancestor <ancestor> HEAD`: does the checkout contain this commit? */
export async function headContains(folder: string, ancestor: string): Promise<boolean> {
  const safeRef = normalizeGitRef(ancestor);
  try {
    await git(["-C", folder, "merge-base", "--is-ancestor", safeRef, "HEAD"], 10_000);
    return true;
  } catch {
    return false;
  }
}

/** `git branch -r --contains <commit>`: remote-tracking branches that already have it, one per line. */
export async function remoteBranchesContaining(folder: string, commit: string): Promise<string | undefined> {
  const safeRef = normalizeGitRef(commit);
  try {
    const { stdout } = await git(["-C", folder, "branch", "-r", "--contains", safeRef, "--format=%(refname:short)"], 20_000);
    return stdout;
  } catch {
    return undefined;
  }
}

/** `git rev-parse --show-prefix`: the folder's path inside its repository, "" at the root. */
export async function repoPathPrefix(folder: string): Promise<string | undefined> {
  try {
    const { stdout } = await git(["-C", folder, "rev-parse", "--show-prefix"], 10_000);
    return stdout.trim().replace(/\\/g, "/");
  } catch {
    return undefined;
  }
}

/** `git rev-parse HEAD`: the checkout's commit, lowercase; undefined outside a repository or before the first commit. */
export async function headCommit(folder: string): Promise<string | undefined> {
  try {
    const { stdout } = await git(["-C", folder, "rev-parse", "--verify", "-q", "HEAD^{commit}"], 10_000);
    const sha = stdout.trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** `git symbolic-ref --short HEAD`: the checked-out branch; undefined when detached. */
export async function currentBranch(folder: string): Promise<string | undefined> {
  try {
    const { stdout } = await git(["-C", folder, "symbolic-ref", "--short", "-q", "HEAD"], 10_000);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which of `files` (relative to `folder`) differ between `commit` and the
 * working tree, including files missing on either side. Literal pathspecs, so
 * a `*` in a name isn't a glob. Undefined when git fails.
 */
export async function filesDifferingFrom(folder: string, commit: string, files: string[]): Promise<string[] | undefined> {
  if (!/^[0-9a-f]{40}$/i.test(commit)) return undefined;
  if (files.length === 0) return [];
  try {
    const { stdout } = await git(
      ["--literal-pathspecs", "-C", folder, "diff", "--no-renames", "--name-only", "--relative", commit, "--", ...files],
      20_000,
    );
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return undefined;
  }
}

export interface GitWorktree {
  path: string;
  /** Lowercase commit SHA; undefined for a bare entry. */
  head?: string;
  /** Short branch name; undefined when detached. */
  branch?: string;
}

/** Entries of `git worktree list --porcelain`, skipping bare and prunable ones. */
export function parseWorktreeList(porcelain: string): GitWorktree[] {
  const out: GitWorktree[] = [];
  for (const record of porcelain.split(/\n\s*\n/)) {
    let entry: GitWorktree | undefined;
    let skip = false;
    for (const line of record.split("\n")) {
      if (line.startsWith("worktree ")) entry = { path: line.slice("worktree ".length) };
      else if (line.startsWith("HEAD ") && entry) {
        const sha = line.slice(5).trim().toLowerCase();
        if (/^[0-9a-f]{40}$/.test(sha)) entry.head = sha;
      } else if (line.startsWith("branch ") && entry) entry.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
      else if (line === "bare" || line.startsWith("prunable")) skip = true;
    }
    if (entry && !skip) out.push(entry);
  }
  return out;
}

/** `git worktree list --porcelain` for the repository that holds `folder`. */
export async function listWorktrees(folder: string): Promise<GitWorktree[]> {
  try {
    const { stdout } = await git(["-C", folder, "worktree", "list", "--porcelain"], 10_000);
    return parseWorktreeList(stdout);
  } catch {
    return [];
  }
}

export function pullRequestFetchArgs(remote: string, prNumber: number, shas: string[] = []): string[] {
  if (!REMOTE_NAME_PATTERN.test(remote)) throw new Error(`"${remote}" isn't a usable git remote name.`);
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error("Invalid pull request number.");
  for (const sha of shas) {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`"${sha}" isn't a full commit SHA.`);
  }
  const refspecs = shas.length > 0 ? shas : [`pull/${prNumber}/head`];
  return ["fetch", "--no-tags", remote, ...refspecs];
}

/**
 * Fetch `pull/<n>/head` (or, with `shas`, those commits) from `remote` into
 * the object store. No branches are created and nothing is checked out.
 */
export async function fetchPullRequest(
  folder: string,
  remote: string,
  prNumber: number,
  options: { shas?: string[]; signal?: AbortSignal } = {},
): Promise<void> {
  const args = pullRequestFetchArgs(remote, prNumber, options.shas);
  await git(["-C", folder, ...args], 300_000, options.signal);
}

function git(args: string[], timeout: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      "git",
      args,
      {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout,
        signal,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr.trim() || err.message));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}
