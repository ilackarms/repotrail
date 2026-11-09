/**
 * Pure folder tree of the files a tour visits, for the Tour Files view.
 * Folders come first, then files, each alphabetical (explorer order), and
 * single-child folder chains are compacted ("src/ux") like VS Code's explorer.
 */

export interface TourFileEntry {
  /** Stop index in the tour. */
  index: number;
  /** Normalized workspace-relative path, `/`-separated. */
  file: string;
  /** Identity of the workspace root the file lives in. */
  rootKey: string;
  /** Display name of that root; only shown when the tour spans several roots. */
  rootLabel: string;
}

export interface TourFolderNode {
  kind: "folder";
  id: string;
  label: string;
  children: TourTreeNode[];
}

export interface TourFileNode {
  kind: "file";
  id: string;
  label: string;
  rootKey: string;
  file: string;
  /** Stop indices in this file, in tour order. */
  stops: number[];
}

export type TourTreeNode = TourFolderNode | TourFileNode;

export function buildTourFileTree(entries: readonly TourFileEntry[]): TourTreeNode[] {
  const roots = new Map<string, { label: string; entries: TourFileEntry[] }>();
  for (const entry of entries) {
    const root = roots.get(entry.rootKey) ?? { label: entry.rootLabel, entries: [] };
    root.entries.push(entry);
    roots.set(entry.rootKey, root);
  }

  const trees = [...roots].map(([rootKey, root]) => ({
    rootKey,
    label: root.label,
    children: compact(buildRoot(rootKey, root.entries)),
  }));
  if (trees.length === 1) return trees[0].children;
  return trees
    .sort((a, b) => compareLabels(a.label, b.label))
    .map((t) => ({ kind: "folder", id: `root:${t.rootKey}`, label: t.label, children: t.children }));
}

interface MutableFolder {
  kind: "folder";
  id: string;
  label: string;
  folders: Map<string, MutableFolder>;
  files: Map<string, TourFileNode>;
}

function buildRoot(rootKey: string, entries: readonly TourFileEntry[]): TourTreeNode[] {
  const top: MutableFolder = { kind: "folder", id: `root:${rootKey}`, label: "", folders: new Map(), files: new Map() };
  for (const entry of entries) {
    const parts = entry.file.split("/").filter(Boolean);
    const name = parts.pop();
    if (!name) continue;
    let folder = top;
    for (const part of parts) {
      let next = folder.folders.get(part);
      if (!next) {
        next = { kind: "folder", id: `${folder.id}/${part}`, label: part, folders: new Map(), files: new Map() };
        folder.folders.set(part, next);
      }
      folder = next;
    }
    const existing = folder.files.get(name);
    if (existing) {
      existing.stops.push(entry.index);
    } else {
      folder.files.set(name, {
        kind: "file",
        id: `file:${rootKey}/${entry.file}`,
        label: name,
        rootKey,
        file: entry.file,
        stops: [entry.index],
      });
    }
  }
  return freeze(top);
}

function freeze(folder: MutableFolder): TourTreeNode[] {
  const folders: TourFolderNode[] = [...folder.folders.values()]
    .sort((a, b) => compareLabels(a.label, b.label))
    .map((f) => ({ kind: "folder", id: f.id, label: f.label, children: freeze(f) }));
  const files = [...folder.files.values()].sort((a, b) => compareLabels(a.label, b.label));
  for (const file of files) file.stops.sort((a, b) => a - b);
  return [...folders, ...files];
}

/** Merge folders that contain exactly one folder and nothing else. */
function compact(nodes: TourTreeNode[]): TourTreeNode[] {
  return nodes.map((node) => {
    if (node.kind === "file") return node;
    let current = node;
    while (current.children.length === 1 && current.children[0].kind === "folder") {
      const only = current.children[0];
      current = { kind: "folder", id: only.id, label: `${current.label}/${only.label}`, children: only.children };
    }
    return { ...current, children: compact(current.children) };
  });
}

function compareLabels(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}
