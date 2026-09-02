import type { TourRecord } from "./tourStore";

export const ACTIVE_TOUR_STATE_KEY = "repoTrail.activeTour";

export interface ActiveTourRef {
  id: string;
  workspaceRoot: string;
}

export function activeTourRefForRecord(record: TourRecord): ActiveTourRef {
  return { id: record.id, workspaceRoot: record.workspaceRoot };
}

export function activeTourRefForWorkspace(value: unknown, workspaceRoot: string): ActiveTourRef | null {
  if (!value || typeof value !== "object") return null;
  const ref = value as Partial<ActiveTourRef>;
  if (typeof ref.id !== "string" || !ref.id) return null;
  if (ref.workspaceRoot !== workspaceRoot) return null;
  return { id: ref.id, workspaceRoot: ref.workspaceRoot };
}
