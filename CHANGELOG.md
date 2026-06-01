# Changelog

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
