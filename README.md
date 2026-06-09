# RepoTrail

**Agent-guided codebase tours inside VS Code.**

RepoTrail turns a repo walkthrough JSON file into an editor-native route: your
agent writes `.repotrail/*.json`, RepoTrail opens the files, highlights tight
ranges, shows narration, and lets you move through the route with Back/Next,
CodeLens, and the sidebar.

![RepoTrail sidebar](media/sidebar.png)

## How It Works

RepoTrail has one supported generation path: an external agent writes a complete
tour JSON file.

1. Open one or more project roots in VS Code.
2. Ask your agent to read the repo and write `.repotrail/<tour>.json` in the
   owning project.
3. RepoTrail refreshes its sidebar library from the filesystem.
4. Open the tour and navigate locally in VS Code.

The extension does not ship a built-in LLM provider and does not send source
code to a hosted service by itself.

## Author A Tour

After installing the extension, open the target workspace in VS Code, open the
RepoTrail sidebar, and click **Copy authoring prompt**. Paste that prompt into
your agent.

You can also run this command:

```text
RepoTrail: Copy Agent Setup
```

`RepoTrail: Copy Agent Setup` includes the same file-authoring instructions plus
optional helper endpoints. When enabled, the local MCP helper lets an agent
fetch:

- the machine-readable setup metadata from `/bootstrap?token=...`;
- the generic RepoTrail skill from `/skill.md?token=...`;
- the tokenized Streamable HTTP MCP URL at `/mcp?token=...` for workspace
  discovery or legacy live updates.

Then ask:

```text
Give me a RepoTrail tour of this repository.
```

![RepoTrail MCP setup](media/mcp-setup.png)

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
- Native diff steps for PR/change tours, with code-only, diff-only, or combined
  code highlight plus diff views.
- Sidebar route list with seen-state dimming and current-step narration.
- CodeLens controls above highlighted stops.
- Keyboard navigation with `Alt+Left`, `Alt+Right`, and `Alt+P`.
- Optional narration via system speech, local Kokoro, macOS/Linux command TTS,
  ElevenLabs, or OpenAI TTS.
- Repository tour library backed by `.repotrail/*.json` across every open
  workspace root.
- Non-destructive migration from compatible old saved tours in
  `~/.repotrail/tours/` into repo-local `.repotrail/*.json` files.
- Export to Markdown, JSON, or standalone animated HTML with browser playback,
  embedded code/diff frames, and standalone TTS controls; import JSON tours.
- Per-workspace resume from `~/.repotrail/tours/`.

## Security And Privacy

- The optional MCP helper server binds only to `127.0.0.1`.
- `/mcp` requires an unguessable local auth token. RepoTrail writes the live
  tokenized URL to `~/.repotrail/ports.json` and copies that URL in setup
  commands.
- Tour step files must be workspace-relative and cannot escape their selected
  workspace folder.
- Hosted TTS providers are opt-in and require your own API key. Audio requests
  are made by the extension host, not the webview.
- RepoTrail itself does not collect telemetry.

See [PRIVACY.md](PRIVACY.md) for the longer policy.

## Commands

- `RepoTrail: Copy Tour Prompt` - copy a file-authoring prompt for your agent.
- `RepoTrail: Copy Agent Setup` - copy workspace details, schema, and optional
  helper endpoints for your agent.
- `RepoTrail: Copy Tour From Here Prompt` - copy a prompt scoped to the active
  file or selection.
- `RepoTrail: Export Tour` - export Markdown, re-importable JSON, or a
  browser-playable animated HTML walkthrough.
- `RepoTrail: Import Tour`.
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

- MCP is optional. Clients that use the helper server must support Streamable
  HTTP, and some clients need a new session after MCP registration so they can
  load the `mcp__repotrail__*` tools.
- RepoTrail is read-only. It navigates and explains code; it does not refactor
  files.
- Open VSX publishing is not part of the first launch.
