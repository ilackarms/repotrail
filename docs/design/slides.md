# Slides: animated diagrams in RepoTrail tours

Status: phases 0 (static slides) and 1 (beats and motion) are implemented.
Target: RepoTrail 0.14+.

## Why

Every RepoTrail stop is anchored to code: a `file`, a `range`, and an editor or
diff that opens when you land on it. That fits code and PR reviews. It does not
fit a design review.

The test case is
[agentdesktop-dev/agentdesktop#244](https://github.com/agentdesktop-dev/agentdesktop/pull/244),
a 659-line design doc (`docs/design/fleet-config-api.md`) and nothing else. A
code-style tour of it would highlight paragraphs of markdown. That is the doc
with a cursor, not a walkthrough. What a reviewer actually wants from the
author is the talk-through: the data flow today, what breaks, two saves racing
for revision 9, the push across replicas told one message at a time, the work
items as a dependency graph, and the open questions at the end. The doc already
holds that material, but as tables, SQL, a mermaid block and prose.

This design lets the agent that writes the tour also write **slides**. A slide
is a tour stop. Instead of opening a file, it shows a 16:9 canvas in the editor
area with text, tables, code snippets and diagrams. **Beats** build the slide
up step by step, with narration for each beat. Slides and code stops can be
mixed in one route. For PR #244, a slide explains how revisions work, then a
code stop shows today's `daemon_config::watch`, and a later slide shows the new
flow.

## Goals

- An agent can add slides to any tour by writing JSON in the same
  `.repotrail/*.json` file. No new generation path (see the Product Rule in
  `AGENTS.md`).
- Built-in visuals: flow diagrams with auto-layout, sequence diagrams, tables,
  bullets, code snippets and callouts.
- Built-in animation: elements appear, disappear, get spotlighted or change
  state, and tokens travel along edges, all driven by beats that Next and Back
  step through.
- Narration per beat in the sidebar and through the existing TTS providers.
- The same slides play in VS Code, in the animated HTML export, and from a
  tour imported off a PR comment.
- Safe for tours from strangers: no agent-supplied HTML or script ever runs.
- The agent gets feedback without opening VS Code: a JSON Schema and a lint
  and render CLI.

## Non-goals

- A general slide editor in the extension. The agent writes slides; RepoTrail
  plays them.
- Free-form HTML, CSS or JavaScript in slides. See [Decisions](#decisions).
- Animation keyframes written by the agent. The agent says what changes; the
  renderer decides how it moves.
- Pixel-level layout. Positions come from layout engines, with a few hints.

## Concepts

| Term | Meaning |
| --- | --- |
| Slide stop | A `TourStep` with a `slide` object. It may omit `file`. |
| Block | One piece of a slide: `text`, `bullets`, `table`, `code`, `callout`, `flow`, `sequence`. |
| Element | Anything with an id that a beat can target: a block, a node, an edge, a group, a bullet, a table row, a sequence message, a code line range. |
| Beat | One build step. It changes which elements are visible and what state they show, triggers effects, and carries narration (`say`). |
| Position | Where you are on a slide: 0 is the initial state, `k` is after beat `k`. A slide with N beats has N+1 positions. |
| Source | Optional `file`/`range`/`diff` on a slide stop: where the slide's content comes from (the doc section). "Open source" opens it; landing on the slide does not. |

## The authoring API

The API is the tour JSON. The skill (`harness/repo-trail/SKILL.md`), the
contract (`harness/README.md`) and a new JSON Schema
(`harness/tour.schema.json`) document it.

### Slide stop

```json
{
  "title": "Two saves, one revision 9",
  "explanation": "Revisions only go up. A save inserts base_revision + 1, and only if its base is still the latest.",
  "root": "agentdesktop",
  "file": "docs/design/fleet-config-api.md",
  "range": { "startLine": 153, "startColumn": 1, "endLine": 166, "endColumn": 1 },
  "slide": {
    "eyebrow": "Revisions",
    "layout": "columns",
    "blocks": [ ... ],
    "beats": [ ... ]
  }
}
```

- `title` is the slide title. `explanation` is the narration at position 0 and
  the speaker notes in the sidebar, as for any stop.
- `root`/`file`/`range`/`diff` are optional. On a slide they are the source
  anchor: drift detection, CodeLens and "Open source" use them, and landing on
  the slide doesn't open them. For a PR tour, pin them like a diff stop
  (`viewMode: "diff"`, `diff.baseRef` + `diff.headRef`). "Open source"
  already handles pinned stops: it opens the working-tree file, or the file at
  `headRef` when the reviewer's checkout doesn't have it.
- `slide.layout`: `stack` (default; blocks top to bottom), `columns` (blocks
  side by side, weighted by `span`; blocks that share a `column` stack), or
  `title` (large centered title, subtitle, and at most one block).
- `slide.eyebrow` and `slide.subtitle` are optional small labels.

### Blocks

Every block accepts `id`, `title`, `column`, `span` and `build`. In the
`columns` layout, `column` is the block's 1-based column; without it, a block
starts the column after the previous block's, so `[flow, code, bullets with
column 2]` puts the diagram on the left and stacks the code and bullets on the
right. `span` weights a column's width (default 1). Text fields accept the same safe markdown subset as narration
(`renderNarrationMarkdown`): emphasis, inline code and lists. No links, images
or HTML.

| `type` | Fields | `build: true` means |
| --- | --- | --- |
| `text` | `md` | — |
| `bullets` | `items: (string \| { id?, text, tone?, items? })[]`, `ordered?` | one beat per top-level item |
| `table` | `columns: string[]`, `rows: (string[] \| { id?, cells, tone? })[]` | one beat per row |
| `code` | `code`, `language?`, `startLine?` | — |
| `callout` | `tone: info \| warn \| risk \| decision \| question`, `md` | — |
| `flow` | `nodes`, `edges?`, `groups?`, `direction?: LR \| TB` | — |
| `sequence` | `participants`, `messages` | one beat per message |

`build` is shorthand for common reveals. It applies only when the slide has no
explicit `beats`; with both, RepoTrail ignores `build` and warns.

`code` holds a short literal snippet (at most about 25 lines), such as the SQL
in a design doc. For real source code, use a code stop.

#### Flow diagrams

```json
{
  "type": "flow",
  "id": "today",
  "direction": "LR",
  "nodes": [
    { "id": "file", "label": "daemon.yaml", "shape": "file" },
    { "id": "watch", "label": "daemon_config::watch", "sub": "parse_daemon", "group": "ctrl" },
    { "id": "store", "label": "DaemonConfigStore", "shape": "store", "group": "ctrl" },
    { "id": "svc", "label": "FleetAgentService", "group": "ctrl" },
    { "id": "dev", "label": "Devices", "shape": "device" }
  ],
  "groups": [{ "id": "ctrl", "label": "Controller" }],
  "edges": [
    "file -> watch: fs event",
    "watch -> store: publish",
    "store -> svc",
    { "id": "push", "from": "svc", "to": "dev", "label": "DaemonConfig {rev 1}" },
    "dev --> svc: ConfigStatus"
  ]
}
```

- Node `shape`: `box` (default), `service`, `store`, `file`, `actor`, `device`,
  `queue`, `external`, `decision`, `note`. The shape gives the diagram its
  look, so the agent never picks colors or icons.
- `tone` on nodes, edges, groups, rows and bullets: `default`, `accent`,
  `good`, `warn`, `bad`, `muted`. Tones map to theme colors.
- Node fields: `label`, `sub` (second line), `badge` (corner chip such as
  `rev 8`), `group`, and layout hints `rank` and `order`.
- Edges are objects, or strings for brevity: `a -> b`, `a --> b` (dashed,
  for async or a reply), `a <-> b`, each with an optional `: label`. Edge ids
  default to `a->b` (`a->b#2` for a repeat).
- Layout is layered (dagre), computed with every element present, hidden ones
  included. Space is reserved for elements that appear later, so nothing jumps
  when a beat reveals them.

#### Sequence diagrams

```json
{
  "type": "sequence",
  "id": "push",
  "participants": [
    { "id": "ui", "label": "Controller UI", "shape": "actor" },
    { "id": "a", "label": "Replica A" },
    { "id": "db", "label": "Database", "shape": "store" },
    { "id": "b", "label": "Replica B" },
    { "id": "d", "label": "Device", "shape": "device" }
  ],
  "messages": [
    { "from": "ui", "to": "a", "label": "PUT {base_revision: 8}" },
    { "from": "a", "to": "a", "label": "require update, parse_daemon" },
    { "from": "a", "to": "db", "label": "insert 9 if latest is 8" },
    { "from": "a", "to": "ui", "label": "200 {revision: 9}", "reply": true },
    { "note": "Replica B finds out at its next poll", "over": ["b"] },
    { "from": "b", "to": "db", "label": "poll: latest is 9" },
    { "from": "b", "to": "d", "label": "DaemonConfig {9}" }
  ],
  "build": true
}
```

Messages are strings (`"a -> b: label"`, with `-->` for a reply drawn
dashed), objects (`{ from, to, label?, reply?, tone? }`), or notes
(`{ note, over: [participants] }`). Message and note ids default to `push.1`,
`push.2`, and so on, counting both. A message from a participant to itself
draws a self-loop. With `build`, each message or note gets one beat that draws
it and highlights it.

### Element ids

Ids are unique within a slide. Defaults when an id is omitted:

| Element | Default id |
| --- | --- |
| block | `b1`, `b2`, … |
| bullet, table row, sequence message | `<block>.1`, `<block>.2`, … |
| edge | `<from>-><to>` |
| code lines | `<block>:L3` or `<block>:L3-5` (always available) |

### Beats

```json
"beats": [
  { "say": "Both admins loaded revision 8 and both press Save.",
    "flow": ["alice->db", "bob->db"] },
  { "say": "A's insert lands first. Revision 9 is now the latest.",
    "set": { "db": { "badge": "rev 9", "tone": "good" } },
    "focus": ["alice", "alice->db", "db"] },
  { "say": "B's WHERE clause no longer matches, so nothing is inserted and B gets a 409.",
    "show": ["conflict"],
    "set": { "bob": { "badge": "409", "tone": "bad" } },
    "focus": ["bob", "sql:L4"] }
]
```

| Field | Effect | Lifetime |
| --- | --- | --- |
| `say` | Narration for this beat: sidebar transcript, caption strip, TTS. | this beat |
| `show` | Reveal elements (fade in; edges draw along their path). | stays |
| `hide` | Remove elements (fade out). | stays |
| `set` | Change `label`, `sub`, `badge` or `tone` of an element. | stays |
| `focus` | Spotlight these elements and dim the others. | this beat |
| `highlight` | Accent ring on these elements, without dimming the others. | this beat |
| `flow` | Send a token along edges: `"a->b"` or `{ edge, label?, tone?, reverse? }`. A flow that starts where the previous one ended waits for it, so a path plays as a chain; any other flow starts with the previous one. | one-shot |
| `pulse` | One ripple on elements. | one-shot |

**Structure accumulates; attention is per beat.** `show`, `hide` and `set`
carry forward. `focus` and `highlight` apply only to their own beat; repeat
them to keep a spotlight. `flow` and `pulse` play once, when the beat is
entered going forward.

Visibility rules:

- An element named in any beat's `show` starts hidden. Every other element
  starts visible.
- An edge is visible only when both endpoints are visible and the edge itself
  isn't hidden.
- Hiding a block or group hides everything inside it.

The renderer computes the state at a position from the beats alone, so any
position can be reached directly: going Back, jumping from the route, export,
reduced motion. Going forward animates the change from the previous state.
Going backward snaps to the earlier state and skips one-shot effects.

### Motion vocabulary

The agent picks what changes; the renderer owns the timing and easing. That
keeps tours small and consistent, and nothing in them is executable.

| Change | Animation |
| --- | --- |
| appear | fade and 6px rise, 220ms; several reveals in one beat stagger by 60ms in listed order |
| edge appear | stroke draws from source to target, 400ms |
| disappear | fade, 160ms |
| `focus` | others dim to 30% opacity, 200ms |
| `highlight` | accent ring and soft glow |
| `set` tone | color crossfade; label, `sub` and `badge` text flip |
| `flow` | token with an optional label chip travels the edge path, 700ms |
| sequence message | arrow draws sender to receiver; a reply draws dashed |
| `pulse` | ring ripple, 500ms |

Setting `repoTrail.slides.motion` is `full` (default), `reduced` (fades only)
or `off` (instant). `prefers-reduced-motion` forces `reduced`.

Layout reserves room for every label a beat's `set` swaps in, so changing
text never moves anything either.

## Playback

### Where slides render

A single **RepoTrail Slides** `WebviewPanel` in the tour's editor column. It is
created on the first slide stop, revealed on later ones, and disposed when the
tour stops. A code stop opens its editor in the same column, so the slides tab
moves behind it, and the next slide brings the panel forward again. It uses
`retainContextWhenHidden` so the slide doesn't rebuild every time.

The canvas is a fixed logical 1280×720 that scales to fit the panel. A fixed
canvas makes content density predictable for the agent and lets the lint CLI
check overflow. Colors come from VS Code theme variables, so light, dark and
high-contrast themes all work.

Panel chrome: beat dots (`●●○○`) and the slide's source path in the footer,
and a caption strip showing the current `say` (setting
`repoTrail.slides.captions`, on by default; always on in present mode, phase
4). Later: clicking a node or code block with a `ref` opens that file beside
the panel.

### Navigation

`TourController` keeps one cursor, `{ index, beat }`. The sidebar, the
commands, CodeLens and the panel all go through it.

- **Next** (`alt+right`, the sidebar button, and →, Space or PageDown in the
  panel): advance a beat if one is left, otherwise go to the next stop at
  position 0. Presentation clickers send PageDown and PageUp, so they work.
- **Back**: step back a beat if `beat > 0`, otherwise go to the previous stop.
  If that stop is a slide, land on its final position, as Keynote does.
- **Next stop** (new, `shift+alt+right`): skip the remaining beats.
- Clicking a stop in the route lands on position 0.
- The persisted progress record keeps `lastIndex` only; resuming lands on
  position 0.

`nextCursor(plan, cursor, direction)` is a pure engine function with tests.

### Narration and TTS

The sidebar shows the slide's `explanation`, then each beat's `say` as a
transcript: past beats in normal text, the current beat highlighted, later
beats muted. **Speak** speaks the current position: `title. explanation` at 0,
otherwise that beat's `say`. `narrationTargetKey` includes the beat, so a stale
utterance is cancelled when the beat changes.

Autoplay comes in phase 4: speak a beat, advance when the audio ends, repeat.
That is a narrated, hands-free run of the deck.

### Live reload

The agent rewrites the file, `reloadPlan` reconciles, and the panel re-renders
in place. `tourProgress` matches slide stops by `title` plus a hash of the
slide, keeps the beat when the current slide still has it, and clamps it
otherwise. The agent can then iterate on a slide while the user watches it
change.

## Agent feedback loop

The agent writes slides without seeing them. Three checks, from cheapest to
most complete:

1. **JSON Schema.** `harness/tour.schema.json` (draft-07, so VS Code's JSON
   service can use it), registered through `contributes.jsonValidation` for
   `**/.repotrail/*.json`. The agent can validate against it, and a person
   editing the tour gets squiggles and completion.
2. **Lint.** `node <extensionPath>/out/cli.js lint <tour.json>` prints the
   normalizer's warnings (unknown ids in beats, duplicate ids, `build` ignored,
   unknown block types) and layout warnings (text overflow at 1280×720, more
   than 12 nodes in a flow, more than 8 beats, long labels). **Agent setup**
   already writes the prompt, so it fills in `<extensionPath>`.
