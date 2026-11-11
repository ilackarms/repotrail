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

/**
 * Resolve the folder a step reads from. In a single-folder window, a tour that
 * names only one root (one alias, or one legacy workspaceFolder) falls back to
 * that folder when the name matches nothing, so a tour written in `app-pr-12/`
 * still plays in a clone named `app/`. Tours naming several roots keep strict
 * matching, so one repo's stops never open another repo's paths. Multi-root
 * windows keep strict matching; see resolveTourPlanRoots for the import binding.
 */
export function resolveStepWorkspaceFolder(step: Pick<TourStep, "workspaceFolder" | "root">, plan?: TourPlan): vscode.WorkspaceFolder | null {
  if (step.workspaceFolder) return resolveWorkspaceFolderRef(step.workspaceFolder) ?? singleRootFallback(plan);
  if (step.root) return resolveTourRootRef(plan?.roots?.[step.root]) ?? singleRootFallback(plan);
  return resolveWorkspaceFolderRef();
}

export interface TourRootBindingOptions {
  /**
   * Absolute path of the open folder the tour was imported into, such as the
   * clone picked for a GitHub PR tour. Every step binds to it, whatever its
   * root alias or workspaceFolder says: an imported tour can't reach into
   * other open folders.
   */
  importFolder?: string;
}

/**
 * Pin steps to concrete workspace folder identities: all of them to the import
 * folder when there is one, otherwise multi-root steps whose alias resolves.
 * Single-folder windows otherwise need no rewrite; resolveStepWorkspaceFolder
 * handles their fallback.
 */
export function resolveTourPlanRoots(plan: TourPlan, options: TourRootBindingOptions = {}): TourPlan {
  const folders = currentWorkspaceFolders();
  const importFolder = options.importFolder
    ? folders.find((f) => sameFsPath(f.uri.fsPath, options.importFolder as string)) ?? null
    : null;
  if (importFolder) {
    const identity = workspaceFolderIdentity(importFolder, folders);
    return { ...plan, steps: plan.steps.map((step) => ({ ...step, workspaceFolder: identity })) };
  }
  if (folders.length < 2 || !plan.roots) return plan;

  let changed = false;
  const steps = plan.steps.map((step) => {
    if (!step.root || step.workspaceFolder) return step;
    const folder = resolveTourRootRef(plan.roots?.[step.root]);
    if (!folder) return step;
    changed = true;
    return { ...step, workspaceFolder: workspaceFolderIdentity(folder, folders) };
  });

  return changed ? { ...plan, steps } : plan;
}

export function resolveStepUri(
  step: Pick<TourStep, "file" | "workspaceFolder" | "root">,
  plan?: TourPlan,
): vscode.Uri | null {
  const folder = resolveStepWorkspaceFolder(step, plan);
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

/** The only open folder, when the plan names at most one root. */
function singleRootFallback(plan?: TourPlan): vscode.WorkspaceFolder | null {
  const folders = currentWorkspaceFolders();
  if (folders.length !== 1 || !plan) return null;
  const roots = new Set<string>();
  for (const step of plan.steps) {
    if (step.root) roots.add(`root:${step.root}`);
    else if (step.workspaceFolder) roots.add(`folder:${step.workspaceFolder}`);
  }
  return roots.size <= 1 ? folders[0] : null;
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
