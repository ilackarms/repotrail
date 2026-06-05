import * as path from "node:path";
import * as vscode from "vscode";
import { currentWorkspaceFolders, workspaceFolderInfos, WorkspaceFolderInfo } from "../workspace";

/**
 * Minimal repo analysis surface. MVP just lists workspace files via the
 * VS Code FS API so the engine has something to reason about.
 *
 * TODO(analysis):
 *   - ripgrep symbol/keyword search
 *   - git diff parsing for PR-mode tours
 *   - Tree-sitter / LSP semantic indexing
 *   - call graph + dependency mapping
 */

export interface RepoContext {
  workspaceRoot: string;
  files: string[];
  supportsMultiRoot: boolean;
  workspaceFolders: Array<WorkspaceFolderInfo & { files: string[] }>;
}

const DEFAULT_EXCLUDES = "**/{node_modules,out,dist,.git,.next,.venv,target}/**";

export async function gatherRepoContext(maxFiles = 500): Promise<RepoContext | null> {
  const folders = currentWorkspaceFolders();
  if (folders.length === 0) return null;

  const perFolderLimit = Math.max(1, Math.floor(maxFiles / folders.length));
  const infos = workspaceFolderInfos(folders);
  const workspaceFolders: RepoContext["workspaceFolders"] = [];

  for (let i = 0; i < folders.length; i++) {
    const folder = folders[i];
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, "**/*"),
      DEFAULT_EXCLUDES,
      perFolderLimit,
    );
    const files = uris
      .map((u) => path.relative(folder.uri.fsPath, u.fsPath).replace(/\\/g, "/"))
      .sort();
    workspaceFolders.push({ ...infos[i], files });
  }

  return {
    workspaceRoot: folders[0].uri.fsPath,
    files: workspaceFolders[0]?.files ?? [],
    supportsMultiRoot: true,
    workspaceFolders,
  };
}
