import * as vscode from "vscode";
import { formatStepPath, TourPlan, TourStep } from "../engine/types";
import { normalizeWorkspaceFile, resolveStepUri, resolveStepWorkspaceFolder } from "../workspace";
import { TourController } from "./tourController";
import { buildTourFileTree, TourFileEntry, TourTreeNode } from "./tourFileTree";

/**
 * "Tour Files" tree under the Tour panel: the files the active tour visits,
 * as a folder tree, with the current file and stop selected as you navigate.
 * Expand a file to see its stops; click a file or stop to jump there.
 */

interface FolderItem {
  kind: "folder";
  id: string;
  label: string;
  parent?: ViewNode;
  children: ViewNode[];
}

interface FileItem {
  kind: "file";
  id: string;
  label: string;
  file: string;
  uri?: vscode.Uri;
  stops: number[];
  parent?: ViewNode;
  children: StopItem[];
}

interface StopItem {
  kind: "stop";
  id: string;
  index: number;
  parent: FileItem;
}

type ViewNode = FolderItem | FileItem | StopItem;

export class TourFilesProvider implements vscode.TreeDataProvider<ViewNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ViewNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private roots: ViewNode[] = [];
  private stopNodes = new Map<number, StopItem>();
  private view: vscode.TreeView<ViewNode> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly controller: TourController) {
    this.rebuild();
    this.disposables.push(
      controller.onDidChange(() => {
        this.rebuild();
        this.emitter.fire(undefined);
        this.revealCurrent();
      }),
    );
  }

  attach(view: vscode.TreeView<ViewNode>): void {
    this.view = view;
    this.disposables.push(view.onDidChangeVisibility((e) => e.visible && this.revealCurrent()));
  }

  dispose(): void {
    this.emitter.dispose();
    for (const d of this.disposables) d.dispose();
  }

  getChildren(node?: ViewNode): ViewNode[] {
    if (!node) return this.roots;
    return node.kind === "stop" ? [] : node.children;
  }

  getParent(node: ViewNode): ViewNode | undefined {
    return node.parent;
  }

  getTreeItem(node: ViewNode): vscode.TreeItem {
    const snap = this.controller.snapshot();
    if (node.kind === "folder") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = node.id;
      item.iconPath = vscode.ThemeIcon.Folder;
      return item;
    }

    if (node.kind === "file") {
      const isCurrent = node.stops.includes(snap.index);
      const item = new vscode.TreeItem(
        isCurrent ? { label: node.label, highlights: [[0, node.label.length]] } : node.label,
        isCurrent ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = node.id;
      item.resourceUri = node.uri;
      item.iconPath = vscode.ThemeIcon.File;
      const count = `${node.stops.length} stop${node.stops.length === 1 ? "" : "s"}`;
      item.description = isCurrent ? `current · ${count}` : count;
      item.tooltip = node.file;
      item.command = isCurrent
        ? { title: "Show current stop", command: "repoTrail.revealCurrent" }
        : { title: "Go to first stop in file", command: "repoTrail.showStep", arguments: [node.stops[0]] };
      return item;
    }

    const step = snap.plan?.steps[node.index];
    const title = step?.title ?? `Stop ${node.index + 1}`;
    const label = `${node.index + 1}. ${title}`;
    const isCurrent = node.index === snap.index;
    const item = new vscode.TreeItem(
      isCurrent ? { label, highlights: [[0, label.length]] } : label,
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = node.id;
    item.description = step?.range ? `L${step.range.startLine}` : undefined;
    item.tooltip = step ? `${title}\n${formatStepPath(step)}${step.range ? `:${step.range.startLine}` : ""}` : title;
    const drift = snap.drift[node.index];
    item.iconPath = isCurrent
      ? new vscode.ThemeIcon("arrow-right")
      : drift === "missing"
        ? new vscode.ThemeIcon("warning")
        : snap.seen.includes(node.index)
          ? new vscode.ThemeIcon("check")
          : new vscode.ThemeIcon("circle-outline");
    item.command = { title: "Go to stop", command: "repoTrail.showStep", arguments: [node.index] };
    return item;
  }

  private rebuild(): void {
    const { plan } = this.controller.snapshot();
    this.stopNodes.clear();
    if (!plan) {
      this.roots = [];
      return;
    }
    const entries = plan.steps.map((step, index) => fileEntry(step, index, plan));
    this.roots = buildTourFileTree(entries).map((node) => this.toViewNode(node, undefined, plan));
  }

  private toViewNode(node: TourTreeNode, parent: ViewNode | undefined, plan: TourPlan): ViewNode {
    if (node.kind === "folder") {
      const folder: FolderItem = { kind: "folder", id: node.id, label: node.label, parent, children: [] };
      folder.children = node.children.map((child) => this.toViewNode(child, folder, plan));
      return folder;
    }
    const firstStep = plan.steps[node.stops[0]];
    let uri: vscode.Uri | undefined;
    try {
      uri = (firstStep && resolveStepUri(firstStep, plan)) || undefined;
    } catch {
      uri = undefined;
    }
    const file: FileItem = {
      kind: "file",
      id: node.id,
      label: node.label,
      file: node.file,
      uri,
      stops: node.stops,
      parent,
      children: [],
    };
    file.children = node.stops.map((index) => {
      const stop: StopItem = { kind: "stop", id: `${node.id}#${index}`, index, parent: file };
      this.stopNodes.set(index, stop);
      return stop;
    });
    return file;
  }

  private revealCurrent(): void {
    if (!this.view?.visible) return;
    const node = this.stopNodes.get(this.controller.snapshot().index);
    if (!node) return;
    this.view.reveal(node, { select: true, focus: false, expand: false }).then(undefined, () => {});
  }
}

function fileEntry(step: TourStep, index: number, plan: TourPlan): TourFileEntry {
  const folder = resolveStepWorkspaceFolder(step, plan);
  let file = step.file;
  try {
    file = normalizeWorkspaceFile(step.file);
  } catch {
    // Keep the raw path; the stop still shows, and opening it reports the error.
  }
  const unresolved = step.root ?? step.workspaceFolder ?? "";
  return {
    index,
    file,
    rootKey: folder?.uri.toString() ?? `unresolved:${unresolved}`,
    rootLabel: folder?.name ?? (unresolved || "(unresolved root)"),
  };
}
