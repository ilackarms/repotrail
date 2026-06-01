import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TourPlan } from "../engine/types";

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
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
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
