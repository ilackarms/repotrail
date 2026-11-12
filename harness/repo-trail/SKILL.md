---
name: repo-trail
description: Generate an interactive RepoTrail codebase tour (architecture, PR walkthrough, design review) by writing a complete .repotrail JSON file, then play it in VS Code or publish it as a page anyone can open, such as a Claude Artifact. Use when the user asks for a tour, walkthrough or guided review of a repo, PR, diff or design doc.
---

# RepoTrail Agent Skill

RepoTrail plays agent-guided codebase tours. You are the analysis and
orchestration engine. The durable tour artifact is a complete JSON file under
the owning project's `.repotrail/` directory. Two things play it:

- The RepoTrail VS Code extension watches those files, lists them in the
  sidebar, and plays them in the editor.
- The `repotrail` command line renders a tour as a page that plays in any
  browser. For people without VS Code, that page is the tour: publish it as a
  Claude Artifact or hand them the file.

Install or use this skill in your current session before creating a RepoTrail
tour. If your agent supports persistent skills, save this document as the
`repo-trail` skill. If it does not, treat this document as the active harness
instructions for the current request.

## Supported Modes

RepoTrail supports three operating modes. Pick the mode from the user's request
and where you're running.

- The user doesn't use VS Code: you're running in the Claude app or claude.ai,
  the user says so, or they ask for a link, a page or an Artifact. Use Mode C.
  In a terminal with no `code` command, use Mode C too, unless the user asked
  for a VS Code workspace (Mode B).
- The user is already in VS Code or says "current workspace": use Mode A.
- The user asks you to prepare a workspace, check out a PR, open VS Code, or
  create a RepoTrail workspace: use Mode B.

If the PR or branch is already checked out locally, use Mode A or C with that
checkout and write no workspace file.

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

### Mode C: No VS Code (a page, usually a Claude Artifact)

Use this when the user will read the tour outside VS Code. The tour file is
the same; RepoTrail's command line turns it into a page. It needs Node 18 or
later and runs as `npx -y repotrail@0.15.0`.

1. Work in a local clone of the repo. For a PR, fetch it (for example
   `git fetch origin pull/<n>/head`) so both refs your diff stops name exist
   locally: the renderer reads them with `git show`. Use a new worktree rather
   than switching the user's checkout.
2. Read the repo for real and write one complete tour JSON file to the owning
   project's `.repotrail/` directory, exactly as in the other modes. Skip the
   workspace file.
3. Lint it and fix every error:

   ```bash
   npx -y repotrail@0.15.0 lint <project>/.repotrail/<slug>.json
   ```

4. Render the page:

   ```bash
   npx -y repotrail@0.15.0 render <project>/.repotrail/<slug>.json --artifact --out <scratch>/<slug>.html
   ```

   Put the page in your scratch or temp directory, not in the repo. The page
   holds the tour's data (code around each stop, diffs, slides, narration)
   and one script tag that loads the RepoTrail player, pinned to this version,
   from `cdn.jsdelivr.net/npm/repotrail@0.15.0/out/player.js`. It plays with
   Back/Next, arrow keys and the browser's own voice, in light or dark mode.
5. Publish it. If you have a tool that publishes an HTML page as a Claude
   Artifact, read the rendered page and publish it, named after the tour's
   title. Don't edit the page by hand: change the JSON and render again. The
   Artifact is private until the user shares it. Without such a tool, open
   the page in a browser (`open <file>` on macOS) or send the user the file.
6. Tell the user: the link (or the file), the tour file's path, and the
   number of stops. Mention that the same file plays in VS Code with the
   RepoTrail extension.

For a follow-up, rewrite the JSON, render it again, and publish to the same
Artifact so the link keeps working.

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
sidebar, or on the rendered page in Mode C. For a follow-up, rewrite the complete JSON route so the file remains a
self-contained tour.

## Tour Workflow

1. Pick Mode A, B or C.
2. Pick the tour kind. If unclear, infer the best kind from the request:
   architecture, pr-diff, file-walkthrough, request-lifecycle,
   bug-investigation, or design-review.
3. In Mode B, prepare the VS Code workspace first so root names and tour aliases
   match what the user will see in the editor.
