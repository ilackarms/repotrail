# Changelog

## 0.10.3 - 2026-06-22

- Preserved active TTS playback across same-step sidebar refreshes so Pause and
  Resume no longer collapse back into starting narration from the beginning.

## 0.10.2 - 2026-06-22

- Added an `open_workspace` MCP helper so agents attached to the wrong VS Code
  window can ask RepoTrail to open an absolute folder or `.code-workspace` path
  before reconnecting.
- Clarified the served skill, bootstrap metadata, and harness docs around
  repo-local `.repotrail/*.json` tours, raw Streamable HTTP clients, and
  RepoTrail's stateless MCP session behavior.

## 0.10.1 - 2026-06-11

- Improved diff-tour playback so review tours stay workspace-aware, use a
  single editor surface, avoid stale diff editors, and can jump back to editable
  source files.
- Made tours more portable and file-first with readable exports, repo-shared
  saved tours, migration support, and root-alias resolution during playback.
- Refined the sidebar controls and agent guidance around the workspace-first MCP
  tour flow.
- Kept narration user-initiated by preventing background tour steps from
  starting hosted speech.

## 0.10.0 - 2026-06-01

- Renamed the extension to RepoTrail for the first public Marketplace release.
- Made external MCP agents the supported tour-generation path.
- Served the generic RepoTrail skill and bootstrap metadata from the local
  token-authenticated HTTP server.
- Added a direct **Connect agent** sidebar button and simplified setup command.
- Renamed command-palette setup actions to match what they actually do.
- Removed vendor-specific skill installation from the extension; agents fetch
  and install or apply the hosted `repo-trail` skill with their own mechanism.
- Added token-authenticated local MCP URLs under `~/.repotrail/ports.json`.
- Rejected unauthenticated MCP calls and workspace-escaping tour step files.
- Added generic harness guidance under `harness/README.md` and the single
  served `repo-trail` skill under `harness/repo-trail/`.
- Added route navigation polish: CodeLens controls, keyboard navigation,
  auto-resume, seen-state route dimming, and repo-shared `.repotrail/` tours.
- Added public Marketplace metadata, privacy documentation, and launch assets.
