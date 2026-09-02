import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TourPlan } from "../engine/types";
import type { RepoTourSource } from "./repoTours";

/**
 * Per-workspace tour persistence at ~/.repotrail/tours/<workspace-hash>/<id>.json
 *
 * Workspace path is hashed for a stable, FS-safe directory name; the raw path
 * is stored inside the record for traceability. Records persist across reloads
 * and extension reinstalls so the most recently active tour can be restored.
 */

const ROOT = path.join(os.homedir(), ".repotrail", "tours");

export interface TourRecord {
  id: string;
  workspaceRoot: string;
  createdAt: number;
  updatedAt: number;
  lastIndex: number;
  plan: TourPlan;
  /** Repo-local JSON source, when this record caches a shared tour. */
  repoTourSource?: RepoTourSource;
  /** Indices the user has visited ("understood"), for route dimming. */
  seen?: number[];
}

function workspaceDir(workspaceRoot: string): string {
  const hash = crypto.createHash("sha1").update(workspaceRoot).digest("hex").slice(0, 16);
  return path.join(ROOT, hash);
}

export async function saveTour(record: TourRecord): Promise<void> {
  const dir = workspaceDir(record.workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${record.id}.json`);
  // Atomic write: tmp file + rename avoids exposing a half-written progress
  // record if VS Code reloads during a save.
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  await fs.writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export async function loadTour(workspaceRoot: string, id: string): Promise<TourRecord | null> {
  const file = path.join(workspaceDir(workspaceRoot), `${id}.json`);
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as TourRecord;
  } catch {
    return null;
  }
}

export async function deleteTour(workspaceRoot: string, id: string): Promise<boolean> {
  const file = path.join(workspaceDir(workspaceRoot), `${id}.json`);
  try {
    await fs.rm(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function newTourId(): string {
  return `t_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

export function repoTourProgressId(source: RepoTourSource): string {
  const key = `${path.resolve(source.rootPath)}\0${path.basename(source.file)}`;
  const hash = crypto.createHash("sha1").update(key).digest("hex").slice(0, 24);
  return `repo_${hash}`;
}
