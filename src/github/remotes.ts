/**
 * Map git remote URLs to github.com repositories. Pure: the git calls that
 * list remotes live in gitRepo.ts.
 */

import { isValidOwner, isValidRepoName } from "./prRef";

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

export interface GitRemote {
  name: string;
  url: string;
}

/**
 * Recognize github.com remotes in https, ssh (`ssh://` and scp-like
 * `git@github.com:`) and git:// forms, with or without `.git`.
 */
export function parseGitHubRemote(url: string): GitHubRepoRef | null {
  const trimmed = url.trim();
  let host: string;
  let repoPath: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    host = scp[1];
    repoPath = scp[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"].includes(parsed.protocol)) return null;
    host = parsed.hostname;
    repoPath = parsed.pathname;
  }
  host = host.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com" && host !== "ssh.github.com") return null;
  const parts = repoPath.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (!isValidOwner(owner) || !isValidRepoName(repo)) return null;
  return { owner, repo };
}

/** Parse `git remote -v` output into unique name/url pairs (fetch URLs only). */
export function parseGitRemoteVerbose(output: string): GitRemote[] {
  const remotes: GitRemote[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (match && !remotes.some((r) => r.name === match[1])) remotes.push({ name: match[1], url: match[2] });
  }
  return remotes;
}
