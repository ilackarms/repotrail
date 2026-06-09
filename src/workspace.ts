import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { TourPlan, TourRootRef, TourStep } from "./engine/types";

export interface WorkspaceFolderInfo {
  /** Stable value agents can copy into TourStep.workspaceFolder. */
  workspaceFolder: string;
  /** VS Code's display name for the folder. */
  name: string;
  /** Absolute local path for verification and registry lookup. */
  path: string;
}

export function currentWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
  return vscode.workspace.workspaceFolders ?? [];
}

export function hasWorkspaceFolders(): boolean {
  return currentWorkspaceFolders().length > 0;
}

export function firstWorkspaceRoot(): string | undefined {
  return currentWorkspaceFolders()[0]?.uri.fsPath;
}

export function currentWorkspaceStorageRoot(): string {
  const folders = currentWorkspaceFolders();
  if (folders.length === 0) return "_no_workspace";
  if (folders.length === 1) return folders[0].uri.fsPath;
  const names = folders.map((f) => f.name).join("+");
  return `window:${workspaceFoldersHash(folders)}:${names}`;
}

export function currentWorkspaceRegistryKeys(): string[] {
  const folders = currentWorkspaceFolders();
  if (folders.length === 0) return ["_no_workspace"];
  const keys = folders.map((f) => f.uri.fsPath);
  if (folders.length > 1) keys.push(workspaceWindowRegistryKey(folders));
  return [...new Set(keys)];
}

export function workspaceWindowRegistryKey(
  folders: readonly vscode.WorkspaceFolder[] = currentWorkspaceFolders(),
): string {
  return `window:${workspaceFoldersHash(folders)}`;
}

export function workspaceFolderInfos(
  folders: readonly vscode.WorkspaceFolder[] = currentWorkspaceFolders(),
): WorkspaceFolderInfo[] {
  return folders.map((folder) => ({
    workspaceFolder: workspaceFolderIdentity(folder, folders),
    name: folder.name,
    path: folder.uri.fsPath,
  }));
}

export function workspaceFolderIdentity(
  folder: vscode.WorkspaceFolder,
  folders: readonly vscode.WorkspaceFolder[] = currentWorkspaceFolders(),
): string {
  const sameNameCount = folders.filter((f) => f.name === folder.name).length;
  return sameNameCount === 1 ? folder.name : folder.uri.fsPath;
}

export function normalizeTourStepTarget(
  file: string,
  workspaceFolder?: string,
): { file: string; workspaceFolder?: string } {
  const normalizedFile = normalizeWorkspaceFile(file);
  const normalizedFolder = normalizeWorkspaceFolderRef(workspaceFolder);
  return normalizedFolder
    ? { file: normalizedFile, workspaceFolder: normalizedFolder }
    : { file: normalizedFile };
}

export function normalizeWorkspaceFile(file: string): string {
  if (!file || file.includes("\0")) {
    throw new Error("Tour step file must be a non-empty workspace-relative path.");
  }
  const normalized = file.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error("Tour step file must be workspace-relative, not absolute.");
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0 || parts.includes("..")) {
    throw new Error("Tour step file cannot escape the workspace.");
  }
  return parts.join("/");
}

export function normalizeWorkspaceFolderRef(workspaceFolder?: string): string | undefined {
  if (!workspaceFolder) return undefined;
  const folder = resolveWorkspaceFolderRef(workspaceFolder);
  if (!folder) {
    const choices = workspaceFolderInfos().map((f) => `${f.workspaceFolder} (${f.path})`).join(", ");
    throw new Error(`Tour step workspaceFolder must match an open VS Code workspace folder: ${choices || "none"}.`);
  }
  const folders = currentWorkspaceFolders();
  return folders.length > 1 ? workspaceFolderIdentity(folder, folders) : undefined;
}

