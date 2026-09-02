# RepoTrail Harness Contract

RepoTrail is harness-agnostic. The primary artifact is a complete JSON tour
file under `.repotrail/`. The VS Code extension lists those files, watches them
for changes, and plays them back. Writing that file is the complete authoring
contract.

The single skill source lives in `harness/repo-trail/SKILL.md`. The agent or
harness installs or applies those instructions through its own skill mechanism.
The prompt copied from RepoTrail includes the open workspace roots and JSON
schema; the extension does not require a connection to the agent.

## Supported Modes

RepoTrail has two supported harness modes.

### Existing VS Code Workspace

Use this when the user already has the target roots open in VS Code.

1. Open the target workspace in VS Code.
2. Click **Agent setup** in the RepoTrail sidebar, or run
   **RepoTrail: Agent Setup**.
3. Paste the copied prompt into the agent.
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

## Required Tour Workflow

1. Pick existing-workspace mode or agent-created-workspace mode.
2. Read the repo before choosing stops.
3. Write one complete tour file to `<owning-project>/.repotrail/<slug>.json`.
4. Stop and let the user open the tour from the RepoTrail sidebar.

For deepening or follow-up requests, edit the owning `.repotrail/*.json` file or
write a revised copy. Keep the full route coherent rather than writing partial
updates anywhere else.

## Workspace Files

Workspace files are ordinary VS Code workspaces:

```json
{
  "folders": [
    { "name": "project-pr-123", "path": "/absolute/path/to/project-pr-123" },
    { "name": "dependency-pr-456", "path": "/absolute/path/to/dependency-pr-456" }
  ]
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

## Tour Files

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
