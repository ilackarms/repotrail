# Changelog

## Unreleased

- Tours can include slide stops: a step with a `slide` object shows a 16:9
  slide in a RepoTrail Slides tab in the editor area instead of opening a file.
  Slides hold text, bullets, tables, code snippets, callouts, and flow diagrams
  with automatic layout, in `stack`, `columns`, or `title` layouts. Slide and
  code stops take turns in the same editor column, and →, ←, Space, PageUp and
  PageDown in the slide move through the tour. A slide's optional `file` and
  `range` name its source, which Open source file opens. Problems in slide
  JSON show on the slide and in Output ▸ RepoTrail. Tours get a new
  `design-review` kind.
- Slides build up in beats. Next and Back step through a slide's beats before
  moving to another stop, and Back from a slide's first beat shows the previous
  slide finished. **RepoTrail: Next Stop** (⇧⌥→, or ⇧→ in the slide) skips the
  rest. Beats reveal and hide elements, change labels and colors, spotlight or
  highlight parts of the slide, send tokens along diagram edges, and pulse
  elements; nothing moves when they do. Each beat's `say` shows as a caption,
  in a transcript under the narration, and is what Read aloud speaks.
- Added sequence diagrams (`type: "sequence"`) and `build: true`, which
  reveals bullets, table rows, or sequence messages one beat at a time.
- New settings: `repoTrail.slides.motion` (`full`, `reduced`, `off`) and
  `repoTrail.slides.captions`.

## 0.13.0 - 2026-11-11

- Compacted the tour panel. Back and Next share one toolbar row with a
  play/pause icon and a ☰ menu that holds Jump to step code, Open source file,
  Copy deepen prompt, Export tour, Narration settings, and Stop tour. The route
  list starts collapsed, the follow-up box moved to a footer, and Back/Next
  tooltips name the stop they go to.
- Narration now renders as markdown (paragraphs, lists, bold, italics, and
  code) instead of raw text. Links, images, and HTML stay plain text.
- Added PR review tours. `RepoTrail: Copy Tour as PR Comment` copies a GitHub
  comment with an Open in VS Code link, an agent setup prompt for reviewers
  without the extension, and the tour JSON. Reviewers open it from the link,
  `RepoTrail: Import Tour from GitHub PR`, or `RepoTrail: Find Tours on a PR`:
  RepoTrail reads the PR's comments from api.github.com (with VS Code's GitHub
  sign-in for private repos), plays the tour in an open clone of the
  repository, and asks before fetching `pull/<n>/head` when commits are
  missing. Links use `vscode://repotrail.repotrail/review?pr=<owner>/<repo>/<n>`
  and are confirmed before any request. Tours from people who aren't the PR's
  author or a collaborator need an extra confirmation, imported tours stay
  inside the chosen clone, and RepoTrail warns about stops that don't show the
  PR's head and merge base.
- In a single-folder window, a tour that names one root now resolves it to the
  open folder when the name matches nothing, so tours written in one checkout
  play in a clone with a different folder name.
- Diff stops whose `baseRef` and `headRef` are commit SHAs now read the file
  at `headRef` from git whenever the working-tree file differs or is missing.
- Tour titles and paths shown in notifications can no longer form clickable
  links.

## 0.12.0 - 2026-11-09

- Made diff stops navigable with Cmd/Ctrl+click. When the right side matches
  the workspace file, the diff now shows the real file, so language features
  work natively. Git-backed sides use the built-in Git extension's documents,
  and clicks on older revisions map to the matching code or definition in the
  current file.
- Added a Tour Files view under the Tour panel: the tour's files as a folder
  tree with stop counts, the current file and stop selected as you navigate,
  and click-to-jump for files and stops.
- Wrapped tour titles, stop titles, and the current step heading instead of
  truncating them in a narrow sidebar. Library Open/Rename buttons drop below
  the title when space runs out, and Back/Next move above the heading under
  360px so long titles never shift them between steps.
- Released virtual diff text once its tab closes, so long tours no longer keep
  a copy of every visited file revision in memory.

## 0.11.0 - 2026-09-02

- Removed the local MCP/HTTP server, tokenized setup endpoints, port registry,
  server settings, connection status UI, and live tour mutation tools.
- Made complete `.repotrail/*.json` files the only authoring interface. The
  Agent setup prompt now carries the open roots and schema. The
  `repoTrail.copyTourPrompt` command ID remains as a compatibility alias.
- Reloaded an active repo tour when its backing JSON file changes, preserving
  the current stop when possible.
- Removed the Recent local tours section and the Import, Migrate, and Refresh
  buttons from the sidebar. Repo-local JSON files are discovered automatically;
  one-off imports remain available from the Command Palette.
- Reused one progress record per repo tour instead of creating another record
  every time the same JSON file is opened.
- Made Agent setup self-contained by embedding the canonical `repo-trail` skill
  from the installed extension in every copied authoring prompt.
- Replaced the auto-resume preference with direct state tracking: tours that are
  active when VS Code closes return after reload, while Stop clears the marker.
- Moved hosted TTS credentials out of `settings.json` and into VS Code
  SecretStorage, with automatic migration and a credential-management command.
- Grouped narration settings, moved model and command overrides into an advanced
  section, added a Kokoro voice picker, and centralized TTS defaults used by the
  extension and animated HTML exports.

## 0.10.4 - 2026-06-23

- Added the `RepoTrail: Copy Selection Reference` command for copying a
  workspace-relative file/line reference with the selected full-line code block.

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