4. Read the repo for real: README, manifests, entrypoints, routing, core domain
   code, storage/IO, and relevant tests. Use search and file reads before
   choosing line ranges.
5. Plan the route. Order stops so each one builds on the previous one.
6. Write one complete JSON file to the owning project's `.repotrail/` directory,
   for example `.repotrail/architecture.json`.
7. In Mode A or B, tell the user: "Tour ready -- wrote
   `.repotrail/<file>.json` with X stops. Open it from the RepoTrail sidebar."
   In Mode C, lint, render and publish it as described there.

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

A design document, RFC, ADR, proposal, or architecture plan is a design
review, not a code walkthrough, even when it arrives as a PR. Highlighting
paragraphs of markdown teaches nothing the reader couldn't get by reading the
file. Use `kind: "design-review"` and build the tour from slides, as described
next.

## Design Reviews And Slides

A slide stop shows a 16:9 slide in a **RepoTrail Slides** tab in the editor
area instead of opening a file. Slides hold text, bullets, tables, short code
snippets, callouts, and diagrams, and they build up in **beats**: Next steps
through a slide's beats before moving to the next stop, and each beat can
reveal elements, change their labels or colors, spotlight part of the slide,
and send tokens along diagram edges, with narration for each beat. Slide stops
and code stops mix in one tour and share one editor column.

Use slides for:

- Design reviews (`kind: "design-review"`): mostly slides, plus code stops on
  the existing code the design changes or relies on.
- The shape of a change: a PR tour may open with one or two slides (the data
  flow before and after, the new sequence), then diff stops.

You can't see the slide you write, so keep slides sparse and let the layout
engines place everything. Never try to position things by hand.

### Slide stops

```json
{
  "title": "A write invalidates the cache",
  "explanation": "Reads go through the cache. A write goes to the database first, then evicts the key.",
  "root": "project",
  "file": "docs/design/cache.md",
  "range": { "startLine": 40, "startColumn": 1, "endLine": 72, "endColumn": 1 },
  "slide": {
    "eyebrow": "Writes",
    "layout": "stack",
    "blocks": [ ... ],
    "beats": [ ... ]
  }
}
```

- `title` is the slide's headline. Make it the point, not the topic: "A write
  invalidates the cache", not "Cache invalidation".
- `explanation` is the narration before the first beat (markdown, one or two
  sentences). It shows in the sidebar and is read aloud.
- `file` and `range` are optional on a slide and name its **source**: the doc
  section the slide summarizes. Landing on the slide doesn't open it; "Open
  source file" does. Give every design-review slide its source, with line
  numbers you checked. When a slide draws on several sections, cite the main
  one. For a tour posted on a PR, pin each source like a diff stop
  (`viewMode: "diff"`, `diff: { baseRef: <merge base SHA>, headRef: <PR head
  SHA>, scope: "file" }`) so it opens in any clone. The stop still shows as a
  slide, and a doc the PR adds works: Open source file opens it at `headRef`.
- `slide.eyebrow`: a small label above the title, such as the doc section's
  name. `slide.subtitle`: an optional line under the title.
- `slide.layout`: `stack` (default; blocks top to bottom, diagrams take the
  leftover height), `columns` (blocks side by side), or `title` (a large
  centered title and subtitle, with at most one small block; use it for the
  opening slide).

In the `columns` layout, a block starts the column after the previous block's
unless it sets `column` (1-based); blocks that share a column stack. So
`[flow, code, bullets with "column": 2]` puts a diagram on the left and stacks
the code and bullets on the right. `span` weights a column's width (default 1);
when blocks share a column, the largest `span` counts. A `title` slide takes
at most one small block: a sentence of `text` or a flow of 2-4 nodes.

### Blocks

Every block has a `type` and accepts `id`, `title` (a small heading above it),
`column`, `span`, and `build`. Text takes a markdown subset: paragraphs, lists,
**bold**, *italics*, `inline code` and fenced code. Links, images and HTML show
as plain text.

