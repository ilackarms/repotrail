---
name: repotrail
description: Generate an interactive RepoTrail codebase tour in VS Code. Use when the user says "/repotrail", "give me a tour", "walk me through this repo", "tour this PR", or otherwise asks for a narrated walkthrough in the RepoTrail extension.
---

# RepoTrail Tour Harness

RepoTrail is the editor surface. You are the Claude Code convenience harness.
The VS Code extension exposes a local MCP server (`mcp__repotrail__*` tools)
that lets you push a complete tour into the user's editor.

The same MCP workflow is intentionally compatible with other agents. The
generic skill lives at `harness/repotrail/SKILL.md` and is served by the local
RepoTrail HTTP server at `/skill.md?token=<token>`. This Claude Code adapter
adds Claude-specific setup checks and tool naming.

Generate the entire tour up front, then stop. Do not poll for clicks. The user
navigates locally with Back/Next, CodeLens controls, and the sidebar route list.

## Setup Check

Claude Code loads MCP tools when a session starts. If `mcp__repotrail__*` tools
are missing, register the live RepoTrail server and start a new session.

```bash
claude mcp list 2>&1 | grep -i repotrail
```

If missing or unhealthy:

1. Find the live URL:
   ```bash
   cat ~/.repotrail/ports.json
   ```
   Pick the entry whose key matches the current `pwd`. Use its `url` field; it
   includes the required local auth token.
2. If the file is empty or missing, the extension is not running in that VS Code
   workspace. Ask the user to open the workspace in VS Code and run
   **RepoTrail: Copy Agent Setup**.
3. Register globally:
   ```bash
   claude mcp add --scope user --transport http repotrail '<URL_FROM_PORTS_JSON>'
   ```
4. Start a new Claude Code session so the tools load.

## Tools

| Tool | Use for |
| --- | --- |
| `mcp__repotrail__get_workspace` | Confirm the VS Code window and list the first 500 workspace files. Always call first. |
| `mcp__repotrail__start_tour` | Initialize a tour with `kind`, `title`, and optional `summary`. |
| `mcp__repotrail__add_step` | Append a step with `title`, `file`, `explanation`, and optional 1-indexed `range`. |
| `mcp__repotrail__insert_step` | Insert a step at 0-indexed `at`, usually for deepening after the current step. |
| `mcp__repotrail__update_step` | Replace an existing step at `index`. |
| `mcp__repotrail__remove_step` | Delete a step at `index`. |
| `mcp__repotrail__show_step` | Jump to a step by index. Call once at the end with `{ "index": 0 }`. |
| `mcp__repotrail__get_state` | Inspect the current plan and selected step. |
| `mcp__repotrail__end_tour` | Clear the tour. Do not call this after generating a tour. |

There is no polling workflow. If you are waiting for clicks, you are doing it
wrong; the user clicks locally and messages you when they want a change.

## Workflow

1. Call `get_workspace` and verify `workspaceRoot` matches `pwd`. If it does
   not, stop and report the mismatch.
2. Pick the tour kind. If unclear, ask the user which of: architecture, pr-diff,
   file-walkthrough, request-lifecycle, bug-investigation.
3. Read the repo for real: README, manifests, entrypoints, routing, core domain
   code, storage/IO, and relevant tests. Use search and file reads before
   choosing line ranges.
4. Plan the route. Order stops so each one builds on the previous one.
5. Call `start_tour`.
6. Emit every step in sequence with `add_step`. Do not pause between steps.
7. Call `show_step({ "index": 0 })` so the editor lands on stop 1.
8. Tell the user: "Tour ready -- X stops. Navigate with Back/Next or the Route
   list in the RepoTrail sidebar."

## Step Quality Rules

- One logical chunk equals one step.
- Split explanations that say "first, then, then" into separate steps.
- Keep ranges tight and 1-indexed. If you did not read the file, do not invent
  a range.
- Use workspace-relative forward-slash file paths only.
- Explanations should be markdown, usually 2-4 short paragraphs.
- Do not paste code into explanations; the user is looking at the code in VS
  Code.

## Deepening And Follow-Ups

When the user asks to deepen or refine a tour:

1. Call `get_state` to find the current `index`.
2. Read the relevant code.
3. Insert or update steps with the MCP tools.
4. Confirm the changed stop count or changed step title in chat.

Never call `end_tour` unless the user explicitly asks to clear the tour.
