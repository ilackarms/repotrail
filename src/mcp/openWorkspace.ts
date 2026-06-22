import * as path from "node:path";

export interface OpenWorkspaceInput {
  path: string;
  newWindow?: boolean;
}

export interface NormalizedOpenWorkspaceInput {
  path: string;
  forceNewWindow: boolean;
}

export function normalizeOpenWorkspaceInput(input: OpenWorkspaceInput): NormalizedOpenWorkspaceInput {
  const rawPath = typeof input.path === "string" ? input.path.trim() : "";
  if (!rawPath) {
    throw new Error("open_workspace path must be a non-empty absolute local path.");
  }
  if (!path.isAbsolute(rawPath)) {
    throw new Error("open_workspace path must be an absolute local path.");
  }
  return {
    path: path.resolve(rawPath),
    forceNewWindow: input.newWindow ?? true,
  };
}
