# RepoTrail Harness Contract

RepoTrail is harness-agnostic. The VS Code extension exposes a local
Streamable HTTP MCP server and serves a generic skill document from that same
server; any local agent that can fetch the skill and call MCP can create and
refine tours.

The generic skill source lives in `harness/repo-trail/SKILL.md` and is served at
`/skill.md?token=<token>`. Claude Code support is bundled as a convenience
adapter in `harness/claude/repo-trail/`, and the extension can install that
adapter with **RepoTrail: Install Claude Code Adapter**.

## Connection

Open the target workspace in VS Code and click **Connect agent** in the
RepoTrail sidebar, or run **RepoTrail: Copy Agent Setup**. Paste the copied
setup prompt into your agent. The prompt points the agent at:

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

1. Call `get_workspace`.
2. Verify `workspaceRoot` matches the repository the agent is analyzing.
3. Read the repo before choosing stops.
4. Call `start_tour`.
5. Add the full route up front with `add_step`.
6. Call `show_step({ "index": 0 })`.
7. Stop and let the user navigate locally in VS Code.

For deepening or follow-up requests, call `get_state`, read the relevant code,
then use `insert_step`, `update_step`, or `remove_step`.

## Tools

| Tool | Use |
| --- | --- |
| `get_workspace` | Confirm the VS Code window and inspect a bounded file list. |
| `start_tour` | Initialize a tour with `kind`, `title`, and optional `summary`. |
| `add_step` | Append a step with `title`, workspace-relative `file`, markdown `explanation`, and optional 1-indexed `range`. |
| `insert_step` | Insert a step at a 0-indexed position, usually after the current stop. |
| `update_step` | Replace an existing step at a 0-indexed position. |
| `remove_step` | Delete a step at a 0-indexed position. |
| `show_step` | Jump the editor to a step. Call once at the end with index 0. |
| `get_state` | Inspect the active plan and current step. |
| `end_tour` | Clear the tour only when the user asks. |

Use workspace-relative forward-slash paths. Absolute paths, empty paths, and
paths containing `..` are rejected.
