# Changelog

## 0.14.1 - 2026-11-11

- Review links now notice when they open in the wrong checkout. A link opens
  in whichever VS Code window had focus. Slide stops, file stops and the code
  that slide nodes open read the working tree, so a tour imported into a clone
  on another branch showed missing or stale files without saying why.
  - Before loading, RepoTrail compares the files the tour reads with the PR's
    head. When they differ, a dialog names them and the folder's branch. It
    offers the worktree that has the PR's head checked out, another folder, or
    loading here anyway.
  - Opening that folder switches to the window that already has it (or the
    `.code-workspace` holding it) open, and the import continues there.
    Windows check for a waiting import when they gain focus, not only when
    they start.
  - With several clones open, the one at the PR's head is picked.
- PR comments from **Copy Tour as PR Comment** ask for a checkout of the PR,
  not any clone, when the tour reads the working tree. They also say slides
  need RepoTrail 0.14 or later, since older versions show slide stops as plain
  stops. Diff-only tours keep "any clone of this repo".
- **Copy Tour as PR Comment** no longer says the link lacks a head SHA for
  tours that have no diff stops.

## 0.14.0 - 2026-11-11

- Added slides, for walking through design docs. A tour stop with a `slide`
  object shows a 16:9 slide in a RepoTrail Slides tab instead of opening a
  file. Slide stops and code stops take turns in the same editor column. Tours
  get a new `design-review` kind.
  - Slides hold text, bullets, tables, short code snippets, callouts, flow
    diagrams laid out automatically, and sequence diagrams, in `stack`,
    `columns`, or `title` layouts.
  - A slide's optional `file` and `range` name the doc section it summarizes,
    which Open source file opens.
  - Diagram nodes, sequence participants, and code blocks can carry a `ref`.
    Clicking one opens that file beside the slide.
  - Problems in slide JSON show on the slide and in Output ▸ RepoTrail.
- Slides build up in beats.
  - Beats reveal and hide elements, change labels and colors, spotlight or
    highlight part of the slide, send tokens along diagram edges, and pulse
    elements. Nothing moves when they do. `build: true` reveals bullets, table
    rows, or sequence messages one at a time.
  - Next and Back step through a slide's beats before changing stops. Back
    from a slide's first beat shows the previous slide finished. **RepoTrail:
    Next Stop** (⇧⌥→) skips the remaining beats.
  - In a slide, the arrow keys, Space, PageUp/PageDown, and presentation
    clickers move through the tour.
  - Each beat's `say` shows as a caption and in a transcript under the
    narration, and Read aloud speaks it.
  - When consecutive slides share node ids, the shared nodes glide to their
    new places instead of the slide cutting over.
  - New settings: `repoTrail.slides.motion` (`full`, `reduced`, `off`) and
    `repoTrail.slides.captions`.
- Added ways to present a tour.
  - **RepoTrail: Present Tour** hides the side bars and panel and turns
    captions on. `Esc` in a slide leaves present mode.
  - **RepoTrail: Play Tour** narrates each stop and beat and moves on when
    the narration ends, or after a reading pause when narration is off.
    Moving by hand while it plays continues from there.
  - Both are in the tour panel's ☰ menu, and `P` in a slide toggles play.
  - The tour sidebar keeps running while hidden, so narration continues in
    present mode.
- Added an authoring API for agents.
  - The skill has a "Design Reviews And Slides" section: when a design doc or
    RFC should become a slide tour, the slide format, text budgets, and a
    method for building a design review.
  - `harness/tour.schema.json` describes the tour file. VS Code checks
    `.repotrail/*.json` files against it.
  - The extension ships `out/cli.js` for agents. `lint` checks a tour against
    the schema, beat ids, source files, and the skill's text budgets.
    `render` writes the animated HTML player without VS Code.
  - **Agent setup** sends design docs to slide tours and includes the schema
    and CLI paths.
- Export Tour includes slides.
  - Animated HTML plays them with their beats, and `#stop=<n>&beat=<k>` opens
    any position.
  - Markdown writes slide diagrams as Mermaid, which GitHub renders.
- **Comment on PR** explains when the current slide has no source file to
  comment on.

## 0.13.1 - 2026-11-11

- Added PR comments from the trail, through the GitHub Pull Requests
  extension.
  - When that extension has the tour's PR checked out, diff stops show the
    working-tree file as their new side, so its `+` comment gutter works in
    the tour. This holds even when the PR has moved past the tour's commit.
    For tours without a known PR, the checkout must contain the stop's
    `headRef` and the default branch must not.
  - **Comment on PR…** in the ☰ menu (`RepoTrail: Comment on PR`) reopens the
    stop on the checked-out file. If the PR isn't checked out, it offers that
    extension's **Check Out PR** and reopens the stop once the checkout lands.
    It also offers to open the stop's file in the PR on github.com.
  - Tours imported from a PR remember which PR they came from.
  - RepoTrail still never posts to GitHub.
- Added ways to close and delete tours.
  - A × button in the tour toolbar and in the panel's title bar closes the
    active tour. "Stop tour" is now "Close tour" everywhere.
  - **Delete** in the library, **Delete tour…** in the ☰ menu, and
    `RepoTrail: Delete Tour…` move a tour's `.repotrail/*.json` file to the
    trash after a confirmation and forget your progress in it.
- The library and the active tour now notice when the whole `.repotrail/`
  folder is deleted or restored outside VS Code. Before, only changes to
  single tour files were picked up, so a deleted folder left its tours listed
  until a reload. A missed change is also caught when the window regains
  focus.
- Review links no longer fail silently.
  - The sign-in prompt for private repositories and the "no open folder is a
    clone" prompt are now dialogs instead of notifications that were easy to
    miss. The second one names the folders the window has open, because VS
    Code sends a link to the last window used.
  - Quick picks stay open when focus moves.
  - The confirmation says when the tour replaces one you have open.
  - The output channel logs where an import stopped.
- An anchor now matches when its line is the first non-empty line of a stop's
  range. Before, ranges that start on a blank line were flagged as moved.
- When the working tree differs from a pinned diff's `headRef`, the stop's
  anchor is captured from the file at `headRef` rather than from the working
  tree.

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
