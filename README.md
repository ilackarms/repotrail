# RepoTrail

**Agent-guided codebase tours inside VS Code.**

RepoTrail turns a repo walkthrough JSON file into an editor-native route: your
agent writes `.repotrail/*.json`, RepoTrail opens native git-backed diffs for
change reviews or highlights tight ranges for codebase tours, shows narration,
and lets you move through the route with Back/Next, CodeLens, and the sidebar.

![RepoTrail sidebar](media/sidebar.png)

## How It Works

RepoTrail has one supported generation path: an external agent writes a complete
tour JSON file.

You can use it two ways:

1. Existing workspace: open one or more project roots in VS Code, then ask your
   agent to write `.repotrail/<tour>.json` in the owning project.
2. Agent-created workspace: ask your agent to check out the needed repos or
   worktrees, save a `.code-workspace` under `~/.repotrail/workspaces/`, open it
   in VS Code, and write the tour JSON into the owning project.

RepoTrail refreshes its sidebar library from the filesystem. Open the tour and
navigate locally in VS Code.

The extension does not ship a built-in LLM provider and does not send source
code to a hosted service by itself.

## Author A Tour In The Current Workspace

After installing the extension, open the target workspace in VS Code, open the
RepoTrail sidebar, and click **Copy authoring prompt**. Paste that prompt into
your agent.

You can also run this command:

```text
RepoTrail: Copy Tour Prompt
```

The copied prompt includes the open workspace roots, the tour schema, and the
path where the agent should write the completed JSON file. Existing integrations
that invoke the old `repoTrail.copyAgentSetup` command ID receive the same
prompt.

Then ask:

```text
Use the repo-trail skill. Create a RepoTrail tour for the current VS Code workspace. Read the repo, then write one complete JSON tour into the owning project's .repotrail/ directory. If this is about a PR, commit, branch comparison, diff, or changes, use git-backed diff stops with baseRef/headRef instead of pasted code. Use highlight-only stops only for codebase/subsystem tours unrelated to a change window.
```

## Create A New RepoTrail Workspace

If you want the agent to set up the workspace too, install or paste the
[`repo-trail` skill](harness/repo-trail/SKILL.md) and ask:

```text
Use the repo-trail skill. Create a RepoTrail workspace for <repo or PR>. Check out any needed non-destructive worktrees, save the .code-workspace under ~/.repotrail/workspaces, open it in VS Code if possible, then write a RepoTrail JSON tour into the owning repo's .repotrail/ directory.
```

The global workspace directory is only a launch registry:

```text
~/.repotrail/workspaces/<workspace-slug>.code-workspace
~/.repotrail/workspaces/<workspace-slug>.manifest.json
```

Tours still live in the project that owns them:

```text
<project>/.repotrail/<tour>.json
```

## Tour JSON Files

Shared tours live in the repo that owns them:

```text
<project>/.repotrail/architecture.json
<project>/.repotrail/pr-walkthrough.json
```

RepoTrail accepts exported envelopes, stored records, and bare `TourPlan` JSON.
The preferred envelope is `repoTrailTour: 2` with `plan.roots` aliases and
per-step `root` values for multi-root tours. Older `workspaceFolder` steps still
work.

## Features

- Full-route tours for architecture, PR/diff walkthroughs, file walkthroughs,
  request lifecycle traces, and bug investigation paths.
- Cross-repo tours in multi-root VS Code windows via `plan.roots` aliases or
  legacy per-step `workspaceFolder` addressing.
- Tight highlighted ranges with auto-captured anchors that detect code drift.
- Native git-backed full-file diff steps for PRs, commits, branch comparisons,
  and other change reviews. Highlight-only code stops stay available for
  codebase/subsystem tours unrelated to a change window.
- Sidebar route list with seen-state dimming and current-step narration.
- CodeLens controls above highlighted stops.
- Keyboard navigation with `Alt+Left` and `Alt+Right`.
- Optional narration via system speech, local Kokoro, macOS/Linux command TTS,
  ElevenLabs, or OpenAI TTS.
- Repository tour library backed by `.repotrail/*.json` across every open
  workspace root.
- Automatic reload when the active tour JSON changes, with the current stop
  preserved when possible.
- Agent-created VS Code workspace flow backed by
  `~/.repotrail/workspaces/*.code-workspace`.
- Non-destructive migration from compatible old saved tours in
  `~/.repotrail/tours/` into repo-local `.repotrail/*.json` files.
- Export to Markdown, JSON, or standalone animated HTML with browser playback,
  embedded code/diff frames, and standalone TTS controls; import JSON tours.
- Per-workspace resume from `~/.repotrail/tours/`.

## Security And Privacy

- RepoTrail has no local network listener. Tour authoring happens through files
  in `.repotrail/`.
- Tour step files must be workspace-relative and cannot escape their selected
  workspace folder.
- Hosted TTS providers are opt-in and require your own API key. Audio requests
  are made by the extension host, not the webview.
- RepoTrail itself does not collect telemetry.

See [PRIVACY.md](PRIVACY.md) for the longer policy.

## Commands

- `RepoTrail: Copy Tour Prompt` - copy a file-authoring prompt for your agent.
- `RepoTrail: Copy Tour From Here Prompt` - copy a prompt scoped to the active
  file or selection.
- `RepoTrail: Export Tour` - export Markdown, re-importable JSON, or a
  browser-playable animated HTML walkthrough.
- `RepoTrail: Import Tour`.
- `RepoTrail: Rename Tour` - change the visible tour title without renaming
  the `.repotrail/*.json` file.
- `RepoTrail: Save Tour to Repo (.repotrail/)`.
- `RepoTrail: Migrate Saved Tours to Repo (.repotrail/)`.
- `RepoTrail: Resume Saved Tour` / `RepoTrail: Delete Saved Tour`.

## Development

```bash
pnpm install
pnpm build
pnpm package
pnpm install-local
```

The primary validation gate is `pnpm build`. The packaged VSIX is installed
locally with `pnpm install-local`.

## Animated HTML Export

`RepoTrail: Export Tour` -> `Animated HTML (.html)` writes a standalone browser
player for the active tour. The file embeds the tour route, narration, bounded
code snapshots, and diff frames, so it can be opened outside VS Code or shared as
a single artifact.

The exported player includes Back/Next, Play, Speak, and TTS settings. It carries
non-secret VS Code TTS defaults such as provider, model, and voice. API keys are
not embedded; hosted OpenAI or ElevenLabs speech requires entering a key in the
browser, where it is stored only in that browser's local storage. Command-based
voices such as macOS `say` cannot run from a browser page.

## Limitations

- RepoTrail plays tours; it does not generate them. Use an external agent or
  write the JSON file yourself.
- RepoTrail is read-only. It navigates and explains code; it does not refactor
  files.
- Open VSX publishing is not currently part of the release flow.
