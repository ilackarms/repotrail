# RepoTrail Harness Contract

RepoTrail is harness-agnostic. The VS Code extension exposes a local
Streamable HTTP MCP server; any local agent that can call that server can create
and refine tours.

Claude Code support is bundled as a convenience skill in
`harness/claude/repotrail/`, and the extension can install that skill with
**RepoTrail: Install Claude Code Skill**. Other agents do not need that skill;
they only need the MCP connection details and the workflow below.

## Connection

Open the target workspace in VS Code and run **RepoTrail: Show MCP Setup**.
Copy **Generic MCP config** for a tokenized URL and an equivalent Bearer-header
form.

The MCP server:

- listens on `127.0.0.1`;
- uses the `/mcp` endpoint;
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
