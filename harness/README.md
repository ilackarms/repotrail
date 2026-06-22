# RepoTrail Harness Contract

RepoTrail is harness-agnostic. The primary artifact is a complete JSON tour
file under `.repotrail/`. The VS Code extension lists those files, watches them
for changes, and plays them back. A small local MCP server can still expose
workspace discovery and legacy live-edit helpers, but normal authoring does not
require step-by-step MCP calls.

The single skill source lives in `harness/repo-trail/SKILL.md` and is served at
`/skill.md?token=<token>`. The agent or harness owns installation: fetch that
URL and install or apply the instructions using its own skill mechanism.

## Supported Modes

RepoTrail has two supported harness modes.

### Existing VS Code Workspace

Use this when the user already has the target roots open in VS Code.

1. Open the target workspace in VS Code.
2. Click **Agent setup** in the RepoTrail sidebar, or run
   **RepoTrail: Copy Agent Setup**.
3. Paste the copied setup into the agent.
4. The agent reads the open roots and writes
   `<owning-project>/.repotrail/<slug>.json`.

### Agent-Created Workspace

Use this when the user wants an agent to prepare the review or tour workspace.

1. The agent checks out or reuses the needed repo roots/worktrees.
2. The agent writes
   `~/.repotrail/workspaces/<workspace-slug>.code-workspace`.
3. The agent optionally writes
   `~/.repotrail/workspaces/<workspace-slug>.manifest.json` with roots and tour
   file paths.
4. The agent opens the workspace with `code <workspace-file>` when available.
5. The agent writes the tour JSON to the owning repo's `.repotrail/`
   directory.

The global workspace directory stores launch files and manifests only. Tours
remain repo-local so they are easy to inspect, refresh, copy, commit, or delete.

## Optional Connection

Open the target workspace in VS Code and click **Agent setup** in the
RepoTrail sidebar, or run **RepoTrail: Copy Agent Setup**. Paste the copied
setup prompt into your agent. The prompt includes the open workspace roots, JSON
schema, and, when enabled, optional helper endpoints:

- `/bootstrap?token=<token>` for machine-readable setup metadata;
- `/skill.md?token=<token>` for the generic RepoTrail skill;
- `/mcp?token=<token>` for the Streamable HTTP MCP server.

The MCP server:

- listens on `127.0.0.1`;
- uses the `/mcp` endpoint;
- serves the skill at `/skill.md` and setup metadata at `/bootstrap`;
- requires either `?token=<token>` in the URL or
  `Authorization: Bearer <token>`;
- expects Streamable HTTP clients to send
  `Accept: application/json, text/event-stream`;
- runs in stateless mode, so `initialize` does not return `Mcp-Session-Id` and
  raw clients should omit that header on follow-up requests;
- writes live connection metadata to `~/.repotrail/ports.json`.

If your harness cannot hot-add MCP tools after the session starts, drive the
endpoint directly as raw Streamable HTTP JSON-RPC. The durable output is still a
repo-local `.repotrail/*.json` file; raw HTTP is only for discovery, workspace
attachment, and legacy live helpers.

## Required Tour Workflow

1. Pick existing-workspace mode or agent-created-workspace mode.
2. Read the repo before choosing stops.
3. Write one complete tour file to `<owning-project>/.repotrail/<slug>.json`.
4. Stop and let the user open the tour from the RepoTrail sidebar.

For deepening or follow-up requests, edit the owning `.repotrail/*.json` file or
write a revised copy. The legacy MCP mutation tools remain available for live
experiments, but committed tours should be JSON files.

## Workspace Files

Workspace files are ordinary VS Code workspaces:

```json
{
  "folders": [
    { "name": "project-pr-123", "path": "/absolute/path/to/project-pr-123" },
    { "name": "dependency-pr-456", "path": "/absolute/path/to/dependency-pr-456" }
  ],
  "settings": {
    "repoTrail.mcpEnabled": true
  }
}
```

Manifests are optional convenience records for agents and users:

```json
{
  "repoTrailWorkspace": 1,
  "createdAt": "2026-06-09T00:00:00.000Z",
  "title": "Project PR review",
  "workspaceFile": "project-pr-review.code-workspace",
  "roots": [
    { "name": "project-pr-123", "path": "/absolute/path/to/project-pr-123" }
  ],
  "tours": [
    {
      "root": "project-pr-123",
      "path": "/absolute/path/to/project-pr-123/.repotrail/pr-walkthrough.json"
    }
  ]
}
```

## Tools

| Tool | Use |
| --- | --- |
| `get_workspace` | Optional helper: confirm the VS Code window and inspect bounded file lists for each open workspace folder. |
| `open_workspace` | Ask VS Code to open an absolute folder or `.code-workspace` path when the current endpoint is attached to the wrong window. Defaults to a new window; reconnect to that window before authoring. |
| `start_tour` / `add_step` | Legacy/live helpers only. Prefer `.repotrail/*.json` for normal authoring. |
| `insert_step` / `update_step` / `remove_step` | Legacy/live helpers for an already-active in-memory tour. Prefer editing the JSON artifact. |
| `show_step` | Legacy/live helper to jump the editor to a step. |
| `get_state` | Inspect the active plan and current step. |
| `end_tour` | Clear the tour only when the user asks. |

Use workspace-relative forward-slash paths. In multi-root windows, set
`plan.roots` aliases and per-step `root` values. `workspaceFolder` is accepted
for older tours. Absolute paths, empty paths, and paths containing `..` are
rejected.

For PRs, commits, branch comparisons, and other explicit windows of changes,
changed-code stops should be diff-backed with `viewMode: "diff"` and
`diff: { baseRef, headRef?, scope: "file", baseFile?, headFile? }`. RepoTrail
reads the real file contents from local git and opens VS Code's native diff
viewer, so the user can scroll imports and unchanged surrounding code while VS
Code highlights the actual changes. Omit `headRef` when the current workspace
file is the right side. `beforeText`/`afterText` remain accepted for non-git
sources and old tours, but normal PR/commit tours should not rely on generated
code text.

Diff-backed steps default to `viewMode: "diff"`; legacy `both` inputs render
compactly as diff-only so tours do not open separate source and diff panes.

Highlight-only `viewMode: "code"` stops are for codebase, file, subsystem,
request-path, or architecture tours unrelated to a window of changes. A
change-review tour may include highlight-only orientation/context stops, but
stops that review changed code should be diffs.
