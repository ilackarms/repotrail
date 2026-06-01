# RepoTrail

**Agent-guided codebase tours inside VS Code.**

RepoTrail turns a repo walkthrough into an editor-native route: your
MCP-capable agent chooses the stops, RepoTrail opens the files, highlights
tight ranges, shows narration, and lets you move through the route with
Back/Next, CodeLens, and the sidebar.

![RepoTrail sidebar](media/sidebar.png)

## How It Works

RepoTrail has one supported generation path: an external MCP-capable agent
drives the extension over the local RepoTrail MCP server.

1. The VS Code extension runs a local MCP server on `127.0.0.1`.
2. Your agent or harness connects to that MCP server.
3. The agent reads your repo, emits a complete tour up front, and lands the
   editor on stop 1.
4. You navigate locally in VS Code. Follow-ups and "go deeper" prompts return
   to the agent, which can insert or update tour steps.

The extension does not ship a built-in LLM provider and does not send source
code to a hosted service by itself.

## Bootstrap Any Agent

After installing the extension, open the target workspace in VS Code and run:

```text
RepoTrail: Show MCP Setup
```

Choose **Copy agent bootstrap** and paste it into your agent. The bootstrap
prompt tells the agent to fetch:

- the machine-readable setup metadata from `/bootstrap?token=...`;
- the generic RepoTrail skill from `/skill.md?token=...`;
- the tokenized Streamable HTTP MCP URL at `/mcp?token=...`.

Once connected, ask:

```text
Give me a RepoTrail tour of this repository.
```

![RepoTrail MCP setup](media/mcp-setup.png)

## Optional Claude Code Adapter

Claude Code can use the hosted generic skill, or you can install the bundled
adapter locally:

```text
RepoTrail: Install Claude Code Skill
```

That installs the Claude adapter to `~/.claude/skills/repotrail/`. Then run
**RepoTrail: Show MCP Setup**, copy the `claude mcp add --scope user
--transport http repotrail ...` command, and start a new Claude Code session.

## Use Any MCP-Capable Agent

Claude Code is the bundled convenience adapter, not a protocol requirement.
RepoTrail supports any local agent or harness that can fetch the hosted skill
and call a Streamable HTTP MCP server with either:

- the tokenized URL copied by **RepoTrail: Show MCP Setup**, or
- the same `/mcp` URL without `?token=...` plus `Authorization: Bearer <token>`.

Streamable HTTP requests should advertise `Accept: application/json,
text/event-stream`.

For non-Claude clients, copy **Agent bootstrap** or **Generic MCP config** from
**RepoTrail: Show MCP Setup**. The agent should:

1. Call `get_workspace` and verify `workspaceRoot` matches the current repo.
2. Call `start_tour`.
3. Add all steps up front with `add_step`.
4. Call `show_step({ "index": 0 })`.

The full generic tool contract is documented in [harness/README.md](harness/README.md)
and served by the extension at `/skill.md?token=...`.

Once connected, ask:

```text
Give me a RepoTrail tour of this repository.
```

## Features

- Full-route tours for architecture, PR/diff walkthroughs, file walkthroughs,
  request lifecycle traces, and bug investigation paths.
- Tight highlighted ranges with auto-captured anchors that detect code drift.
- Sidebar route list with seen-state dimming and current-step narration.
- CodeLens controls above highlighted stops.
- Keyboard navigation with `Alt+Left`, `Alt+Right`, and `Alt+P`.
- Optional narration via system speech, local Kokoro, macOS/Linux command TTS,
  ElevenLabs, or OpenAI TTS.
- Export to Markdown or JSON, import JSON tours, and save team-shared tours in
  `.repotrail/`.
- Per-workspace resume from `~/.repotrail/tours/`.

## Security And Privacy

- The MCP server binds only to `127.0.0.1`.
- `/mcp` requires an unguessable local auth token. RepoTrail writes the live
  tokenized URL to `~/.repotrail/ports.json` and copies that URL in setup
  commands.
- MCP step files must be workspace-relative and cannot escape the workspace.
- Hosted TTS providers are opt-in and require your own API key. Audio requests
  are made by the extension host, not the webview.
- RepoTrail itself does not collect telemetry.

See [PRIVACY.md](PRIVACY.md) for the longer policy.

## Commands

- `RepoTrail: Start Tour` - copy a prompt for your connected agent.
- `RepoTrail: Copy Agent Bootstrap` - copy a prompt that tells any agent where
  to fetch the hosted RepoTrail skill and how to connect MCP.
- `RepoTrail: Install Claude Code Skill` - install the bundled Claude Code
  skill to `~/.claude/skills/repotrail/`.
- `RepoTrail: Show MCP Setup` - copy an agent bootstrap prompt, generic MCP
  config, or Claude MCP add command.
- `RepoTrail: Tour From Here` - copy a prompt scoped to the active file or
  selection.
- `RepoTrail: Export Tour` / `RepoTrail: Import Tour`.
- `RepoTrail: Save Tour to Repo (.repotrail/)`.
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

## Limitations

- MCP clients must support Streamable HTTP. Claude Code must start a new session
  after MCP registration so it can load the `mcp__repotrail__*` tools.
- RepoTrail is read-only. It navigates and explains code; it does not refactor
  files.
- Open VSX publishing is not part of the first launch.
