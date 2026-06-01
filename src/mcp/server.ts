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
import { TourKind, TourPlan } from "../engine/types";

const PORT_REGISTRY_DIR = path.join(os.homedir(), ".repotrail");
const PORT_REGISTRY_FILE = path.join(PORT_REGISTRY_DIR, "ports.json");
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * HTTP-based MCP server that lets an external agentic harness (Claude Code,
 * etc.) drive a tour. The extension itself is "dumb" — it executes whatever
 * steps the agent emits.
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
    return `http://127.0.0.1:${this.actualPort}/mcp?token=${this.authToken}`;
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
          "Returns the absolute path of the current VS Code workspace root and a list of workspace-relative files (first 500).",
        inputSchema: {},
      },
      async () => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
        const ctx = await gatherRepoContext();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ workspaceRoot: root, files: ctx?.files ?? [] }, null, 2),
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
          "Initialize an empty tour. Subsequent add_step calls append steps that the editor opens and highlights.",
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
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const plan: TourPlan = {
          kind: kind as TourKind,
          title,
          summary: summary ?? "",
          steps: [],
        };
        this.controller.startEmpty(plan, root);
        await vscode.commands.executeCommand("repoTrail.tour.focus").then(undefined, () => {});
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, kind, title }) }],
        };
      },
    );

    server.registerTool(
      "add_step",
      {
        title: "Append a tour step",
        description:
          "Append a step to the active tour and immediately open the file + highlight the range in VS Code. Ranges are 1-indexed (line and column).",
        inputSchema: {
          title: z.string().describe("Short title for the step."),
          file: z
            .string()
            .describe("Workspace-relative path to the file the user should look at."),
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
        },
      },
      async ({ title, file, explanation, range }) => {
        const index = await this.controller.appendStep({
          title,
          file: normalizeWorkspaceFile(file),
          explanation,
          range: range
            ? {
                startLine: range.startLine,
                startColumn: range.startColumn ?? 1,
                endLine: range.endLine,
                endColumn: range.endColumn ?? 1,
              }
            : undefined,
          actions: range
            ? ["openFile", "highlightRange", "showNarration"]
            : ["openFile", "showNarration"],
        });
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
      file: z.string().describe("Workspace-relative path to the file."),
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
    };

    const buildStep = (input: {
      title: string;
      file: string;
      explanation: string;
      range?: { startLine: number; startColumn?: number; endLine: number; endColumn?: number };
    }) => ({
      title: input.title,
      file: normalizeWorkspaceFile(input.file),
      explanation: input.explanation,
      range: input.range
        ? {
            startLine: input.range.startLine,
            startColumn: input.range.startColumn ?? 1,
            endLine: input.range.endLine,
            endColumn: input.range.endColumn ?? 1,
          }
        : undefined,
      actions: (input.range
        ? ["openFile", "highlightRange", "showNarration"]
        : ["openFile", "showNarration"]) as ("openFile" | "highlightRange" | "showNarration")[],
    });

    server.registerTool(
      "insert_step",
      {
        title: "Insert a step at a specific position",
        description:
          "Insert a step into the active tour at the given 0-indexed position. Use to deepen — call get_state, then insert one or more sub-steps after the user's current step. The user's current view is preserved.",
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
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "_no_workspace";
      existing[root] = {
        port: this.actualPort,
        pid: process.pid,
        version: this.extensionVersion,
        token: this.authToken,
        url: this.connectionUrl,
      };
      await fs.writeFile(PORT_REGISTRY_FILE, JSON.stringify(existing, null, 2), "utf8");
    } catch (err) {
      this.output.appendLine(`[mcp] publishPort failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async unpublishPort(): Promise<void> {
    try {
      const existing = await readRegistry();
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "_no_workspace";
      if (existing[root]?.pid === process.pid) {
        delete existing[root];
        await fs.writeFile(PORT_REGISTRY_FILE, JSON.stringify(existing, null, 2), "utf8");
      }
    } catch {
      /* best-effort */
    }
  }
}

type RegistryEntry = { port: number; pid: number; version: string; token: string; url: string };
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

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function normalizeWorkspaceFile(file: string): string {
  if (!file || file.includes("\0")) {
    throw new Error("Tour step file must be a non-empty workspace-relative path.");
  }
  const normalized = file.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error("Tour step file must be workspace-relative, not absolute.");
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0 || parts.includes("..")) {
    throw new Error("Tour step file cannot escape the workspace.");
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return parts.join("/");
  const resolved = path.resolve(root, ...parts);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Tour step file cannot escape the workspace.");
  }
  return parts.join("/");
}