3. **Render.** `node <extensionPath>/out/cli.js render <tour.json> --out
   <dir>` writes the animated HTML export. An agent with a browser tool can
   screenshot any position through `#stop=4&beat=2`.

The extension shows the same normalizer warnings in the panel and in the
output channel. A bad beat is skipped with a warning; a bad slide still renders
what it can.

## Export and sharing

- **Animated HTML export** renders slide frames with the same runtime, inlined.
  For a design review, that file is a deck you can send to someone without VS
  Code.
- **Markdown export** writes title, bullets, tables and code as markdown, flow
  and sequence blocks as `mermaid` fences, and beat narration as a list. GitHub
  renders the result.
- **PR comment.** Slides travel inside the tour JSON, which the comment already
  stores compact. A 15-slide deck is about 25–40 KB, under the 65,536-character
  limit, and the composer already enforces that limit. Slide stops need no
  pinned refs. A slide's source anchor follows the pinned-diff rules.

## Safety

Tours can come from a stranger's PR comment, so:

- No agent-supplied HTML, CSS, script, SVG markup, URLs or remote images. The
  runtime builds DOM and SVG from typed data with `textContent` and
  attributes only. Markdown goes through the escaping narration renderer.
- The panel CSP is `default-src 'none'; script-src 'nonce-…'; style-src
  'nonce-…'; img-src data:`, with no network access.
