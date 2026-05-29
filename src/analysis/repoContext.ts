import * as vscode from "vscode";

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
}

const DEFAULT_EXCLUDES = "**/{node_modules,out,dist,.git,.next,.venv,target}/**";

export async function gatherRepoContext(maxFiles = 500): Promise<RepoContext | null> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return null;

  const uris = await vscode.workspace.findFiles("**/*", DEFAULT_EXCLUDES, maxFiles);
  const root = folder.uri.fsPath;
  const files = uris.map((u) => vscode.workspace.asRelativePath(u, false)).sort();

  return { workspaceRoot: root, files };
}
