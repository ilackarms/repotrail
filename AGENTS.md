# Code Atlas

VS Code extension. AI-guided codebase tours. TypeScript + pnpm. All-in-extension architecture.

## Knowledge pack (load-bearing)

Before non-trivial work, read `docs/knowledge-pack/README.md`. It is the
evolving project memory seeded from Session Manager recall. Use it for prior
decisions, UX context, architecture history, and refresh commands.

Keep `docs/knowledge-pack/` updated when new sessions change architecture,
release rules, product priorities, or known risks.

## Commands
- `pnpm install` — install deps
- `pnpm typecheck` — `tsc -p ./ --noEmit`
- `pnpm compile` — `node esbuild.mjs`
- `pnpm watch` — incremental typecheck during dev
- `pnpm build` — typecheck then bundle; primary validation gate
- `pnpm package` — build + `vsce package --no-dependencies`
- `pnpm install-local` — build + reinstall into VS Code (`code --install-extension … --force`)
- F5 in VS Code → "Run Extension" launches the dev extension host

## Release rule (load-bearing)

After every complete fix or feature, do all three without being asked:

1. `git commit` the change (Conventional Commits: `fix:`, `feat:`, `chore:`).
2. `pnpm package` to rebuild the `.vsix`.
3. `code --install-extension code-atlas-<version>.vsix --force` (or just `pnpm install-local`).

Bump the patch version in `package.json` when the change is user-visible so the `.vsix` filename advances. Skip only if the user explicitly says "don't commit" / "don't reinstall" for a specific change.

## Architecture rule (load-bearing)

Layers, strictly separated:

1. **`src/ux/`** — only place that touches `vscode.window` / opens files / draws decorations. Never imports from `engine/` types except as data.
2. **`src/engine/`** — pure data. Turns `TourRequest` → `TourPlan` (see `engine/types.ts`). MUST NOT import `vscode`. Provider impls live here.
3. **`src/analysis/`** — workspace introspection. May import `vscode` for FS access, but returns plain data to the engine.
4. **`src/mcp/`** — local Streamable HTTP MCP server. Drives the shared `TourController`; bound to `127.0.0.1`.
5. **`src/storage/`** — per-workspace tour persistence. Keep writes atomic.
6. **`src/tts/`** — narration. `speechText.ts` is pure preprocessing; hosted audio fetches happen in the extension host.

`editorActions.ts` is the only module that calls `vscode.window.show*`. Keep it that way — auditability of editor side-effects depends on it.

## Tour step schema

`TourStep` is the wire format between engine and UX. Any new provider must emit this shape (`engine/types.ts`). Ranges are 1-indexed; conversion to 0-indexed VS Code `Range` happens in `editorActions.ts`.

## Provider selection

`extension.ts::pickProvider()` returns `ClaudeTourProvider` if an API key is set, else `MockTourProvider`. The Claude one is a stub — see `TODO(llm)`. Real useful tours currently come from an external agent over MCP, not from the in-extension provider.

## What's deferred

Tree-sitter / LSP / git diff / PR mode / ripgrep / tests / CI. See README TODO section.

@docs/knowledge-pack/README.md
@mastery.md
