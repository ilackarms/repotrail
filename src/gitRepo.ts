import * as childProcess from "node:child_process";
import { normalizeGitRef } from "./gitBlob";
import { GitRemote, parseGitRemoteVerbose } from "./github/remotes";

/**
 * Git calls for importing a tour from a pull request. Everything here runs
 * through execFile with fixed argument lists, never a shell. `fetchPullRequest`
 * is the only call that writes to the repository (objects and FETCH_HEAD),
 * and callers ask the user before running it.
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
