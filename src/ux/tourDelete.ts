import * as path from "node:path";
import * as vscode from "vscode";
import { listRepoTours, REPO_TOURS_DIR, RepoTourRoot, RepoTourSource } from "../storage/repoTours";
import { repoTourProgressId } from "../storage/tourStore";
import { currentWorkspaceStorageRoot } from "../workspace";
import { plainMessageText } from "./messageText";
import type { TourController } from "./tourController";

/**
 * "RepoTrail: Delete Tour…": move a repo tour's `.repotrail/<file>.json` to
 * the trash and forget its progress. With no argument it deletes the active
 * repo tour, or asks which repo tour to delete.
 */

export interface DeleteTourDeps {
  controller: TourController;
  log: vscode.OutputChannel;
  roots: () => RepoTourRoot[];
  refresh: () => void;
  /** Delete a progress record after any pending save of it. */
  forgetProgress: (workspaceRoot: string, id: string) => Promise<void>;
}

const MOVE_TO_TRASH = "Move to Trash";
const DELETE_PERMANENTLY = "Delete Permanently";

export async function deleteTourCommand(
  arg: { rootPath?: string; file?: string } | undefined,
  deps: DeleteTourDeps,
): Promise<void> {
  const target = await chooseTarget(arg, deps);
  if (!target) return;
  const relative = `${REPO_TOURS_DIR}/${target.file}`;
  const folderName = target.workspaceName ?? path.basename(target.rootPath);
  const confirm = await vscode.window.showWarningMessage(
    `Delete the tour "${plainMessageText(target.title, 120)}"?`,
    {
      modal: true,
      detail: `RepoTrail moves ${relative} in ${folderName} to the trash and forgets your progress in it. If the file is committed, the deletion shows up in git like any other change.`,
    },
    MOVE_TO_TRASH,
  );
  if (confirm !== MOVE_TO_TRASH) return;

  const { controller } = deps;
  const source: RepoTourSource = { rootPath: target.rootPath, file: target.file };
  const uri = vscode.Uri.file(path.join(target.rootPath, REPO_TOURS_DIR, target.file));
  if (!(await deleteFile(uri, relative, deps.log))) {
    deps.refresh();
    return;
  }
  // Read these before stop() clears them.
  const active = sameSource(controller.activeRepoTourSource, source);
  const storageRoot = (active ? controller.activeWorkspaceRoot : null) ?? currentWorkspaceStorageRoot();
  const progressId = (active ? controller.activeTourId : null) ?? repoTourProgressId(source);
  // The file watcher's "active tour file was deleted" path waits 150 ms and
  // drops out once the source is forgotten here, so it doesn't also fire.
  if (active) controller.stop({ forgetRepoSource: true });
  await deps.forgetProgress(storageRoot, progressId);
  deps.log.appendLine(`[repo-tour] deleted ${uri.fsPath}`);
  deps.refresh();
  vscode.window.setStatusBarMessage(`RepoTrail: deleted ${relative}.`, 4000);
}

async function deleteFile(uri: vscode.Uri, relative: string, log: vscode.OutputChannel): Promise<boolean> {
  try {
    await vscode.workspace.fs.delete(uri, { useTrash: true });
    return true;
  } catch (err) {
    // Already gone (deleted since it was listed): nothing left to delete.
    if (err instanceof vscode.FileSystemError && err.code === "FileNotFound") return true;
    log.appendLine(`[repo-tour] couldn't move ${uri.fsPath} to the trash: ${String(err)}`);
  }
  const pick = await vscode.window.showWarningMessage(
    `RepoTrail couldn't move ${relative} to the trash.`,
    { modal: true, detail: "Delete it permanently instead? This can't be undone." },
    DELETE_PERMANENTLY,
  );
  if (pick !== DELETE_PERMANENTLY) return false;
  try {
    await vscode.workspace.fs.delete(uri, { useTrash: false });
    return true;
  } catch (err) {
    log.appendLine(`[repo-tour] couldn't delete ${uri.fsPath}: ${String(err)}`);
    vscode.window.showErrorMessage(`RepoTrail: couldn't delete ${relative}. ${plainMessageText(String(err))}`);
    return false;
  }
}

interface Target {
  rootPath: string;
  file: string;
  title: string;
  workspaceName?: string;
}

async function chooseTarget(
  arg: { rootPath?: string; file?: string } | undefined,
  deps: DeleteTourDeps,
): Promise<Target | undefined> {
  const roots = deps.roots();
  const tours = await listRepoTours(roots);
  const find = (source: { rootPath: string; file: string }) =>
    tours.find((t) => samePath(t.rootPath, source.rootPath) && t.file === source.file);

  if (arg?.rootPath && arg.file) {
    // Only files RepoTrail lists: a basename in an open root's .repotrail/.
    const found = path.basename(arg.file) === arg.file ? find({ rootPath: arg.rootPath, file: arg.file }) : undefined;
    if (!found) {
      vscode.window.showErrorMessage(`RepoTrail: ${REPO_TOURS_DIR}/${plainMessageText(arg.file)} isn't a tour in an open folder.`);
      deps.refresh();
      return undefined;
    }
    return found;
  }

  const active = deps.controller.activeRepoTourSource;
  if (active) {
    // The active tour's file may not be listed (invalid JSON mid-edit); it is
    // still the one the menu item means.
    return find(active) ?? { ...active, title: deps.controller.snapshot().plan?.title ?? active.file };
  }
  if (deps.controller.snapshot().plan && !active) {
    const pick = await vscode.window.showInformationMessage(
      `RepoTrail: the open tour isn't saved in ${REPO_TOURS_DIR}/, so there's no file to delete. Close it instead?`,
      "Close Tour",
    );
    if (pick === "Close Tour") deps.controller.stop();
    return undefined;
  }
  if (tours.length === 0) {
    vscode.window.showInformationMessage(`RepoTrail: no ${REPO_TOURS_DIR}/*.json tours in the open folders.`);
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    tours.map((t) => ({
      label: t.title || "(untitled)",
      description: `${t.workspaceName ?? path.basename(t.rootPath)} · ${REPO_TOURS_DIR}/${t.file}`,
      tour: t,
    })),
    { title: "Delete a RepoTrail tour", placeHolder: "Tour to move to the trash", ignoreFocusOut: true },
  );
  return pick?.tour;
}

function sameSource(a: RepoTourSource | null, b: RepoTourSource): boolean {
  return Boolean(a && samePath(a.rootPath, b.rootPath) && a.file === b.file);
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}
