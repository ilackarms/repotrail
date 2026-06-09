import * as childProcess from "node:child_process";
import * as path from "node:path";
import { normalizeWorkspaceFile } from "./workspace";

export interface GitBlobResult {
  text: string;
  missing: boolean;
  gitPath: string;
}

interface GitExecResult {
  stdout: string;
  stderr: string;
}

const MAX_GIT_BLOB_BYTES = 20 * 1024 * 1024;

export async function readGitBlobText(
  workspaceRoot: string,
  ref: string,
  file: string,
): Promise<GitBlobResult> {
  const safeRef = normalizeGitRef(ref);
  const workspaceFile = normalizeWorkspaceFile(file);
  const gitRoot = (await git(["-C", workspaceRoot, "rev-parse", "--show-toplevel"])).stdout.trim();
  if (!gitRoot) {
    throw new Error("Could not find the git repository root.");
  }

  await git(["-C", gitRoot, "rev-parse", "--verify", "--quiet", `${safeRef}^{commit}`]);
  const gitPath = toGitRelativePath(gitRoot, workspaceRoot, workspaceFile);
  try {
    const out = await git(["-C", gitRoot, "show", "--textconv", `${safeRef}:${gitPath}`]);
    return { text: out.stdout, missing: false, gitPath };
  } catch (err) {
    if (isMissingPathError(err)) {
      return { text: "", missing: true, gitPath };
    }
    throw err;
  }
}

function normalizeGitRef(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.startsWith("-") || /[\0\r\n:]/.test(trimmed)) {
    throw new Error("Git ref must be a non-empty commit-ish without ':' or newlines.");
  }
  return trimmed;
}

function toGitRelativePath(gitRoot: string, workspaceRoot: string, file: string): string {
  const absolute = path.resolve(workspaceRoot, file);
  const rel = path.relative(gitRoot, absolute).replace(/\\/g, "/");
  if (!rel || rel.startsWith("../") || rel === ".." || path.isAbsolute(rel)) {
    throw new Error("Tour step file must stay inside the git repository.");
  }
  return rel;
}

function git(args: string[]): Promise<GitExecResult> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      "git",
      args,
      {
        encoding: "utf8",
        maxBuffer: MAX_GIT_BLOB_BYTES,
        timeout: 10_000,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new GitCommandError(args, stdout, stderr, err));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function isMissingPathError(err: unknown): boolean {
  if (!(err instanceof GitCommandError)) return false;
  return /path .* does not exist|exists on disk, but not in|invalid object name/i.test(err.stderr);
}

class GitCommandError extends Error {
  constructor(
    readonly args: string[],
    readonly stdout: string,
    readonly stderr: string,
    cause: Error,
  ) {
    super(stderr.trim() || cause.message);
  }
}
