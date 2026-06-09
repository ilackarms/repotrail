import * as http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { TourController } from "../ux/tourController";
import { gatherRepoContext } from "../analysis/repoContext";
import { TourAction, TourKind, TourPlan, TourStep, TourStepDiff, TourStepViewMode } from "../engine/types";
import {
  currentWorkspaceRegistryKeys,
  currentWorkspaceStorageRoot,
  firstWorkspaceRoot,
  normalizeTourStepTarget,
  workspaceFolderInfos,
  workspaceWindowRegistryKey,
} from "../workspace";

const PORT_REGISTRY_DIR = path.join(os.homedir(), ".repotrail");
const PORT_REGISTRY_FILE = path.join(PORT_REGISTRY_DIR, "ports.json");
const WORKSPACE_REGISTRY_DIR = path.join(PORT_REGISTRY_DIR, "workspaces");
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * HTTP-based MCP helper server for local agents. The primary tour artifact is
 * now `.repotrail/*.json`; MCP remains useful for workspace discovery and
 * backward-compatible live tour manipulation.
 *
 * Transport: Streamable HTTP, stateless. Single endpoint at POST /mcp.
 * Bound to 127.0.0.1 only. Default port 7777, overridable via setting.
 *
 * Stateless mode requires a FRESH McpServer + transport per request. The
 * underlying TourController is shared (the source of truth), so tool
 * implementations close over it; only the protocol machinery is rebuilt.
 */
export class RepoTrailMcpServer {
  private server: http.Server | null = null;
  private actualPort = 0;
  private readonly authToken = randomBytes(32).toString("hex");
  private output: vscode.OutputChannel;

  constructor(
    private readonly controller: TourController,
    private readonly extensionVersion: string,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.output = vscode.window.createOutputChannel("RepoTrail MCP");
  }

