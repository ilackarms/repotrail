---
name: repotrail
description: Generate an interactive RepoTrail codebase tour in VS Code through the local RepoTrail MCP server.
---

# RepoTrail Agent Skill

RepoTrail is the VS Code editor surface for agent-guided codebase tours. You
are the analysis engine. The extension exposes a token-authenticated local MCP
server that lets you push a complete tour into the user's editor.

Install or use this skill in your current session before creating a RepoTrail
tour. If your agent supports persistent skills, save this document as the
`repotrail` skill. If it does not, treat this document as the active harness
instructions for the current request.

## Connection

Use the MCP connection details the user provided with this skill. RepoTrail uses
Streamable HTTP on `127.0.0.1` and requires a local auth token.

Clients may authenticate either way:

- tokenized URL: `http://127.0.0.1:<port>/mcp?token=<token>`;
- Bearer header: `Authorization: Bearer <token>` against
  `http://127.0.0.1:<port>/mcp`.

Streamable HTTP requests should advertise:

```text
Accept: application/json, text/event-stream
```

## Tools

Tool names may be exposed directly, such as `get_workspace`, or namespaced by
your client, such as `mcp__repotrail__get_workspace`.

| Tool | Use for |
| --- | --- |
| `get_workspace` | Confirm the VS Code window and list a bounded set of workspace files. Always call first. |
| `start_tour` | Initialize a tour with `kind`, `title`, and optional `summary`. |
| `add_step` | Append a step with `title`, workspace-relative `file`, markdown `explanation`, and optional 1-indexed `range`. |
| `insert_step` | Insert a step at 0-indexed `at`, usually for deepening after the current step. |
| `update_step` | Replace an existing step at `index`. |
| `remove_step` | Delete a step at `index`. |
| `show_step` | Jump to a step by index. Call once at the end with `{ "index": 0 }`. |
| `get_state` | Inspect the current plan and selected step. |
| `end_tour` | Clear the tour. Do not call this after generating a tour unless the user asked to clear it. |

There is no polling workflow. Generate the entire tour up front, then stop. The
user navigates locally with Back/Next, CodeLens controls, and the RepoTrail
sidebar.

## Workflow

1. Call `get_workspace` and verify `workspaceRoot` matches the repository you
   are analyzing. If it does not, stop and report the mismatch.
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
- Do not use absolute paths, empty paths, or paths containing `..`; RepoTrail
  rejects files that can escape the workspace.
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
