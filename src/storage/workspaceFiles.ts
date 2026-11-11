import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Where the RepoTrail skill saves review workspaces. */
export const WORKSPACE_REGISTRY_DIR = path.join(os.homedir(), ".repotrail", "workspaces");

/**
 * A `.code-workspace` file that has `folder` as one of its folders: one in
 * the skill's registry, or the `<folder>.code-workspace` beside it that the
 * PR setup prompt writes. Reopening that file switches to the window that
 * already has it open, where opening the bare folder would start a second
 * window. Single-folder workspaces win over multi-root ones.
 */
export async function workspaceFileFor(folder: string, registry = WORKSPACE_REGISTRY_DIR): Promise<string | undefined> {
  const target = path.resolve(folder);
  const candidates = [`${target}.code-workspace`];
  try {
    for (const name of (await fs.readdir(registry)).sort()) {
      if (name.endsWith(".code-workspace")) candidates.push(path.join(registry, name));
    }
  } catch {
    /* no registry */
  }
  let multiRoot: string | undefined;
  for (const file of candidates) {
    const folders = await workspaceFolders(file);
    if (!folders.some((entry) => entry === target)) continue;
    if (folders.length === 1) return file;
    multiRoot ??= file;
  }
  return multiRoot;
}

/** Absolute folder paths in a workspace file; empty when it can't be read. */
async function workspaceFolders(file: string): Promise<string[]> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch {
    return [];
  }
  const folders = (parsed as { folders?: unknown }).folders;
  if (!Array.isArray(folders)) return [];
  const base = path.dirname(file);
  return folders.flatMap((entry) => {
    const value = (entry as { path?: unknown }).path;
    return typeof value === "string" && value ? [path.resolve(base, value.replace(/^~(?=$|\/)/, os.homedir()))] : [];
  });
}

/** Drop line and block comments and trailing commas outside strings (workspace files are JSONC). */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}
