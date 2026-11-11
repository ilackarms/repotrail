import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * A PR import handed to another window. The window that got the review link
 * writes this, then opens the folder that should play the tour; the window on
 * that folder picks it up when it starts or gains focus. A file rather than
 * globalState: a window that is already open reads it the moment it gains
 * focus, whatever VS Code profile it uses. The request inside is re-validated
 * by the reader.
 */
export interface PendingImport {
  request: unknown;
  folder: string;
  at: number;
}

export const PENDING_IMPORT_FILE = path.join(os.homedir(), ".repotrail", "pending-pr-import.json");

export async function writePendingImport(value: PendingImport, file = PENDING_IMPORT_FILE): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
}

/** The pending import, or undefined when there is none or the file is unreadable. */
export async function readPendingImport(file = PENDING_IMPORT_FILE): Promise<PendingImport | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const value = JSON.parse(text) as Partial<PendingImport>;
    if (typeof value.folder !== "string" || typeof value.at !== "number" || !value.request) return undefined;
    return { request: value.request, folder: value.folder, at: value.at };
  } catch {
    return undefined;
  }
}

export async function clearPendingImport(file = PENDING_IMPORT_FILE): Promise<void> {
  await fs.rm(file, { force: true });
}