  /**
   * Try to bind `preferredPort`. If it's in use (EADDRINUSE), increment up to
   * `range - 1` times before giving up. Returns the port we actually bound.
   * Used so multiple VS Code windows can coexist without colliding.
   */
  async startWithFallback(preferredPort: number, range: number): Promise<number> {
    let lastErr: unknown = null;
    for (let i = 0; i < range; i++) {
      const port = preferredPort + i;
      try {
        return await this.start(port);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "EADDRINUSE") throw err;
        lastErr = err;
      }
    }
    throw lastErr ?? new Error(`No free port in range ${preferredPort}..${preferredPort + range - 1}`);
  }

  async start(preferredPort: number): Promise<number> {
    const httpServer = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    httpServer.on("error", (err) => {
      this.output.appendLine(`[http] error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    });

    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      httpServer.once("error", onErr);
      httpServer.listen(preferredPort, "127.0.0.1", () => {
        httpServer.off("error", onErr);
        resolve();
      });
    });
    const addr = httpServer.address();
    this.actualPort = typeof addr === "object" && addr ? addr.port : preferredPort;
    this.server = httpServer;
    await this.publishPort();
    this.output.appendLine(
      `[mcp] listening on http://127.0.0.1:${this.actualPort}/mcp (version ${this.extensionVersion})`,
    );
    return this.actualPort;
  }

  async stop(): Promise<void> {
    await this.unpublishPort();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  get port(): number {
    return this.actualPort;
  }

  get connectionUrl(): string {
    return `${this.baseUrl}/mcp?token=${this.authToken}`;
  }

  get skillUrl(): string {
    return `${this.baseUrl}/skill.md?token=${this.authToken}`;
  }

  get bootstrapUrl(): string {
    return `${this.baseUrl}/bootstrap?token=${this.authToken}`;
  }

  private get baseUrl(): string {
    return `http://127.0.0.1:${this.actualPort}`;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!req.url) {
      res.writeHead(400).end();
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host ?? "127.0.0.1"}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ ok: true, port: this.actualPort, version: this.extensionVersion }),
      );
      return;
    }

    if (url.pathname === "/skill" || url.pathname === "/skill.md") {
      await this.handleSkillRequest(req, res, url);
      return;
    }

    if (url.pathname === "/bootstrap") {
      this.handleBootstrapRequest(req, res, url);
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      writeJsonRpcError(res, 405, -32600, "RepoTrail MCP expects POST /mcp.");
      return;
    }
    if (!this.isAuthorized(req, url)) {
      this.output.appendLine(`[mcp] rejected unauthorized request from ${req.socket.remoteAddress ?? "unknown"}`);
      writeJsonRpcError(res, 401, -32001, "Unauthorized RepoTrail MCP request.");
      return;
    }

    // Stateless: build a fresh McpServer + transport per request.
    const mcp = new McpServer({ name: "repotrail", version: this.extensionVersion });
    this.registerTools(mcp);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    const cleanup = () => {
      transport.close().catch(() => {});
      mcp.close().catch(() => {});
    };
    res.on("close", cleanup);

    try {
      await mcp.connect(transport);
      const body = await readJson(req, MAX_BODY_BYTES);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : "RepoTrail MCP request failed.";
      const logMsg = err instanceof Error ? err.stack ?? err.message : String(err);
      const code = status === 400 ? -32700 : -32603;
      this.output.appendLine(`[mcp] ${req.method} ${url.pathname} failed: ${logMsg}`);
      if (!res.headersSent) {
        writeJsonRpcError(res, status, code, message);
      } else {
        try {
          res.end();
        } catch {
          /* already closed */
        }
      }
      cleanup();
    }
  }

  private isAuthorized(req: http.IncomingMessage, url: URL): boolean {
    const token = url.searchParams.get("token") ?? bearerToken(req.headers.authorization);
    if (!token) return false;
    const expected = Buffer.from(this.authToken);
    const actual = Buffer.from(token);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private registerTools(server: McpServer): void {
    server.registerTool(
      "get_workspace",
      {
        title: "Get workspace info",
        description:
          "Returns the current VS Code window's workspace folders and bounded workspace-relative file lists.",
        inputSchema: {},
      },
      async () => {
        const root = firstWorkspaceRoot() ?? "";
        const ctx = await gatherRepoContext();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                ctx ?? {
                  workspaceRoot: root,
                  files: [],
                  supportsMultiRoot: true,
                  workspaceFolders: workspaceFolderInfos().map((f) => ({ ...f, files: [] })),
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );

	    server.registerTool(
	      "start_tour",
	      {
	        title: "Start a new tour",
	        description:
	          "Legacy/live helper: initialize an empty in-memory tour. Prefer writing a complete .repotrail/*.json file for normal authoring.",
        inputSchema: {
          kind: z
            .enum([
              "architecture",
              "pr-diff",
              "file-walkthrough",
              "request-lifecycle",
              "bug-investigation",
            ])
            .describe("Type of tour."),
          title: z.string().describe("Short tour title shown in the sidebar."),
          summary: z.string().optional().describe("Optional one-paragraph overview."),
        },
      },
      async ({ kind, title, summary }) => {
        const plan: TourPlan = {
          kind: kind as TourKind,
          title,
          summary: summary ?? "",
          steps: [],
        };
        this.controller.startEmpty(plan, currentWorkspaceStorageRoot());
        await vscode.commands.executeCommand("repoTrail.tour.focus").then(undefined, () => {});
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, kind, title }) }],
        };
      },
    );

    const viewModeSchema = z
      .enum(["code", "diff", "both"])
      .optional()
      .describe("Presentation mode. Defaults to `diff` when diff is present; legacy `both` inputs are rendered compactly as diff-only.");

    const diffSchema = z
      .object({
        beforeText: z
          .string()
          .optional()
          .describe("Legacy/non-git previous text for the left side. Prefer baseRef for PR/commit tours."),
        afterText: z
          .string()
          .optional()
          .describe("Legacy/non-git changed text for the right side. Omit to use the selected range or whole file, depending on scope."),
        baseRef: z
          .string()
          .optional()
          .describe("Git commit-ish for the left side, such as a base SHA or origin/main. Preferred for PR/commit tours."),
        headRef: z
          .string()
          .optional()
          .describe("Optional git commit-ish for the right side. Omit to use the current workspace file."),
        baseFile: z.string().optional().describe("Optional path at baseRef when the file was renamed. Defaults to file."),
        headFile: z.string().optional().describe("Optional path at headRef when the file was renamed. Defaults to file."),
        scope: z
          .enum(["file", "hunk"])
          .optional()
          .describe("Diff scope. Git-backed diffs default to file; pasted-text diffs default to hunk."),
        beforeLabel: z.string().optional().describe("Optional label for the left side of the diff."),
        afterLabel: z.string().optional().describe("Optional label for the right side of the diff."),
        languageId: z.string().optional().describe("Optional VS Code language id for virtual diff documents."),
      })
      .optional()
      .describe("Optional diff payload for native VS Code diff display. Use baseRef/headRef instead of pasted code when the diff comes from git.");

	    server.registerTool(
	      "add_step",
	      {
	        title: "Append a tour step",
	        description:
	          "Legacy/live helper: append a step to the active in-memory tour. Prefer complete .repotrail JSON files for normal authoring. Ranges are 1-indexed.",
        inputSchema: {
          title: z.string().describe("Short title for the step."),
          workspaceFolder: z
            .string()
            .optional()
            .describe(
              "Optional workspace folder identity from get_workspace.workspaceFolders[].workspaceFolder. Omit for the first workspace folder.",
            ),
          file: z
            .string()
            .describe("Workspace-relative path inside workspaceFolder to the file the user should look at."),
          explanation: z.string().describe("Markdown narration shown to the user."),
          range: z
            .object({
              startLine: z.number().int().min(1),
              startColumn: z.number().int().min(1).default(1),
              endLine: z.number().int().min(1),
              endColumn: z.number().int().min(1).default(1),
            })
            .optional()
            .describe("1-indexed code range to highlight."),
          viewMode: viewModeSchema,
          diff: diffSchema,
        },
      },
      async (input) => {
        const index = await this.controller.appendStep(buildStep(input));
        const snap = this.controller.snapshot();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ index, total: snap.plan?.steps.length ?? 0 }),
            },
          ],
        };
      },
    );

    const stepInputSchema = {
      title: z.string().describe("Short title for the step."),
      workspaceFolder: z
        .string()
        .optional()
        .describe(
          "Optional workspace folder identity from get_workspace.workspaceFolders[].workspaceFolder. Omit for the first workspace folder.",
        ),
      file: z.string().describe("Workspace-relative path inside workspaceFolder to the file."),
      explanation: z.string().describe("Markdown narration shown to the user."),
      range: z
        .object({
          startLine: z.number().int().min(1),
          startColumn: z.number().int().min(1).default(1),
          endLine: z.number().int().min(1),
          endColumn: z.number().int().min(1).default(1),
        })
        .optional()
        .describe("1-indexed code range to highlight."),
      viewMode: viewModeSchema,
      diff: diffSchema,
    };

    function buildActions(
      range: TourStep["range"],
      diff: TourStepDiff | undefined,
      viewMode: TourStepViewMode | undefined,
    ): TourAction[] {
      const mode = diff ? viewMode ?? "diff" : "code";
      const actions: TourAction[] = [];
      if (mode !== "diff") {
        actions.push("openFile");
        if (range) actions.push("highlightRange");
      }
      if (diff && mode !== "code") actions.push("showDiff");
      actions.push("showNarration");
      return actions;
    }

    const buildStep = (input: {
      title: string;
      workspaceFolder?: string;
      file: string;
      explanation: string;
      range?: { startLine: number; startColumn?: number; endLine: number; endColumn?: number };
      viewMode?: TourStepViewMode;
      diff?: TourStepDiff;
    }): TourStep => {
      const target = normalizeTourStepTarget(input.file, input.workspaceFolder);
      const range = input.range
        ? {
            startLine: input.range.startLine,
            startColumn: input.range.startColumn ?? 1,
            endLine: input.range.endLine,
            endColumn: input.range.endColumn ?? 1,
          }
        : undefined;
      const viewMode = input.diff
        ? input.viewMode === "code"
          ? "code"
          : "diff"
        : input.viewMode === "code"
          ? "code"
          : undefined;
      return {
        title: input.title,
        ...target,
        explanation: input.explanation,
        range,
        viewMode,
        diff: input.diff,
        actions: buildActions(range, input.diff, viewMode),
      };
    };

	    server.registerTool(
	      "insert_step",
	      {
	        title: "Insert a step at a specific position",
	        description:
	          "Legacy/live helper: insert a step into the active in-memory tour at the given 0-indexed position. Prefer editing the .repotrail JSON artifact for durable deepening.",
        inputSchema: {
          ...stepInputSchema,
          at: z.number().int().min(0).describe("0-indexed position to insert at (existing step at this index shifts right)."),
        },
      },
      async ({ at, ...rest }) => {
        const inserted = this.controller.insertStep(at, buildStep(rest));
        const snap = this.controller.snapshot();
        return {
          content: [
            { type: "text", text: JSON.stringify({ inserted, total: snap.plan?.steps.length ?? 0 }) },
          ],
        };
      },
    );

    server.registerTool(
      "update_step",
      {
        title: "Replace an existing step",
        description:
          "Overwrite the step at `index` with new content. If the user is currently viewing that step, the editor re-applies the new range/file.",
        inputSchema: {
          ...stepInputSchema,
          index: z.number().int().min(0).describe("0-indexed step to overwrite."),
        },
      },
      async ({ index, ...rest }) => {
        await this.controller.updateStep(index, buildStep(rest));
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, index }) }] };
      },
    );

    server.registerTool(
      "remove_step",
      {
        title: "Remove a step",
        description: "Delete the step at `index`. Adjusts the user's current view if needed.",
        inputSchema: { index: z.number().int().min(0) },
      },
      async ({ index }) => {
        await this.controller.removeStep(index);
        const snap = this.controller.snapshot();
        return {
          content: [
            { type: "text", text: JSON.stringify({ ok: true, total: snap.plan?.steps.length ?? 0 }) },
          ],
        };
      },
    );

    server.registerTool(
      "show_step",
      {
        title: "Show an existing step",
        description: "Jump to a previously appended step by index.",
        inputSchema: { index: z.number().int().min(0) },
      },
      async ({ index }) => {
        await this.controller.showStep(index);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, index }) }] };
      },
    );

    server.registerTool(
      "get_state",
      {
        title: "Get tour state",
        description: "Returns the current plan, current step index, and the active step (if any).",
        inputSchema: {},
      },
      async () => {
        const snap = this.controller.snapshot();
        return {
          content: [{ type: "text", text: JSON.stringify(snap, null, 2) }],
        };
      },
    );

    server.registerTool(
      "end_tour",
      {
        title: "End the tour",
        description: "Clear the active tour and remove all highlights.",
        inputSchema: {},
      },
      async () => {
        this.controller.stop();
        return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
      },
    );
  }

  private async publishPort(): Promise<void> {
    try {
      await fs.mkdir(PORT_REGISTRY_DIR, { recursive: true });
      const existing = await readRegistry();
      const folders = workspaceFolderInfos();
      const entry: RegistryEntry = {
        port: this.actualPort,
        pid: process.pid,
        version: this.extensionVersion,
        token: this.authToken,
        url: this.connectionUrl,
        skillUrl: this.skillUrl,
        bootstrapUrl: this.bootstrapUrl,
        workspaceRoot: firstWorkspaceRoot() ?? "_no_workspace",
        workspaceFolders: folders,
      };
      for (const key of currentWorkspaceRegistryKeys()) {
        existing[key] = entry;
      }
      await fs.writeFile(PORT_REGISTRY_FILE, JSON.stringify(existing, null, 2), "utf8");
    } catch (err) {
      this.output.appendLine(`[mcp] publishPort failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async unpublishPort(): Promise<void> {
    try {
      const existing = await readRegistry();
      let changed = false;
      for (const [key, entry] of Object.entries(existing)) {
        if (entry.pid === process.pid && entry.token === this.authToken) {
          delete existing[key];
          changed = true;
        }
      }
      if (changed) await fs.writeFile(PORT_REGISTRY_FILE, JSON.stringify(existing, null, 2), "utf8");
    } catch {
      /* best-effort */
    }
  }

  private async handleSkillRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    if (req.method !== "GET") {
      writeJsonResponse(res, 405, { error: "RepoTrail skill endpoint expects GET." });
      return;
    }
    if (!this.isAuthorized(req, url)) {
      this.output.appendLine(`[skill] rejected unauthorized request from ${req.socket.remoteAddress ?? "unknown"}`);
      writeJsonResponse(res, 401, { error: "Unauthorized RepoTrail skill request." });
      return;
    }
    try {
      const skillPath = vscode.Uri.joinPath(this.extensionUri, "harness", "repo-trail", "SKILL.md").fsPath;
      const skill = await fs.readFile(skillPath, "utf8");
      res
        .writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
          "cache-control": "no-store",
        })
        .end(skill);
    } catch (err) {
      this.output.appendLine(`[skill] failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      writeJsonResponse(res, 500, { error: "RepoTrail skill is unavailable." });
    }
  }

  private handleBootstrapRequest(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    if (req.method !== "GET") {
      writeJsonResponse(res, 405, { error: "RepoTrail bootstrap endpoint expects GET." });
      return;
    }
    if (!this.isAuthorized(req, url)) {
      this.output.appendLine(`[bootstrap] rejected unauthorized request from ${req.socket.remoteAddress ?? "unknown"}`);
      writeJsonResponse(res, 401, { error: "Unauthorized RepoTrail bootstrap request." });
      return;
    }
    const mcpUrl = new URL(this.connectionUrl);
    const token = mcpUrl.searchParams.get("token") ?? "";
    const folders = workspaceFolderInfos();
    writeJsonResponse(res, 200, {
      name: "repo-trail",
      version: this.extensionVersion,
      workspace: {
        workspaceRoot: firstWorkspaceRoot() ?? "",
        workspaceKey: currentWorkspaceStorageRoot(),
        windowRegistryKey: folders.length > 1 ? workspaceWindowRegistryKey() : undefined,
        workspaceFolders: folders,
      },
      skill: {
        name: "repo-trail",
        url: this.skillUrl,
        mediaType: "text/markdown",
        install: "Fetch this skill and install or use it with the agent's own skill mechanism.",
      },
      mcp: {
        name: "repotrail",
        transport: "streamable-http",
        url: this.connectionUrl,
        alternateAuth: {
          url: `${mcpUrl.origin}${mcpUrl.pathname}`,
          headers: {
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${token}`,
          },
        },
      },
      workspaceRegistry: {
        directory: WORKSPACE_REGISTRY_DIR,
        workspaceFilePattern: "<workspace-slug>.code-workspace",
        manifestFilePattern: "<workspace-slug>.manifest.json",
        purpose:
          "Agents may save VS Code workspace launch files here when creating a new RepoTrail workspace. Tours still belong in repo-local .repotrail/ directories.",
      },
      tourFiles: {
        directory: ".repotrail",
        schemaVersion: 2,
        preferredWorkflow:
          "Write one complete JSON tour file into the owning project's .repotrail/ directory. RepoTrail refreshes the library from the filesystem.",
        rootAddressing:
          "For multi-root tours, define plan.roots aliases and set step.root instead of repeating workspaceFolder on every step.",
        presentationPolicy: {
          changeReview:
            "If the user mentions a PR, PRs, commit, commits, branch comparison, diff, changes, review, or another explicit change window, use kind pr-diff and make every changed-code stop diff-backed with viewMode diff plus diff.baseRef and optional diff.headRef. Prefer scope file so RepoTrail reads real full-file contents from local git.",
          highlightOnly:
            "Use highlight-only viewMode code only for codebase, file, subsystem, request-path, or architecture tours unrelated to a window of changes, plus optional orientation/context stops that do not review changed code.",
        },
      },
      workflow: [
        "Fetch the repo-trail skill and install or use it with the agent's own skill mechanism before generating a tour.",
        "For an existing VS Code workspace, call get_workspace only if you need to verify open roots or file lists.",
        "For a new RepoTrail workspace, create or reuse non-destructive worktrees, save a .code-workspace under the workspaceRegistry directory, and open it in VS Code if possible.",
        "Read the repo before choosing stops.",
        "Choose presentation mode from the request: PRs, commits, branch comparisons, diffs, reviews, and explicit change windows use git-backed diff stops; codebase/subsystem tours unrelated to changes may be highlight-only.",
        "Write the complete JSON tour to <owning-project>/.repotrail/<slug>.json.",
        "Tell the user the workspace file path when one was created and the tour file path. Do not build normal tours through sequential start_tour/add_step calls.",
      ],
    });
  }
}

type RegistryEntry = {
  port: number;
  pid: number;
  version: string;
  token: string;
  url: string;
  skillUrl: string;
  bootstrapUrl: string;
  workspaceRoot?: string;
  workspaceFolders?: ReturnType<typeof workspaceFolderInfos>;
};
type Registry = Record<string, RegistryEntry>;

async function readRegistry(): Promise<Registry> {
  try {
    const raw = await fs.readFile(PORT_REGISTRY_FILE, "utf8");
    return JSON.parse(raw) as Registry;
  } catch {
    return {};
  }
}

async function readJson(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      throw new HttpError(413, "RepoTrail MCP request body is too large.");
    }
    chunks.push(buf);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body.trim()) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, "RepoTrail MCP request body is not valid JSON.");
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function writeJsonRpcError(
  res: http.ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", error: { code, message } }));
}

function writeJsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  res
    .writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    })
    .end(JSON.stringify(body));
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
