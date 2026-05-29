import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { TourController, UserAction } from "../ux/tourController";
import { gatherRepoContext } from "../analysis/repoContext";
import { TourKind, TourPlan } from "../engine/types";

const PORT_REGISTRY_DIR = path.join(os.homedir(), ".code-atlas");
const PORT_REGISTRY_FILE = path.join(PORT_REGISTRY_DIR, "ports.json");

/**
 * HTTP-based MCP server that lets an external agentic harness (Claude Code,
 * etc.) drive a tour. The extension itself is "dumb" — it executes whatever
 * steps the agent emits.
 *
 * Transport: Streamable HTTP, stateless. Single endpoint at POST /mcp.
 * Bound to 127.0.0.1 only. Default port 7777, overridable via setting.
 */
export class CodeAtlasMcpServer {
  private server: http.Server | null = null;
  private mcp: McpServer | null = null;
  private transport: StreamableHTTPServerTransport | null = null;
  private actualPort = 0;

  constructor(
    private readonly controller: TourController,
    private readonly extensionVersion: string,
  ) {}

  async start(preferredPort: number): Promise<number> {
    this.mcp = new McpServer({ name: "code-atlas", version: this.extensionVersion });
    this.registerTools(this.mcp);

    this.transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await this.mcp.connect(this.transport);

    const httpServer = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    httpServer.on("error", (err) => {
      console.error("[code-atlas mcp] http error:", err);
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(preferredPort, "127.0.0.1", () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
    const addr = httpServer.address();
    this.actualPort = typeof addr === "object" && addr ? addr.port : preferredPort;
    this.server = httpServer;
    await this.publishPort();
    return this.actualPort;
  }

  async stop(): Promise<void> {
    await this.unpublishPort();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    if (this.transport) {
      await this.transport.close().catch(() => {});
      this.transport = null;
    }
    if (this.mcp) {
      await this.mcp.close().catch(() => {});
      this.mcp = null;
    }
  }

  get port(): number {
    return this.actualPort;
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

    if (url.pathname === "/mcp") {
      try {
        const body = req.method === "POST" ? await readJson(req) : undefined;
        await this.transport!.handleRequest(req, res, body);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" }).end(
            JSON.stringify({ error: String(err) }),
          );
        }
      }
      return;
    }

    res.writeHead(404).end();
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
        const plan: TourPlan = {
          kind: kind as TourKind,
          title,
          summary: summary ?? "",
          steps: [],
        };
        this.controller.startEmpty(plan);
        await vscode.commands.executeCommand("codeAtlas.tour.focus").then(undefined, () => {});
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
          file,
          explanation,
          range: range
            ? {
                startLine: range.startLine,
                startColumn: range.startColumn ?? 1,
                endLine: range.endLine,
                endColumn: range.endColumn ?? 1,
              }
            : undefined,
          actions: range ? ["openFile", "highlightRange", "showNarration"] : ["openFile", "showNarration"],
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
      "wait_for_user",
      {
        title: "Wait for user navigation",
        description:
          "Block until the user clicks Next, Back, Go deeper, or Stop in the Code Atlas sidebar. Returns the action. If no action arrives within timeout_seconds, returns {action: 'timeout'}. Default timeout 30s. Call this in a loop after add_step to drive a turn-based tour.",
        inputSchema: {
          timeout_seconds: z
            .number()
            .int()
            .min(1)
            .max(300)
            .default(30)
            .describe("Max seconds to wait before returning 'timeout'."),
        },
      },
      async ({ timeout_seconds }) => {
        const action = await waitForAction(this.controller, timeout_seconds ?? 30);
        return { content: [{ type: "text", text: JSON.stringify({ action }) }] };
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
      existing[root] = { port: this.actualPort, pid: process.pid, version: this.extensionVersion };
      await fs.writeFile(PORT_REGISTRY_FILE, JSON.stringify(existing, null, 2), "utf8");
    } catch (err) {
      console.error("[code-atlas mcp] publishPort failed:", err);
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

type RegistryEntry = { port: number; pid: number; version: string };
type Registry = Record<string, RegistryEntry>;

async function readRegistry(): Promise<Registry> {
  try {
    const raw = await fs.readFile(PORT_REGISTRY_FILE, "utf8");
    return JSON.parse(raw) as Registry;
  } catch {
    return {};
  }
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body.trim()) return undefined;
  return JSON.parse(body);
}

function waitForAction(controller: TourController, timeoutSeconds: number): Promise<UserAction | "timeout"> {
  return new Promise((resolve) => {
    const sub = controller.onUserAction((action) => {
      cleanup();
      resolve(action);
    });
    const timer = setTimeout(() => {
      cleanup();
      resolve("timeout");
    }, timeoutSeconds * 1000);
    const cleanup = () => {
      sub.dispose();
      clearTimeout(timer);
    };
  });
}
