# RepoTrail Harness Contract

RepoTrail is harness-agnostic. The primary artifact is a complete JSON tour
file under `.repotrail/`. The VS Code extension lists those files, watches them
for changes, and plays them back. A small local MCP server can still expose
workspace discovery and legacy live-edit helpers, but normal authoring does not
require step-by-step MCP calls.

The single skill source lives in `harness/repo-trail/SKILL.md` and is served at
`/skill.md?token=<token>`. The agent or harness owns installation: fetch that
URL and install or apply the instructions using its own skill mechanism.

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
- writes live connection metadata to `~/.repotrail/ports.json`.

## Required Workflow

1. Verify the repository the agent is analyzing is open in VS Code. Use
   `get_workspace` only when the optional MCP helper is available and useful.
2. Read the repo before choosing stops.
3. Write one complete tour file to `<owning-project>/.repotrail/<slug>.json`.
4. Stop and let the user open the tour from the RepoTrail sidebar.

For deepening or follow-up requests, edit the owning `.repotrail/*.json` file or
write a revised copy. The legacy MCP mutation tools remain available for live
experiments, but committed tours should be JSON files.

## Tools

| Tool | Use |
| --- | --- |
| `get_workspace` | Optional helper: confirm the VS Code window and inspect bounded file lists for each open workspace folder. |
| `start_tour` / `add_step` | Legacy/live helpers only. Prefer `.repotrail/*.json` for normal authoring. |
| `insert_step` / `update_step` / `remove_step` | Legacy/live helpers for an already-active in-memory tour. Prefer editing the JSON artifact. |
| `show_step` | Legacy/live helper to jump the editor to a step. |
| `get_state` | Inspect the active plan and current step. |
| `end_tour` | Clear the tour only when the user asks. |

Use workspace-relative forward-slash paths. In multi-root windows, set
`plan.roots` aliases and per-step `root` values. `workspaceFolder` is accepted
for older tours. Absolute paths, empty paths, and paths containing `..` are
rejected.

For PR/diff walkthroughs, steps may include `viewMode: "code" | "diff" |
"both"` and `diff: { beforeText, afterText?, beforeLabel?, afterLabel?,
languageId? }`. Diff-backed steps default to `viewMode: "diff"`; legacy `both`
inputs render compactly as diff-only so tours do not open separate source and
diff panes. `afterText` can be omitted when the current selected lines are the
right side of the diff.