| `type` | Fields | Use it for |
| --- | --- | --- |
| `text` | `md` | A sentence or two. Slides aren't documents. |
| `bullets` | `items`: strings or `{ text, id?, tone?, items? }` (one nested level); `ordered?` | Lists of up to about 8 short items. |
| `table` | `columns`: headings; `rows`: arrays of cells or `{ cells, id?, tone? }` | Comparisons: options, modes, status codes. Up to 8 columns. |
| `code` | `code`, `language?`, `startLine?` | A short literal snippet from the doc (SQL, a JSON body, a config fragment), about 25 lines at most. For real source code, use a code stop. |
| `callout` | `md`, `tone`: `info`, `warn`, `risk`, `decision`, `question`; `title?` | The one thing to remember, a risk, a decision, an open question. |
| `flow` | `nodes`, `edges`, `groups?`, `direction?` | Data flow, architecture, state, decision trees, dependency graphs. |
| `sequence` | `participants`, `messages` | Request and message exchanges over time. |

`build: true` on a `bullets`, `table` or `sequence` block reveals one item,
row or message per beat. It's ignored when the slide has explicit `beats`.

The canvas is 1280×720 and nothing scrolls: text shrinks to fit (down to 60%),
then gets cut. Budgets that read well:

| Text | Budget |
| --- | --- |
| `title` | about 60 characters, so it fits one line; 40 on a `title` slide |
| `eyebrow`, block `title` | about 40 characters |
| bullet | about 90 characters (two lines) |
| table cell | about 60 characters; a table of about 8 rows |
| callout | about 40 words |
| `say` | one or two sentences, about 30 words (two caption lines) |
| `code` | 25 lines; lines over about 60 characters in a column, or 100 full width, shrink the whole block |
| flow node | label about 28 characters, `sub` about 34 |
| sequence | 6 participants, about 12 messages |

`tone` (on bullets, rows, nodes, edges, groups, participants, messages and in
`set`) is one of `accent`, `good`, `warn`, `bad`, `muted`, or `default`. Tones
map to theme colors; never pick colors yourself.

### Flow diagrams

```json
{
  "type": "flow",
  "id": "write",
  "direction": "LR",
  "groups": [{ "id": "svc", "label": "API service" }],
  "nodes": [
    { "id": "client", "label": "Client", "shape": "actor" },
    { "id": "api", "label": "PUT /items/:id", "group": "svc" },
    { "id": "db", "label": "Postgres", "sub": "source of truth", "shape": "store" },
    { "id": "cache", "label": "Redis", "shape": "store", "badge": "v3" }
  ],
  "edges": [
    "client -> api: PUT",
    "api -> db: UPDATE",
    { "id": "evict", "from": "api", "to": "cache", "label": "DEL key", "style": "dashed" }
  ]
}
```

- Nodes need an `id`. `label` defaults to the id; `sub` is a smaller second
  line; `badge` is a corner chip (a version, a count); `group` puts the node in
  a dashed box from `groups`.
- `ref: { file, range?, root? }` on a node makes it a link: clicking it opens
  that file beside the slide, highlighted. Use it when a box stands for real
  code (a function, a module), with a range you read. `root` defaults to the
  slide's root. Participants and `code` blocks take `ref` too.
- `shape`: `box` (default), `service`, `store` (database), `file`, `actor`
  (person or client), `device`, `queue`, `external` (dashed, outside your
  system), `decision` (diamond), `note`.
- Edges are strings, `"a -> b: label"`, or objects. `-->` draws dashed (async,
  a reply), `<->` has arrows at both ends, `--` has none. Objects take `from`,
  `to`, `label`, `style` (`solid`, `dashed`), `arrow` (`end`, `both`, `none`),
  `tone`, and `id`.
- `direction`: `LR` (default) for pipelines, `TB` for decision trees and
  hierarchies. Diagrams scale to fit, and a left-to-right chain of more than
  about 5 nodes scales down until labels are hard to read; use `TB`, fold
  branches, or split the diagram.
- Keep a diagram to about 12 nodes, labels under about 28 characters, and subs
  under about 34. The diagram scales to fit its space, so long labels shrink
  everything.
- To show a system changing (today, then after the design), put the two
  diagrams on consecutive slides and reuse the node ids that stay. Shared
  nodes glide from their old places to their new ones, so the reader sees what
  moved and what's new.

### Sequence diagrams

