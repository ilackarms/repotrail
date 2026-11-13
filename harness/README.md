# RepoTrail Harness Contract

RepoTrail is harness-agnostic. The primary artifact is a complete JSON tour
file under `.repotrail/`. The VS Code extension lists those files, watches them
for changes, and plays them back. Writing that file is the complete authoring
contract.

The single skill source lives in `harness/repo-trail/SKILL.md`. **Agent setup**
includes that complete file in the copied prompt. The receiving agent can
install it through its own persistent-skill mechanism or apply it directly for
the current request.
The prompt copied from RepoTrail includes the open workspace roots and JSON
schema; the extension does not require a connection to the agent.

This folder is also a Claude Code plugin that carries the skill, for people
who don't use VS Code:

```text
/plugin install repotrail --marketplace ilackarms/repotrail
```

On Claude Code older than 2.1.275, run `/plugin marketplace add
ilackarms/repotrail` and then `/plugin install repotrail@repotrail`.

## Supported Modes

RepoTrail has three supported harness modes.

### Existing VS Code Workspace

Use this when the user already has the target roots open in VS Code.

1. Open the target workspace in VS Code.
2. Click **Agent setup** in the RepoTrail sidebar, or run
   **RepoTrail: Agent Setup**.
3. Paste the copied prompt into the agent. It contains the bundled skill and
   the workspace-specific tour request.
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

### No VS Code

Use this when the user reads the tour outside VS Code, for example in the
Claude app.

1. The agent writes the tour JSON to the owning repo's `.repotrail/`
   directory, with no workspace file.
2. The agent lints it with `npx -y repotrail lint <tour.json>`.
3. The agent renders it with
   `npx -y repotrail render <tour.json> --artifact --out <file.html>`.
4. The agent publishes the page as a Claude Artifact, or hands over the file.

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

## Slide Stops And Design Reviews

A step with a `slide` object is a slide stop: RepoTrail shows it in a
RepoTrail Slides tab in the editor area instead of opening a file. On a slide
stop `file` is optional and names the slide's source (the doc section it
summarizes), which "Open source file" opens. Slides hold `text`, `bullets`,
`table`, `code`, `callout`, `flow` and `sequence` blocks and build up in
`beats`. Use them for design reviews (`kind: "design-review"`) and for the
shape of a change at the start of a PR tour. The format is in the skill's
"Design Reviews And Slides" section.

RepoTrail reads slides forgivingly: it drops what it can't use and lists the
problems on the slide and in the RepoTrail output channel. Versions before
slides support skip slide stops that have no `file`.

## JSON Schema

`harness/tour.schema.json` (JSON Schema draft-07) describes the tour file, the
envelope or a bare plan. It's strict inside `slide`, so a misspelled field is
an error, and permissive elsewhere so older tours still pass. VS Code checks
`.repotrail/*.json` files against it while RepoTrail is installed, and the
Agent setup prompt includes its path so agents can validate what they write.

## Command Line

RepoTrail's command line ships as the `repotrail` npm package and as
`out/cli.js` inside the extension. Both take the same arguments:

```bash
npx -y repotrail lint <tour.json> [--root <dir> | --root <alias>=<dir>]... [--json]
npx -y repotrail render <tour.json> --out <file.html> [--artifact] [--root ...]...
node <extension>/out/cli.js lint <tour.json>
```

- `lint` validates against the schema and reports what RepoTrail would drop
  (unknown beat ids, unreadable stops, missing files, ranges past the end of a
  file) as errors, with exit code 1. Text over the skill's budgets and
  diagrams that will render too small are warnings.
- `render` writes the same standalone HTML player as **Export Tour → Animated
  HTML**, with slides, code read from disk, and diffs from `git show`. Open it
  at `#stop=<n>&beat=<k>` to see any position.
- `render --artifact` writes a static page for readers without VS Code, to
  publish as a Claude Artifact: HTML and SVG, no script, every stop on one
  scrolling page. Code stops carry more context, diff stops center on their
  range, and slides are drawn after their last beat with the beats' captions
  listed below.
- Files resolve against the folder that holds the tour's `.repotrail/`
  directory, or the current directory. `--root` overrides that, per alias if
  needed. Neither command writes anything but `--out`.

## Pull Request Comments

A tour for a GitHub pull request can also be posted as a PR comment, so
reviewers open it with one link instead of preparing a workspace. RepoTrail
treats an issue comment as holding a tour when one of its fenced `json` blocks
parses as an envelope with a `repoTrailTour` key.

- Pin both sides of every diff stop: `diff.baseRef` (the merge base) and
  `diff.headRef` (the PR head), as full 40-character SHAs. Pinned stops play in
  any clone that has the commits, whatever is checked out, and RepoTrail can
  fetch `pull/<n>/head` when they are missing. RepoTrail warns reviewers about
  stops whose commits aren't the PR head and merge base, or that compare against
  the working tree.
- Use one root alias with a portable `name`/`pathHint`. In a single-folder
  window, and for tours imported from a PR, an unmatched alias binds to the
  clone the reviewer has open.
- Produce the comment with **RepoTrail: Copy Tour as PR Comment**, or follow
  the same format: an intro line, the review link through
  `https://vscode.dev/redirect?url=<encoded vscode:// link>` (GitHub strips
  `vscode://` hrefs), the raw link in a code span for `code --open-url`, a
  collapsed agent setup prompt, and a collapsed `json` block with the envelope.
  Stay under GitHub's 65,536-character comment limit. Slides are the heavy
  part: a 16-stop design review is about 59,000 characters with pretty JSON.
  RepoTrail switches to compact JSON when the pretty form doesn't fit, which
  leaves room for roughly 30 slides.

The review link:

```text
vscode://repotrail.repotrail/review?pr=<owner>/<repo>/<number>[&comment=<id>][&head=<sha>]
```

Add `head` only when every diff stop shares that `headRef`, and `comment` only
once the comment exists. The extension reads GitHub and fetches only when the
reviewer asks; it never posts.
