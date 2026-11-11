// Minimal stand-in for the `vscode` module so tests can load compiled modules
// that import it (such as out-test/workspace.js) under plain `node --test`.
// Only the surface those modules touch is implemented.
import { createRequire } from "node:module";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const Module = require("node:module");

class Uri {
  constructor(fsPath) {
    this.scheme = "file";
    this.fsPath = fsPath;
    this.path = fsPath.replace(/\\/g, "/");
  }
  static file(fsPath) {
    return new Uri(path.resolve(fsPath));
  }
  static joinPath(base, ...segments) {
    return new Uri(path.join(base.fsPath, ...segments));
  }
  toString() {
    return `file://${this.path}`;
  }
}

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (fn) => {
      this.listeners.add(fn);
      return { dispose: () => this.listeners.delete(fn) };
    };
  }
  fire(value) {
    for (const fn of [...this.listeners]) fn(value);
  }
  dispose() {
    this.listeners.clear();
  }
}

export const vscodeStub = {
  Uri,
  EventEmitter,
  commands: { executeCommand: async () => undefined },
  window: { showInformationMessage: async () => undefined },
  workspace: {
    workspaceFolders: undefined,
    getWorkspaceFolder(uri) {
      const folders = vscodeStub.workspace.workspaceFolders ?? [];
      return folders.find((f) => uri.fsPath === f.uri.fsPath || uri.fsPath.startsWith(`${f.uri.fsPath}${path.sep}`));
    },
  },
};

/** Replace the open workspace folders with folders at these absolute paths. */
export function setWorkspaceFolders(paths) {
  vscodeStub.workspace.workspaceFolders = paths.map((fsPath, index) => ({
    uri: Uri.file(fsPath),
    name: path.basename(fsPath),
    index,
  }));
  return vscodeStub.workspace.workspaceFolders;
}

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "vscode") return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};
