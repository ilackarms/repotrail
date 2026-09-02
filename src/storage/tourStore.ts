import * as crypto from "node:crypto";
import type { Dirent } from "node:fs";
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
 * and extension reinstalls so the user can resume any tour they've taken.
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

export interface TourSummary {
  id: string;
  title: string;
  kind: string;
  stepCount: number;
  lastIndex: number;
  createdAt: number;
  updatedAt: number;
}

export interface SavedTourRecordFile {
  path: string;
  archived: boolean;
  record: TourRecord;
}

function workspaceDir(workspaceRoot: string): string {
  const hash = crypto.createHash("sha1").update(workspaceRoot).digest("hex").slice(0, 16);
  return path.join(ROOT, hash);
}

export async function saveTour(record: TourRecord): Promise<void> {
  const dir = workspaceDir(record.workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${record.id}.json`);
  // Atomic write: tmp file + rename. fs.writeFile uses O_TRUNC which exposes
  // a half-written file mid-flight; if listTours reads during that window
  // JSON.parse fails and the record vanishes from the resume list.
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  await fs.writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export async function listTours(workspaceRoot: string): Promise<TourSummary[]> {
  const dir = workspaceDir(workspaceRoot);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const summaries: TourSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry), "utf8");
      const r = JSON.parse(raw) as TourRecord;
      summaries.push({
        id: r.id,
        title: r.plan.title,
        kind: r.plan.kind,
        stepCount: r.plan.steps.length,
        lastIndex: r.lastIndex,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      });
    } catch {
      /* skip unparseable */
    }
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}

export async function listAllTourRecords(): Promise<SavedTourRecordFile[]> {
  const files = await listJsonFiles(ROOT);
  const records: SavedTourRecordFile[] = [];
  for (const file of files) {
    try {
      const raw = await fs.readFile(file, "utf8");
      const record = JSON.parse(raw) as TourRecord;
      if (!isTourRecord(record)) continue;
      records.push({
        path: file,
        archived: path.relative(ROOT, file).split(path.sep).some((part) => part.startsWith("archive-")),
        record,
      });
    } catch {
      /* skip unparseable */
    }
  }
  records.sort((a, b) => b.record.updatedAt - a.record.updatedAt);
  return records;
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

async function listJsonFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listJsonFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(full);
    }
  }
  return files;
}

function isTourRecord(value: unknown): value is TourRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as TourRecord;
  return (
    typeof record.id === "string" &&
    typeof record.workspaceRoot === "string" &&
    typeof record.createdAt === "number" &&
    typeof record.updatedAt === "number" &&
    Boolean(record.plan) &&
    typeof record.plan.title === "string" &&
    Array.isArray(record.plan.steps)
  );
}