export function resolveWorkspaceFolderRef(workspaceFolder?: string): vscode.WorkspaceFolder | null {
  const folders = currentWorkspaceFolders();
  if (folders.length === 0) return null;
  if (!workspaceFolder) return folders[0];

  const byIdentity = folders.find((f) => workspaceFolderIdentity(f, folders) === workspaceFolder);
  if (byIdentity) return byIdentity;

  const byPath = folders.find((f) => sameFsPath(f.uri.fsPath, workspaceFolder));
  if (byPath) return byPath;

  const byName = folders.filter((f) => f.name === workspaceFolder);
  return byName.length === 1 ? byName[0] : null;
}

export function resolveTourRootRef(ref?: TourRootRef): vscode.WorkspaceFolder | null {
  if (!ref) return null;
  const directRefs = [ref.workspaceFolder, ref.name, ref.path].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  for (const value of directRefs) {
    const folder = resolveWorkspaceFolderRef(value);
    if (folder) return folder;
  }
  return ref.pathHint ? resolveWorkspaceFolderPathHint(ref.pathHint) : null;
}

export function resolveStepWorkspaceFolder(step: Pick<TourStep, "workspaceFolder" | "root">, plan?: TourPlan): vscode.WorkspaceFolder | null {
  if (step.workspaceFolder) return resolveWorkspaceFolderRef(step.workspaceFolder);
  if (step.root && plan?.roots) return resolveTourRootRef(plan.roots[step.root]);
  if (step.root) return null;
  return resolveWorkspaceFolderRef();
}

export function resolveTourPlanRoots(plan: TourPlan): TourPlan {
  if (!plan.roots) return plan;
  const folders = currentWorkspaceFolders();
  if (folders.length === 0) return plan;

  let changed = false;
  const steps = plan.steps.map((step) => {
    if (!step.root || step.workspaceFolder) return step;
    const folder = resolveTourRootRef(plan.roots?.[step.root]);
    if (!folder) return step;
    changed = true;
    return {
      ...step,
      workspaceFolder: folders.length > 1 ? workspaceFolderIdentity(folder, folders) : undefined,
    };
  });

  return changed ? { ...plan, steps } : plan;
}

export function resolveStepUri(step: Pick<TourStep, "file" | "workspaceFolder">): vscode.Uri | null {
  const keyedStep = step as Pick<TourStep, "file" | "workspaceFolder" | "root">;
  const folder = resolveStepWorkspaceFolder(keyedStep);
  if (!folder) return null;
  const file = normalizeWorkspaceFile(step.file);
  return vscode.Uri.joinPath(folder.uri, ...file.split("/"));
}

export function relativePathInWorkspace(
  uri: vscode.Uri,
): { file: string; workspaceFolder?: string } | null {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return null;
  const rel = path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, "/");
  const file = normalizeWorkspaceFile(rel);
  const folders = currentWorkspaceFolders();
  return folders.length > 1
    ? { file, workspaceFolder: workspaceFolderIdentity(folder, folders) }
    : { file };
}

function workspaceFoldersHash(folders: readonly vscode.WorkspaceFolder[]): string {
  const paths = folders.map((f) => f.uri.fsPath).sort().join("\n");
  return crypto.createHash("sha1").update(paths).digest("hex").slice(0, 16);
}

function resolveWorkspaceFolderPathHint(pathHint: string): vscode.WorkspaceFolder | null {
  const hint = pathHint.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!hint) return null;
  const folders = currentWorkspaceFolders();
  const byExactPath = folders.find((f) => sameFsPath(f.uri.fsPath, hint));
  if (byExactPath) return byExactPath;

  const hintBase = path.basename(hint);
  const byName = folders.filter((f) => f.name === hint || f.name === hintBase);
  if (byName.length === 1) return byName[0];

  const suffix = `/${hint}`;
  const bySuffix = folders.filter((f) => f.uri.fsPath.replace(/\\/g, "/").endsWith(suffix));
  return bySuffix.length === 1 ? bySuffix[0] : null;
}

function sameFsPath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}