```json
{
  "type": "sequence",
  "id": "save",
  "participants": [
    { "id": "ui", "label": "Browser", "shape": "actor" },
    { "id": "api", "label": "API" },
    { "id": "db", "label": "Database", "shape": "store" }
  ],
  "messages": [
    "ui -> api: PUT /items/7",
    "api -> api: validate",
    "api -> db: UPDATE items",
    { "note": "The cache is evicted after the commit", "over": ["api", "db"] },
    "api --> ui: 200"
  ],
  "build": true
}
```

Participants need an `id` and take `label`, `sub`, `shape` and `tone`.
Messages are strings (`-->` is a reply, drawn dashed), objects
`{ from, to, label, reply?, tone? }`, or notes `{ note, over: [ids] }`. A
message from a participant to itself draws a loop. Up to 8 participants.

### Element ids

Beats point at elements by id. Ids are unique within a slide: 1-64
characters, no spaces or colons. When you leave one out, it defaults to:

| Element | Default id |
| --- | --- |
| block | `b1`, `b2`, … by position |
| bullet, table row | `<block id>.1`, `<block id>.2`, … (nested bullet: `<block id>.2.1`) |
| sequence message or note | `<block id>.1`, … counting messages and notes together |
| edge | `<from>-><to>`, then `<from>-><to>#2` for a second edge between the same nodes |
| code lines | `<block id>:L3` or `<block id>:L3-5`, using the line numbers shown (they start at `startLine`) |

Numbers count positions, so an item with its own id still uses up its number:
in `["a", { "id": "x", "text": "b" }, "c"]` the third bullet is `<block id>.3`.
Every arrow style (`->`, `-->`, `<->`, `--`) gives an edge the default id
`<from>-><to>`. Code-line references contain a colon, which ids can't; they
aren't ids, just a way to point at lines.

Nodes, groups and participants always need explicit ids. Give blocks ids
whenever a beat refers to them or their contents.

### Beats

```json
"beats": [
  { "say": "The client sends the new value.", "flow": ["client->api"], "focus": ["client", "api", "client->api"] },
  { "say": "The API writes the database first.", "flow": ["api->db"], "set": { "db": { "badge": "v4", "tone": "good" } } },
  { "say": "Then it evicts the key, so the next read refills the cache.", "show": ["evict"], "flow": ["evict"], "pulse": ["cache"] }
]
```

| Field | Effect | Lasts |
| --- | --- | --- |
| `say` | This beat's narration: a caption on the slide, a line in the sidebar transcript, and what's read aloud. One or two sentences. | this beat |
| `show` | Reveal elements. Anything any beat shows starts hidden. | from now on |
| `hide` | Remove elements. | from now on |
| `set` | `{ "<id>": { label?, sub?, badge?, tone? } }`: change text or color. | from now on |
| `focus` | Spotlight these elements and dim everything else. | this beat |
| `highlight` | An accent ring on these, without dimming the rest. | this beat |
| `flow` | A token travels along each edge: `"a->b"` or `{ edge, label?, tone?, reverse? }`. | plays once |
| `pulse` | Elements pulse once. | plays once |

**Structure accumulates; attention is per beat.** `show`, `hide` and `set`
carry forward to later beats. `focus` and `highlight` apply only to their own
beat, so repeat them to keep a spotlight. A flow that starts where the previous
one in the list ended waits for it, so `["a->b", "b->c"]` plays as a chain;
flows that don't connect start together.

- An edge or message is hidden while either end is hidden. Hiding a block or
  group hides everything in it; showing it brings back everything in it except
  elements that some beat shows later. Showing a node also brings its edges in.
- `focus` dims everything not listed, including what the same beat reveals, so
  list newly shown elements in `focus` too when you want them bright.
- In a beat, reveals happen first and flows start right after, so a beat can
  show an edge and send a token along it.
- `set` changes `label` on nodes, participants, edges, messages, notes, groups
  and bullets; `sub` and `badge` on nodes and participants; and `tone` on any
  of those and on table rows. `focus`, `highlight` and `pulse` work on any
  element, including rows, bullets, messages and code lines.
- `say` takes inline markdown, but keep it plain: it's read aloud. A beat with
  only `say` is fine; it advances the narration without changing the slide.
  When a tour plays by itself, each beat lasts as long as its `say` takes to
  read or speak, so a beat without `say` passes in under two seconds.
