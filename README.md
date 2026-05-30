# Code Atlas

**AI-guided codebase walkthroughs inside your editor.**

Code Atlas turns "I just inherited this repo" / "what does this PR actually do?" / "where does this request go?" into an interactive, narrated tour. The AI picks the stops; the editor opens the files, highlights the right ranges, and walks you through.

## Vision

Three layers, kept strictly separate:

1. **Editor UX layer** — opens files, highlights ranges, reveals symbols, renders narration, owns next/back/deeper controls. The *only* part that touches `vscode.window`.
2. **Tour engine** — turns a `TourRequest` into a `TourPlan` of declarative steps. Pure data in, pure data out. Never drives the editor.
3. **Repo analysis layer** — feeds the engine context: file lists today, ripgrep + git diff next, Tree-sitter / LSP / call graphs later.

The engine emits steps the extension *executes*. It is not an unconstrained agent puppeteering the IDE.

```jsonc
{
  "title": "HTTP entrypoint",
  "file": "src/server.ts",
  "range": { "startLine": 40, "startColumn": 1, "endLine": 78, "endColumn": 1 },
  "explanation": "This is where incoming HTTP requests enter the system.",
  "actions": ["openFile", "highlightRange", "showNarration"]
}
```

## MVP (what's in this scaffold)

- VS Code extension, TypeScript, pnpm.
- Command **Code Atlas: Start Tour** with a QuickPick of tour kinds:
  - Architecture overview
  - PR / diff walkthrough
  - File walkthrough
  - Request lifecycle trace
  - Bug investigation path
- Sidebar webview with a fixed navigation dock for **Next / Back / Go deeper / Stop**, follow-up prompts, and a compactable route list above the current step explanation.
- Mock provider that emits a 4-step tour of this extension itself so you can run it immediately.
- Anthropic Claude provider stub wired to settings (`codeAtlas.anthropicApiKey`, `codeAtlas.model`) — throws until implemented.
- Cursor / Windsurf compatible: only standard `vscode` API is used.

## Folder layout

```
src/
├── extension.ts                # activate(), command registration, provider selection
├── ux/
│   ├── tourController.ts       # plan + index state, next/back/deeper/followUp
│   ├── webviewPanel.ts         # sidebar narration view
│   └── editorActions.ts        # ONLY place that opens files / draws decorations
├── engine/
│   ├── types.ts                # TourStep / TourPlan / TourRequest schemas
│   ├── tourProvider.ts         # TourProvider interface
│   ├── mockProvider.ts         # canned demo tour
│   └── claudeProvider.ts       # Anthropic stub (TODO)
└── analysis/
    └── repoContext.ts          # workspace file listing (extend later)
```

## Running locally

```bash
pnpm install
pnpm compile
```

Then in VS Code: **Run and Debug → Run Extension** (F5). In the dev host:
1. Open any folder.
2. Run **Code Atlas: Start Tour**.
3. Pick a kind. Use the Code Atlas sidebar to step through.

## Configuration

- `codeAtlas.anthropicApiKey` — leave empty to use the mock provider. Setting it activates `ClaudeTourProvider` (stub).
- `codeAtlas.model` — Anthropic model id, defaults to `claude-opus-4-7`.
- `ANTHROPIC_API_KEY` env var is also honored.

## TODO

### LLM integration (`src/engine/claudeProvider.ts`)
- [ ] System prompt explaining the `TourPlan` schema (lift from `engine/types.ts`).
- [ ] Compact repo context: top-level tree + selected file excerpts.
- [ ] Tool-use / JSON-mode call so the model is forced to emit valid steps.
- [ ] Validate response against `TourStep` shape before returning.
- [ ] Cache plans by `(workspaceRoot, kind, contextHash)`.
- [ ] Token budgeting + progressive expansion for large repos.

### Repo analysis (`src/analysis/`)
- [ ] `ripgrep.ts` — symbol/keyword search over the workspace.
- [ ] `gitDiff.ts` — parse unified diffs for PR-mode tours.
- [ ] `treesitter.ts` — semantic chunks per file.
- [ ] LSP symbol queries for `revealSymbol` actions.
- [ ] Lightweight call graph + dependency map.

### UX polish
- [ ] Progress bar in the webview.
- [ ] Inline-edit explanations.
- [x] Export tour as Markdown / re-importable JSON (`codeAtlas.exportTour` / `importTour`).
- [x] Route overview list of all stops with click-to-jump (the "atlas" view).
- [x] Stable sidebar navigation dock with compactable route list.
- [x] Honest in-editor entry point — agent handoff + sample, no silent mock.
- [x] Clipboard-bridge feedback — inline prompt + "steps added" banner.
- [x] Narration stays in the sidebar instead of hover popups over code.
- [ ] Multi-file overview pane (mini-map of all step files).
- [ ] Persist last tour per workspace so reloads resume.

### Compatibility
- [x] No proprietary APIs — should work in Cursor / Windsurf out of the box.
- [ ] Manually verify in Cursor + Windsurf once a real provider lands.

## Non-goals (for now)

- Mutating files. Tours read; refactors are a separate product.
- Free-form agent control of the IDE. Steps are declarative on purpose.