- `ref` targets go through the same path validation as stops (no absolute
  paths, no `..`).
- The normalizer caps sizes: blocks per slide, nodes per flow, beats per
  slide, and string lengths.

## Architecture

Following the layering in `AGENTS.md`:

| Layer | New or changed |
| --- | --- |
| `src/engine/types.ts` | `TourSlide`, block, node, edge and beat types. `TourStep.file` becomes optional; it is required unless `slide` is set. `TourKind` gains `design-review`. |
| `src/engine/slides/normalize.ts` | Parse and validate: shorthand edges, default ids, `build` expansion, caps, warnings. Called from `normalizeStep`. |
| `src/engine/slides/timeline.ts` | `positionsOf(slide)`, `stateAt(slide, position)`, `effectsEntering(slide, position)`, `nextCursor(plan, cursor, dir)`. |
| `src/engine/slides/layout.ts` | Flow layout (dagre) and sequence layout. Pure; takes a `measure(text, font)` function, so tests and the CLI can pass an approximation. |
| `src/engine/slides/markdown.ts` | Slide to markdown and mermaid. |
| `src/webview/slides/` (new layer) | Browser-only runtime: renders blocks into DOM and SVG, compares state between positions and animates the difference, handles keys and clicks, posts `next`/`back`/`openRef`. Built by a second esbuild entry into `out/slides.js` (IIFE). Imports `engine/slides/*`, never `vscode`. |
| `src/ux/slidePanel.ts` | Owns the `WebviewPanel`: create, reuse, reveal, CSP, messages. |
| `src/ux/editorActions.ts` | `executeStep` sends slide stops to `slidePanel` (it stays the single place for editor side effects) and closes the panel in `resetTourEditorLayout`. |
| `src/ux/tourController.ts` | Beat cursor; `next`/`back`/`nextStop` use `nextCursor`. |
| `src/ux/webviewPanel.ts` | Route shows a slide icon instead of a path; narration shows the beat transcript. |
| `src/tts/playbackPolicy.ts`, `manager.ts` | Beat-aware target key and speech text. |
| `src/ux/tourProgress.ts` | Slide identity for reconciliation. |
| `src/engine/animatedHtml.ts`, `src/extension.ts` | `frame.slide`. The export reads `out/slides.js` and passes it in as a string, so the engine doesn't read files. |
| `src/github/prTour.ts` | Slide stops count as valid stops and need no pinned refs. |
| `src/cli.ts` (new) | `lint` and `render`. Third esbuild entry, Node, no `vscode`. |
| `harness/` | SKILL.md section, README contract, `tour.schema.json`. |
| `package.json` | `jsonValidation`, `repoTrail.slides.motion`, `repoTrail.nextStop`, the `@dagrejs/dagre` dependency (bundled). |

