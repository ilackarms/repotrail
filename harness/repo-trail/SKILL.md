---
name: repo-trail
description: Create or use a VS Code workspace and generate an interactive RepoTrail tour by writing a complete .repotrail JSON file.
---

# RepoTrail Agent Skill

RepoTrail is the VS Code editor surface for agent-guided codebase tours. You
are the analysis and orchestration engine. The durable tour artifact is a
complete JSON file under the owning project's `.repotrail/` directory.
RepoTrail watches those files, lists them in the sidebar, and plays them back in
VS Code.

Install or use this skill in your current session before creating a RepoTrail
tour. If your agent supports persistent skills, save this document as the
`repo-trail` skill. If it does not, treat this document as the active harness
instructions for the current request.

## Supported Modes

RepoTrail supports two operating modes. Pick the mode from the user's request.
If the user is already in VS Code or says "current workspace", use Mode A. If
the user asks you to prepare a workspace, check out a PR, open VS Code, or create
a RepoTrail workspace, use Mode B.

### Mode A: Existing VS Code Workspace

Use this when the target roots are already open in VS Code.

1. Discover the open roots. If optional MCP helpers are available, call
   `get_workspace`; otherwise use the paths the user gave you or the current
   shell workspace.
2. Read the repo or repos for real.
3. Write one complete tour JSON file to the owning project's `.repotrail/`
   directory.
4. Tell the user the file path and stop. RepoTrail refreshes from the
   filesystem.

### Mode B: New RepoTrail Workspace

Use this when the user wants you to create the workspace as part of the flow.

1. Determine the repo roots, PRs, branches, or worktrees needed for the tour.
2. Create or reuse non-destructive local checkouts/worktrees. Do not overwrite
   existing directories. Prefer new worktree directories for PR review lanes.
3. Save a VS Code workspace file under the global RepoTrail workspace registry:
   `~/.repotrail/workspaces/<workspace-slug>.code-workspace`.
4. Optionally save a small manifest next to it:
   `~/.repotrail/workspaces/<workspace-slug>.manifest.json`.
5. Open VS Code on the workspace file, usually with:

   ```bash
   code ~/.repotrail/workspaces/<workspace-slug>.code-workspace
   ```

   If the `code` command is not available, still create the workspace file and
   tell the user exactly where it is.
6. Write one or more complete tour JSON files into the owning repo roots'
   `.repotrail/` directories.
7. Tell the user the workspace file path and tour file path.

The global workspace registry stores workspace launch files and manifests only.
Do not store tours there. The source of truth for tours is always the repo-local
`.repotrail/*.json` file.

Example `.code-workspace`:

```json
{
  "folders": [
    { "name": "app-pr-123", "path": "/absolute/path/to/app-pr-123" },
    { "name": "api-pr-456", "path": "/absolute/path/to/api-pr-456" }
  ],
  "settings": {
    "repoTrail.mcpEnabled": true
  }
}
```

Example manifest:

```json
{
  "repoTrailWorkspace": 1,
  "createdAt": "2026-06-09T00:00:00.000Z",
  "title": "Checkout and billing PR review",
  "workspaceFile": "checkout-billing-pr-review.code-workspace",
  "roots": [
    {
      "name": "app-pr-123",
      "path": "/absolute/path/to/app-pr-123",
      "source": "https://github.com/org/app/pull/123"
    }
  ],
  "tours": [
    {
      "root": "app-pr-123",
      "path": "/absolute/path/to/app-pr-123/.repotrail/pr-walkthrough.json"
    }
  ]
}
```

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

## Tour Workflow

1. Pick Mode A or Mode B.
2. Pick the tour kind. If unclear, infer the best kind from the request:
   architecture, pr-diff, file-walkthrough, request-lifecycle, or
   bug-investigation.
3. In Mode B, prepare the VS Code workspace first so root names and tour aliases
   match what the user will see in the editor.
4. Read the repo for real: README, manifests, entrypoints, routing, core domain
   code, storage/IO, and relevant tests. Use search and file reads before
   choosing line ranges.
5. Plan the route. Order stops so each one builds on the previous one.
6. Write one complete JSON file to the owning project's `.repotrail/` directory,
   for example `.repotrail/architecture.json`.
7. Tell the user: "Tour ready -- wrote `.repotrail/<file>.json` with X stops.
   Open it from the RepoTrail sidebar."

If a request spans multiple repos, write the tour into the repo that owns the
story. Reference the other open roots with `plan.roots` aliases and each step's
`root` field.

## Presentation Mode Decision

Most RepoTrail requests are reviews of a PR, multiple PRs, a commit, multiple
commits, a branch comparison, or another explicit window of changes. Treat those
as change-review tours:

- Use `kind: "pr-diff"` unless the user clearly requested a different kind.
- Every changed-code stop must be diff-backed with `viewMode: "diff"` and
  `diff.beforeText`.
- Omit `diff.afterText` when the current `file` plus `range` is the right side
  of the diff.
- Do not fall back to highlight-only changed-code stops because the base text
  takes effort to find. Inspect the base branch, PR diff, commit, or `git show`
  output and build a focused hunk.

Use highlight-only `viewMode: "code"` only when the user asks for a tour of the
codebase itself, a file, a subsystem, a request path, or architecture unrelated
to any window of changes. A change-review tour may include a small number of
highlight-only orientation/context stops, but stops that review changed code
must be diffs.

## Workspace Orchestration Rules

- Keep workspace creation simple: a `.code-workspace` file with named absolute
  folder paths is enough.
- Keep root names stable and human-readable. Reuse those names as `plan.roots`
  aliases when possible, normalized to JSON-friendly keys.
- Prefer worktrees over mutating an existing checkout when reviewing a PR or
  comparing branches.
- Do not delete, reset, or overwrite local work without explicit user
  instruction.
- Do not make the VS Code extension responsible for git or worktree creation.
  The agent creates workspaces and writes tour files; the extension reads and
  plays them.
- If multiple `.repotrail/*.json` files belong to one workspace, list all of
  them in the optional manifest.
- The user may open a created workspace later by opening the `.code-workspace`
  file from `~/.repotrail/workspaces/`.

## Quick Prompts

Current workspace:

```text
Use the repo-trail skill. Create a RepoTrail tour for the current VS Code workspace. Read the repo, then write one complete JSON tour into the owning project's .repotrail/ directory. If this is about a PR, commit, branch comparison, diff, or changes, use diff-backed changed-code stops. Use highlight-only stops only for codebase/subsystem tours unrelated to a change window. Do not build it through sequential MCP calls.
```

New workspace:

```text
Use the repo-trail skill. Create a RepoTrail workspace for <repo or PR>. Check out any needed non-destructive worktrees, save the .code-workspace under ~/.repotrail/workspaces, open it in VS Code if possible, then write a RepoTrail JSON tour into the owning repo's .repotrail/ directory.
```

PR walkthrough:

```text
Use the repo-trail skill. Create a PR walkthrough tour for <PR URL>. Prepare a VS Code workspace if needed, use diff-backed stops for the meaningful changed hunks, and save the tour as .repotrail/pr-walkthrough.json in the repo that owns the PR.
```

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
- For PRs, commits, branch comparisons, and other change-review tours, use
  `viewMode: "diff"` with `diff.beforeText` for changed-code stops so the user
  gets one compact native VS Code diff instead of a highlight-only code view.
- Use highlight-only `viewMode: "code"` only for codebase/subsystem tours
  unrelated to a change window, or for optional orientation/context stops that
  are not reviewing a changed hunk.
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
