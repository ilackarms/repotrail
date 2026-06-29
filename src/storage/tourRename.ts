import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseTourJson } from "../engine/tourSerialize";
import { TourPlan } from "../engine/types";
import { REPO_TOURS_DIR } from "./repoTours";
import { loadTour, saveTour, TourRecord } from "./tourStore";

export function validateTourTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) throw new Error("RepoTrail: tour title must be non-empty.");
  return trimmed;
}

export function renameTourRecordTitle(
  record: TourRecord,
  title: string,
  updatedAt = Date.now(),
): TourRecord {
  return {
    ...record,
    updatedAt,
    plan: {
      ...record.plan,
      title: validateTourTitle(title),
    },
  };
}

export async function renameSavedTourTitle(
  workspaceRoot: string,
  id: string,
  title: string,
): Promise<TourRecord | null> {
  const record = await loadTour(workspaceRoot, id);
  if (!record) return null;
  const renamed = renameTourRecordTitle(record, title);
  await saveTour(renamed);
  return renamed;
}

export async function renameRepoTourTitle(
  workspaceRoot: string,
  file: string,
  title: string,
): Promise<TourPlan> {
  const nextTitle = validateTourTitle(title);
  const safe = path.basename(file);
  const target = path.join(workspaceRoot, REPO_TOURS_DIR, safe);
  const rawText = await fs.readFile(target, "utf8");
  const plan = parseTourJson(rawText);
  if (!plan) throw new Error(`RepoTrail: ${REPO_TOURS_DIR}/${safe} isn't a valid tour.`);

  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    throw new Error(`RepoTrail: ${REPO_TOURS_DIR}/${safe} isn't valid JSON.`);
  }
  if (!setRawTourTitle(raw, nextTitle)) {
    throw new Error(`RepoTrail: ${REPO_TOURS_DIR}/${safe} isn't a writable tour shape.`);
  }

  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
  await fs.writeFile(tmp, JSON.stringify(raw, null, 2), "utf8");
  await fs.rename(tmp, target);
  return { ...plan, title: nextTitle };
}

function setRawTourTitle(raw: unknown, title: string): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  if (isPlanLike(obj.plan)) {
    (obj.plan as Record<string, unknown>).title = title;
    return true;
  }
  if (isPlanLike(obj)) {
    obj.title = title;
    return true;
  }
  return false;
}

function isPlanLike(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Array.isArray((value as Record<string, unknown>).steps),
  );
}
