import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseTourJson } from "../engine/tourSerialize";
import { TourPlan } from "../engine/types";

/**
 * Tours committed into the repository under `<root>/.repotrail/*.json`.
 *
 * This is the team-artifact path: a senior dev generates a tour, saves it here,
 * and `git commit`s it. Anyone who clones the repo sees it in the Start tab and
 * can replay it. Files use the same export envelope as `repoTrail.exportTour`,
 * so an exported `.json` can simply be dropped into `.repotrail/`.
 *
 * The extension never runs git — committing (whether and when) is entirely the
 * user's call. We only read and write files inside the folder.
 */

export const REPO_TOURS_DIR = ".repotrail";

export interface RepoTourRoot {
  rootPath: string;
  workspaceFolder?: string;
  workspaceName?: string;
}

export interface RepoTourSummary {
  /** Stable UI key: absolute root path + filename. */
  key: string;
  /** Filename within .repotrail/ (e.g. "architecture.json"). */
  file: string;
  /** Absolute path of the workspace root that owns this .repotrail/ file. */
  rootPath: string;
  /** VS Code workspace folder identity, when available. */
  workspaceFolder?: string;
  /** VS Code display name, when available. */
  workspaceName?: string;
  title: string;
  kind: string;
  stepCount: number;
}

function dir(workspaceRoot: string): string {
  return path.join(workspaceRoot, REPO_TOURS_DIR);
}

export async function listRepoTours(roots: RepoTourRoot[]): Promise<RepoTourSummary[]> {
  const nested = await Promise.all(roots.map((root) => listRepoToursInRoot(root)));
  const out = nested.flat();
  out.sort((a, b) => {
    const aRoot = a.workspaceName ?? a.workspaceFolder ?? a.rootPath;
    const bRoot = b.workspaceName ?? b.workspaceFolder ?? b.rootPath;
    return aRoot.localeCompare(bRoot) || a.title.localeCompare(b.title) || a.file.localeCompare(b.file);
  });
  return out;
}

async function listRepoToursInRoot(root: RepoTourRoot): Promise<RepoTourSummary[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir(root.rootPath));
  } catch {
    return [];
  }
  const out: RepoTourSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir(root.rootPath), entry), "utf8");
      const plan = parseTourJson(raw);
      if (!plan) continue;
      out.push({
        key: `${root.rootPath}\0${entry}`,
        file: entry,
        rootPath: root.rootPath,
        workspaceFolder: root.workspaceFolder,
        workspaceName: root.workspaceName,
        title: plan.title,
        kind: plan.kind,
        stepCount: plan.steps.length,
      });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

export async function readRepoTour(workspaceRoot: string, file: string): Promise<TourPlan | null> {
  // Guard against path traversal — only accept a bare filename in .repotrail/.
  const safe = path.basename(file);
  try {
    const raw = await fs.readFile(path.join(dir(workspaceRoot), safe), "utf8");
    return parseTourJson(raw);
  } catch {
    return null;
  }
}

/** Write a tour into the repo folder. Returns the absolute path written. */
export async function saveRepoTour(
  workspaceRoot: string,
  slug: string,
  content: string,
): Promise<string> {
  const d = dir(workspaceRoot);
  await fs.mkdir(d, { recursive: true });
  const safe = path.basename(slug).replace(/\.json$/i, "") || "tour";
  const file = path.join(d, `${safe}.json`);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, file);
  return file;
}

export async function saveRepoTourUnique(
  workspaceRoot: string,
  slug: string,
  content: string,
): Promise<string> {
  const d = dir(workspaceRoot);
  await fs.mkdir(d, { recursive: true });
  const base = path.basename(slug).replace(/\.json$/i, "") || "tour";
  for (let i = 0; i < 1000; i++) {
    const suffix = i === 0 ? "" : `-${i + 1}`;
    const file = path.join(d, `${base}${suffix}.json`);
    if (await exists(file)) continue;
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, file);
    return file;
  }
  throw new Error(`Could not find an unused ${REPO_TOURS_DIR}/${base}.json filename.`);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