`AGENTS.md` adds `src/webview/` to the layer list.

Making `file` optional is deliberately loud: `tsc` lists every place that
assumes a file. Today those are `formatStepPath`, `stepLocation`,
`narrationTargetKey`, the route render signature, `tourFileTree`, CodeLens,
`prTour`'s pinned-ref checks, `tourProgress` keys and the animated export's
frame builder. `executeStep` already returns early when `file` is missing.

Older RepoTrail versions drop steps without a `file` in `normalizeStep`. A
mixed tour degrades to its code stops, and a tour of only slides doesn't load.
New tours write `repoTrailTour: 3`. Readers accept 2 and 3.

## Skill guidance (summary for SKILL.md)

- A design doc, RFC, ADR or architecture proposal gets
  `kind: "design-review"`, made mostly of slides. Anchor each slide to its doc
  section. Add code stops where the doc talks about code that already exists.
- A PR tour may open with one or two slides on the shape of the change, then
  diff stops.
- Visualize; don't transcribe. Each slide makes one point: a flow, a sequence,
  a before and after, a trade-off, a race. Leave prose in the doc.
- At most 6 beats and 12 nodes per slide. Narration explains why; the
  diagram shows what.
- End a design review with an open-questions slide that marks which questions
  block implementation.
- Run `lint` before reporting the tour as ready.