- Everything is laid out at the start, hidden elements included, so nothing
  moves when a beat reveals something or changes a label.
- `flow` works on edges of `flow` diagrams. For a sequence, reveal messages
  with `show` or `build`.
- Position 0, before any beat, shows the slide with the hidden elements
  missing. Put the setup there, then build: reveal, spotlight, show what
  changes.
- Use 2-5 beats on a slide that needs them, and none on one that doesn't. More
  than about 6 explicit beats means the slide is doing two things: split it. A
  `build` sequence or list gets one beat per item, so it can run longer.

### Building a design review

1. Read the whole document, and the code it refers to. Note its sections and
   their line ranges.
2. Find the 8-16 things a reviewer must understand: the problem with today's
   behavior, each mechanism, each race or failure mode, each decision and its
   trade-off, the plan, and the open questions. That's the whole tour: 8-16
   content slides, plus the title slide and 1-3 code stops.
3. Pick one visual per point. Visualize what prose struggles with: data flow
   (flow), exchanges over time (sequence), a decision tree (flow, `TB`,
   `decision` nodes), before and after (columns), options and status codes
   (table), dependencies between work items (flow). Play a race or failure
   mode out in beats: a `sequence` when the timing between actors is the
   point, a `flow` when the paths through the system are.
4. Write a slide per point. Don't transcribe the doc: a slide holds a diagram
   or table plus at most a short callout, and narration carries the why.
5. Add code stops where the doc points at existing code that the design
   changes or relies on. For a PR that only adds a design doc, those are
   `viewMode: "code"` stops on the current files; use diffs only for code the
   PR changes. Code stops show the file in the reader's checkout, and
   RepoTrail re-anchors a range when the code around it moves. Give code stops
   headlines that state the point, like slides. If the code contradicts the
   doc, say so in that stop's narration: reviewers want to know.
6. Open with a `title` slide, and end with the open questions: a numbered
   `bullets` block with all of the doc's questions, shortened. Mark the ones
   that block implementation with `tone: "warn"`, and spend a `highlight` beat
   on each of them.

Checklist before you report the tour:

- Every id in a beat exists on that slide, spelled as defined, including
  default edge ids like `api->db`.
- Every slide has a `title`, an `explanation`, and its source `file` and
  `range` with line numbers you read.
- Every diagram has 12 nodes or fewer, and every slide has 6 explicit beats or
  fewer.
- Text stays inside the budgets above.
- Narration doesn't read out what's on the slide; it says why it matters.
- RepoTrail's linter passes with no errors:

  ```bash
  repotrail lint <project>/.repotrail/<slug>.json
  ```

  `repotrail` is RepoTrail's command line. Run it one of two ways:

  - `npx -y repotrail@0.15.0`: anywhere with Node 18 or later, no VS Code
    needed.
  - `node <extension>/out/cli.js`, when the VS Code extension is installed.
    `<extension>` is its folder, for example
    `~/.vscode/extensions/repotrail.repotrail-<version>`. The Agent setup
    prompt gives the exact path.

  Lint validates against the JSON Schema (`harness/tour.schema.json` in the
  extension or the npm package, the complete reference for accepted fields),
  checks every beat id, and checks that every `file` exists and every
  range is inside it. Errors are things RepoTrail would drop: fix all of them.
  Warnings are the text budgets above and diagrams that will render too small:
  fix them unless you have a reason not to. Lint finds files relative to the
  folder that holds `.repotrail/`; for other layouts or multi-root tours, pass
  `--root <dir>` or `--root <alias>=<dir>`. If Node isn't available, validate
  against the schema and check beat ids by hand.
- If you can open a browser, look at the slides:

  ```bash
  repotrail render <project>/.repotrail/<slug>.json --out /tmp/<slug>.html
  ```

  Open `/tmp/<slug>.html#stop=<n>&beat=<k>` to see stop n after beat k (the
  same player Export Tour writes), and check each slide at its last beat for
  text that's cut, labels too small to read, or a diagram that doesn't say
  what you meant.

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
  plays them. (The extension's only git write is fetching a PR's commits into
  an existing clone, after the reviewer confirms, when it imports a tour from a
  PR comment.)
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

