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

1. Identify the open roots from the copied RepoTrail authoring prompt, the
   paths the user gave you, or the current shell workspace.
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
  ]
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

## File Contract

Write the entire tour file before reporting completion. The user opens and
navigates it locally with Back/Next, CodeLens controls, and the RepoTrail
sidebar. For a follow-up, rewrite the complete JSON route so the file remains a
self-contained tour.

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
- Every changed-code stop must be diff-backed with `viewMode: "diff"` plus a
  git-backed `diff.baseRef`; add `diff.headRef` when the right side should be a
  commit instead of the current workspace file.
- Use `diff.scope: "file"` for normal PR/commit review stops so RepoTrail reads
  real full-file contents from local git and VS Code can show unchanged
  surrounding code.
- Do not paste generated code into `diff.beforeText` or `diff.afterText` for
  git-backed reviews. The agent identifies refs, paths, and ranges; RepoTrail
  materializes the actual diff.

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
Use the repo-trail skill. Create a RepoTrail tour for the current VS Code workspace. Read the repo, then write one complete JSON tour into the owning project's .repotrail/ directory. If this is about a PR, commit, branch comparison, diff, or changes, use diff-backed changed-code stops. Use highlight-only stops only for codebase/subsystem tours unrelated to a change window.
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

Git-backed change-review step example:

```json
{
  "root": "project",
  "file": "src/example.ts",
  "range": { "startLine": 42, "startColumn": 1, "endLine": 68, "endColumn": 1 },
  "title": "Tighten request validation",
  "explanation": "Explain why this changed hunk matters.",
  "viewMode": "diff",
  "diff": {
    "baseRef": "BASE_SHA_OR_REF",
    "headRef": "HEAD_SHA_OR_REF",
    "scope": "file"
  }
}
```

If the workspace is already checked out at the right side of the change, omit
`headRef`; RepoTrail will compare `baseRef` to the current workspace file.

## Step Quality Rules

- One logical chunk equals one step.
- Split explanations that say "first, then, then" into separate steps.
- Keep ranges tight and 1-indexed. If you did not read the file, do not invent
  a range.
- For PRs, commits, branch comparisons, and other change-review tours, use
  `viewMode: "diff"` with `diff.baseRef` for changed-code stops so the user
  gets a native VS Code diff from real local git contents instead of
  agent-generated snippets.
- Prefer `diff.scope: "file"` for changed-code stops. This lets the user scroll
  imports and surrounding unchanged code while VS Code highlights only the real
  changes.
- Omit `diff.headRef` when the current workspace file is the right side. Set
  `diff.headRef` only when the right side should be a specific commit/SHA.
- Use `diff.baseFile` or `diff.headFile` only for renames where the path differs
  between refs.
- Use highlight-only `viewMode: "code"` only for codebase/subsystem tours
  unrelated to a change window, or for optional orientation/context stops that
  are not reviewing a changed hunk.
- `diff.beforeText` and `diff.afterText` remain accepted for non-git sources and
  old tours, but do not use them for normal PR/commit tours.
- Use workspace-relative forward-slash file paths only.
- For multi-root VS Code windows, define `plan.roots` aliases and set `root` on
  each step. Prefer portable `{ "name": "...", "pathHint": "..." }` root refs.
  `workspaceFolder` is still accepted for backward compatibility.
- Do not use absolute paths, empty paths, or paths containing `..`; RepoTrail
  rejects files that can escape the selected workspace folder.
- Explanations should be markdown, usually 2-4 short paragraphs.
- Do not paste code into explanations; the user is looking at the code or diff
  in VS Code. Put refs and ranges in `diff`, not code text, when git can provide
  the contents.

## Deepening And Follow-Ups

When the user asks to deepen or refine a tour:

1. Identify the relevant `.repotrail/*.json` file, or write a revised copy if
   the active tour is local-only.
2. Read the relevant code.
3. Edit the JSON so the complete route remains coherent.
4. Confirm the changed path and stop count in chat.