## Worked example: PR #244 storyboard

| # | Stop | Visual | Beats |
| --- | --- | --- | --- |
| 1 | Slide: Fleet configuration API | `title` layout; subtitle "A6.0: a write path with revisions and authors" | — |
| 2 | Slide: How config reaches devices today | flow: file → watch → store → service → devices → status | token runs the path; every push is badged `rev 1`; an edit pushes `rev 1` again (`bad`) |
| 3 | Code: `daemon_config.rs` `watch` | code stop | — |
| 4 | Slide: Two sources | table, file vs database | build rows |
| 5 | Slide: Database-mode startup | flow with decision nodes | walk the three branches; callout on why there is no `programs: {}` seed |
| 6 | Slide: Switching modes | two small flows in columns | file → db keeps the revision; db → file inserts one (`warn`) |
| 7 | Slide: The revision table | code (SQL schema) | focus on the author columns, then the conditional insert |
| 8 | Slide: Two saves, one revision 9 | flow and SQL in columns | the race (see [Beats](#beats)) |
| 9 | Slide: A stale replica must not write back | flow, two replicas and the DB | replica B's lagging ConfigMap; no insert |
| 10 | Slide: Pushing to devices | sequence (the mermaid diagram from the doc) | build messages |
| 11 | Slide: `PUT` status codes | table | build rows; focus 409 and 422 |
| 12 | Code: `authorization.rs` `OPERATIONS` | code stop | — |
| 13 | Slide: Hardening plan | bullets in columns for C6, C2 and C3 | one column at a time |
| 14 | Slide: Hooks left for A6.1 | flow: propose → approve → apply | `flow` tokens; 202 vs 200 |
| 15 | Slide: Work items | flow: 1 → 2, 3 → 4; 2 → 5; checksum move standalone | reveal in dependency order |
| 16 | Slide: Open questions | numbered bullets | build; `highlight` the three that block implementation |

Each slide's source is pinned to its section of `docs/design/fleet-config-api.md`
at the PR head, so "Open source" lands on the paragraph behind the slide. A
reviewer's inline comment then lands on the right lines.

## Decisions

1. **Our own JSON scene graph, not Mermaid and not HTML.** Raw HTML or script
   would run in a webview that can send commands to the extension, from tours
   anyone can post on a PR. It would also look different in every tour and
   couldn't be stepped through beat by beat. Mermaid is familiar to agents, but
   its SVG doesn't keep stable ids for sequence messages, relayouts change
   positions between builds, and `mermaid.min.js` is about 5.5 MB. Agents translate
   Mermaid into `flow` and `sequence` easily, and get animation for it. The
   markdown export goes the other way, back to Mermaid.
2. **Declarative state, not keyframes.** Beats describe state, so every
   position is computable and seekable: Back, route jumps, export, reduced
   motion, live reload. Tours stay small and safe.
3. **Layout runs in the webview, with an injected text measurer.** Real text
   widths come from the DOM. The CLI and tests use an approximation, which is
   enough for lint.
4. **dagre for flow layout; sequence layout is our own.** Writing a layered
   layout by hand is the largest visual risk in the feature. dagre is about
   50 KB minified, deterministic, and good enough. ELK lays out better but is
   about 1.6 MB.
5. **A slide's location fields are its source anchor.** Reusing
   `file`/`range`/`diff` gives slides drift detection, CodeLens, pinned refs
   and "Open source" without new code.

## Plan

Each phase ends with commit, `pnpm package`, `pnpm install-local` (the
Release Rule).

**Phase 0: spike (static slides). Done.** Types and normalizer; `slidePanel`; the
runtime renders `text`, `bullets`, `table`, `code`, `callout` and `flow` (dagre)
with no beats; `executeStep` routes to the panel; `file` optional across the
codebase. Hand-write slides 2, 4 and 8 of the PR #244 storyboard as a fixture
and judge the visuals before building more.
*Done when* a mixed tour plays slides and code stops in one editor column in
light and dark themes. The fixture is `test/fixtures/fleet-config-slides.json`;
`node scripts/preview-slides.mjs <tour.json>` renders a tour's slides into one
page for checking visuals without VS Code. Known gap: dagre may order nodes in
a rank differently from the source (Admin B above Admin A).

**Phase 1: beats and motion.** `timeline.ts` (state, effects, cursor) with
tests; the controller's beat cursor and Next/Back/Next stop; the state-diff
animator; `flow`, `pulse`, `focus` and `highlight`; `sequence` blocks;
`build`; panel keys; beat dots; the sidebar transcript; beat-aware TTS; live
reload that keeps the beat; the motion setting.
*Done when* the whole PR #244 storyboard plays, forward and backward, with no
layout jumps. **Done.** The fixture is the full 16-stop storyboard; in the
preview, stepping all 14 slides through their 60 positions moves no element.
Still to check by hand: the panel and sidebar inside VS Code.

**Phase 2: the authoring API.** SKILL.md section, harness README,
`tour.schema.json` with `jsonValidation`, the `design-review` kind, Agent setup
prompt, schema fixture tests. Then an agent writes the PR #244 tour from the
skill alone, with no hand edits.
*Done when* that tour needs no fixes.

**Phase 3: export and the agent loop.** Slides in the animated HTML export
(shared runtime) and the markdown export (mermaid), the `cli.ts` `lint` and
`render` commands, `#stop=&beat=` deep links, and a check of the PR comment
round trip.
*Done when* an agent can lint and screenshot its own deck, and a reviewer can
open it from a PR comment.

**Phase 4: presenting.** Autoplay, present mode (maximize the editor group,
captions on), `ref` click-through from nodes, and shared-element transitions:
when consecutive slides share node ids, the nodes move to their new places
instead of the slide cutting over.

**Later, not committed.** `stat` and `chart` blocks, repo-relative images, a
static `mermaid` block, and "comment on this slide", which turns a reviewer's
note into a PR review comment on the slide's source lines.

## Open questions

1. **Slides inside a PR code tour.** Should `pr-diff` tours be encouraged to
   open with a slide, or should slides stay mainly for `design-review` tours?
2. **Autoplay timing.** Should autoplay ship in phase 1, since narrated decks
   are the most impressive demo, or wait until the navigation model has been
   used for a while?
3. **Where the CLI ships.** The CLI could ship inside the extension (the path
   comes from Agent setup) or as an npm package (`npx repotrail lint`). The
   extension needs no publishing; npm is easier for agents that run outside
   VS Code.
4. **Back lands on the final position.** That is Keynote's behavior. Is it
   right for tours, where the previous slide may have been seen long ago?