No VS Code (a page or Claude Artifact):

```text
Use the repo-trail skill in Mode C. Create a RepoTrail tour of <repo, PR URL, or subsystem>. Write the JSON tour into the owning repo's .repotrail/ directory, lint it and render it with npx repotrail --artifact, then publish the page as an Artifact and give me the link.
```

Design review:

```text
Use the repo-trail skill. Create a design-review tour for <design doc path or PR URL>. Read the whole document and the code it mentions, then build it from slides: one point per slide, diagrams and tables over prose, beats that play out each mechanism, code stops where the design touches existing code, and an open-questions slide at the end. Save it as .repotrail/<slug>-design-review.json.
```

## Tours Posted On A Pull Request

When the user wants reviewers to open a PR tour from the PR itself (for example
"post the tour on the PR" or "make a review guide comment"), write the tour so
it plays in any clone, then give the user a PR comment to paste. Do not post it
yourself unless the user explicitly asks.

1. Pin every changed-code stop: `diff.baseRef` is the merge base SHA and
   `diff.headRef` is the PR head SHA, both full 40-character SHAs, with
   `scope: "file"`. RepoTrail reads both sides from git, even for files the
   reviewer's checkout doesn't have.
2. Use a single root alias with a portable `name`/`pathHint` (for example the
   review folder name). RepoTrail binds it to whichever clone the reviewer has
   open.
3. Write the comment in this format. If RepoTrail is installed where you run,
   the user can produce it with **RepoTrail: Copy Tour as PR Comment**.

   ````markdown
   <!-- repotrail-tour:<tour-file-slug> -->
   **RepoTrail review tour for <owner>/<repo>#<n>:** <title> (<k> stops).

   [Open it in VS Code](https://vscode.dev/redirect?url=<URL-encoded review link>) with the [RepoTrail extension](https://marketplace.visualstudio.com/items?itemName=repotrail.repotrail) and any clone of this repo. If the link doesn't open VS Code, run `code --open-url '<review link>'`.

   <details>
   <summary>No RepoTrail or no clone? Prompt for your coding agent</summary>

   ```text
   <prompt: make a temporary directory; fetch pull/<n>/head and check out the
   head SHA into DIR/<folder> (a worktree of an existing clone, or a fresh
   clone); check the base SHA exists; save the comment's json block to
   DIR/<folder>/.repotrail/<tour-file-slug>.json with gh api and awk; write and
   open DIR/<folder>.code-workspace; install repotrail.repotrail if missing>
   ```

   </details>

   <details>
   <summary>Tour file: <tour-file-slug>.json</summary>

   ```json
   <the complete tour envelope>
   ```

   </details>
   ````

   The review link is
   `vscode://repotrail.repotrail/review?pr=<owner>/<repo>/<n>&head=<head SHA>`.
   Include `head` only when every diff stop shares that `headRef`. Add
   `&comment=<id>` only when editing a comment that already exists. GitHub
   strips `vscode://` hrefs, which is why the clickable link goes through
   `vscode.dev/redirect`. Keep the whole comment under 65,536 characters.

   Slide stops, file stops and slide refs read the reviewer's working tree,
   not a commit. When the tour has any of them, replace "and any clone of
   this repo" with "(0.14 or later, for the slides) and a checkout of this
   PR", dropping the version note when there are no slides. RepoTrail warns
   and offers the PR's worktree when the link opens in a window that has
   another branch checked out.
4. Tell the user the comment is ready to paste and how many stops it has.

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
- Ranges are 1-indexed. The highlight runs from `startLine`:`startColumn` to
  `endLine`:`endColumn`, so `"endColumn": 1` stops at the start of `endLine`:
  set `endLine` to the line after the last one you want, or give the real end
  column.
- Keep ranges tight. If you did not read the file, do not invent
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
  The alias key is what steps put in `root` and can be any short name;
  `name` is the VS Code folder name to match, and `pathHint` a folder name or
  path suffix to match when the name differs. `path` (absolute) is for
  local-only tours. In a single-folder window, an alias that matches nothing
  binds to the open folder. `workspaceFolder` is still accepted for backward
  compatibility.
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
