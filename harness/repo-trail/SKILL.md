---
name: repo-trail
description: Generate an interactive RepoTrail codebase tour by writing a complete .repotrail JSON file.
---

# RepoTrail Agent Skill

RepoTrail is the VS Code editor surface for agent-guided codebase tours. You
are the analysis engine. The primary artifact is a complete JSON tour file under
the owning project's `.repotrail/` directory. RepoTrail watches those files,
lists them in the sidebar, and plays them back in VS Code.

Install or use this skill in your current session before creating a RepoTrail
tour. If your agent supports persistent skills, save this document as the
`repo-trail` skill. If it does not, treat this document as the active harness
instructions for the current request.

## Optional Connection

If the user provided RepoTrail MCP connection details, you may use them for
workspace discovery. RepoTrail uses Streamable HTTP on `127.0.0.1` and requires
a local auth token. MCP is optional for normal authoring: do not build the tour
by calling `start_tour` and `add_step` repeatedly.

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
| `get_workspace` | Optional: confirm the VS Code window and list bounded files for each open workspace folder. |
| `start_tour` / `add_step` | Legacy/live helpers only. Do not use for normal tour creation. |
| `insert_step` / `update_step` / `remove_step` | Legacy/live helpers for an already-active in-memory tour. Prefer editing the JSON file. |
| `show_step` | Legacy/live helper to jump to a step by index. |
| `get_state` | Inspect the current plan and selected step. |
| `end_tour` | Clear the tour. Do not call this after generating a tour unless the user asked to clear it. |

There is no polling workflow. Write the entire tour file up front, then stop.
The user opens and navigates it locally with Back/Next, CodeLens controls, and
the RepoTrail sidebar.

## Workflow

1. Verify the repository you are analyzing is open in VS Code. If MCP helpers are
   available, call `get_workspace`; otherwise use the paths the user gave you.
2. Pick the tour kind. If unclear, ask the user which of: architecture, pr-diff,
   file-walkthrough, request-lifecycle, bug-investigation.
3. Read the repo for real: README, manifests, entrypoints, routing, core domain
   code, storage/IO, and relevant tests. Use search and file reads before
   choosing line ranges.
4. Plan the route. Order stops so each one builds on the previous one.
5. Write one complete JSON file to the owning project's `.repotrail/` directory,
   for example `.repotrail/architecture.json`.
6. Tell the user: "Tour ready -- wrote `.repotrail/<file>.json` with X stops.
   Open it from the RepoTrail sidebar."

## JSON Format

Use the export envelope below. RepoTrail also accepts bare `plan` objects, but
the envelope keeps schema version and export time explicit.

```json
{
  "repoTrailTour": 2,
  "exportedAt": "2026-06-09T00:00:00.000Z",
  "plan": {
    "kind": "architecture",
    "title": "Short useful tour title",
    "summary": "One paragraph describing what this tour teaches.",
    "roots": {
      "project": { "name": "repo-name", "pathHint": "repo-name" }
    },
    "steps": [
      {
        "root": "project",
        "file": "src/example.ts",
        "range": { "startLine": 1, "startColumn": 1, "endLine": 20, "endColumn": 1 },
        "title": "Explain one logical chunk",
        "explanation": "Markdown narration shown in the sidebar.",
        "viewMode": "code"
      }
    ]
  }
}
```

## Step Quality Rules

- One logical chunk equals one step.
- Split explanations that say "first, then, then" into separate steps.
- Keep ranges tight and 1-indexed. If you did not read the file, do not invent
  a range.
- For PR/diff tours, prefer `viewMode: "diff"` with `diff.beforeText` so the
  user gets one compact native VS Code diff instead of separate source and diff
  panes. Use `viewMode: "code"` only when the highlighted source is clearer than
  the diff.
- `diff.beforeText` is the previous/base text for the left side. `diff.afterText`
  is optional; omit it when the current selected lines in `file`/`range` are the
  right side. Keep both sides to a focused hunk unless full-file context is
  necessary.
- Use workspace-relative forward-slash file paths only.
- For multi-root VS Code windows, define `plan.roots` aliases and set `root` on
  each step. Prefer portable `{ "name": "...", "pathHint": "..." }` root refs.
  `workspaceFolder` is still accepted for backward compatibility.
- Do not use absolute paths, empty paths, or paths containing `..`; RepoTrail
  rejects files that can escape the selected workspace folder.
- Explanations should be markdown, usually 2-4 short paragraphs.
- Do not paste code into explanations; the user is looking at the code or diff
  in VS Code. Put changed code in `diff`, not in narration.

## Deepening And Follow-Ups

When the user asks to deepen or refine a tour:

1. Identify the relevant `.repotrail/*.json` file, or write a revised copy if
   the active tour is local-only.
2. Read the relevant code.
3. Edit the JSON so the complete route remains coherent.
4. Confirm the changed path and stop count in chat.

Never call `end_tour` unless the user explicitly asks to clear the tour.
