# Code Atlas

VS Code extension. AI-guided codebase tours. TypeScript + pnpm. All-in-extension architecture.

## Commands
- `pnpm install` — install deps
- `pnpm compile` — `tsc -p ./`
- `pnpm watch` — incremental compile during dev
- `pnpm package` — build `.vsix`
- `pnpm install-local` — build + reinstall into VS Code (`code --install-extension … --force`)
- F5 in VS Code → "Run Extension" launches the dev extension host

## Release rule (load-bearing)

After every complete fix or feature, do all three without being asked:

1. `git commit` the change (Conventional Commits: `fix:`, `feat:`, `chore:`).
2. `pnpm package` to rebuild the `.vsix`.
3. `code --install-extension code-atlas-<version>.vsix --force` (or just `pnpm install-local`).

Bump the patch version in `package.json` when the change is user-visible so the `.vsix` filename advances. Skip only if the user explicitly says "don't commit" / "don't reinstall" for a specific change.

## Architecture rule (load-bearing)

Three layers, strictly separated:

1. **`src/ux/`** — only place that touches `vscode.window` / opens files / draws decorations. Never imports from `engine/` types except as data.
2. **`src/engine/`** — pure data. Turns `TourRequest` → `TourPlan` (see `engine/types.ts`). MUST NOT import `vscode`. Provider impls live here.
3. **`src/analysis/`** — workspace introspection. May import `vscode` for FS access, but returns plain data to the engine.

`editorActions.ts` is the only module that calls `vscode.window.show*`. Keep it that way — auditability of editor side-effects depends on it.

## Tour step schema

`TourStep` is the wire format between engine and UX. Any new provider must emit this shape (`engine/types.ts`). Ranges are 1-indexed; conversion to 0-indexed VS Code `Range` happens in `editorActions.ts`.

## Provider selection

`extension.ts::pickProvider()` returns `ClaudeTourProvider` if an API key is set, else `MockTourProvider`. The Claude one is a stub — see `TODO(llm)`.

## What's deferred

Tree-sitter / LSP / git diff / PR mode / ripgrep / tests / CI. See README TODO section.

@mastery.md
