# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Code Atlas

VS Code extension. AI-guided codebase tours. TypeScript + pnpm. All-in-extension architecture; tours are driven by an external agent over MCP.

## Knowledge pack (load-bearing)

Before non-trivial work, read `docs/knowledge-pack/README.md`. It is the
evolving project memory seeded from Session Manager recall and contains prior
decisions, UX context, architecture history, source sessions, and refresh
commands.

Keep `docs/knowledge-pack/` updated when new sessions change architecture,
release rules, product priorities, or known risks.

## Commands
- `pnpm install` — install deps
- `pnpm typecheck` — `tsc -p ./ --noEmit` (no emit; type errors only)
- `pnpm compile` — `node esbuild.mjs` (bundles `src/extension.ts` → `out/extension.js`)
- `pnpm watch` — `tsc -watch` for incremental type checking during dev
- `pnpm build` — typecheck then compile (run this to validate a change)
- `pnpm package` — build + `vsce package --no-dependencies` → `.vsix`
- `pnpm install-local` — package + `code --install-extension … --force`
- F5 in VS Code → "Run Extension" launches the dev extension host

No test runner or linter is configured. `pnpm build` is the validation gate.

## Release rule (load-bearing)

After every complete fix or feature, do all three without being asked:
1. `git commit` (Conventional Commits: `fix:`, `feat:`, `chore:`).
2. `pnpm package`.
3. `code --install-extension code-atlas-<version>.vsix --force` (or `pnpm install-local`).

Bump the patch version in `package.json` for user-visible changes so the `.vsix` filename advances. Skip only if the user explicitly says "don't commit" / "don't reinstall" for a specific change.

## Architecture rule (load-bearing)

Layers, strictly separated:

1. **`src/ux/`** — only place that touches `vscode.window` / opens files / draws decorations. `editorActions.ts` is the *only* module that calls `vscode.window.show*` and applies decorations — keep it that way; auditability of editor side-effects depends on it. `tourController.ts` owns plan + index state and is the single source of truth.
2. **`src/engine/`** — pure data. Turns `TourRequest` → `TourPlan` (`engine/types.ts`). MUST NOT import `vscode`. Provider impls live here.
3. **`src/analysis/`** — workspace introspection. May import `vscode` for FS access, but returns plain data to the engine.
4. **`src/mcp/`** — HTTP MCP server (see below). Imports `vscode` and drives the shared `TourController`.
5. **`src/storage/`** — per-workspace tour persistence to `~/.code-atlas/tours/<workspace-hash>/<id>.json`. Returns plain data.
6. **`src/tts/`** — narration. `codeAtlas.tts.provider` selects the engine: `system` (default, webview `SpeechSynthesis`), `kokoro` (experimental local Kokoro-82M neural voice, runs in a web worker via WASM), `say` (macOS `say`/Linux command), or hosted `elevenlabs`/`openai` (audio fetched in the host, played in the webview). `speechText.ts` is a pure code-aware preprocessor (expands identifiers/paths/operators) feeding every engine; `manager.ts` holds the provider switch + host-side fetch.

## How tours are actually generated (big picture)

The in-extension `ClaudeTourProvider` is still a **stub** (`TODO(llm)`); `pickProvider()` falls back to `MockTourProvider` whenever no API key is set. The real tour-generation path is **external**: an agent (Claude Code, via the `code-atlas` skill) connects to the extension's MCP server and emits steps. The extension is intentionally "dumb" — it executes whatever the agent sends.

- **Server**: `src/mcp/server.ts` — Streamable HTTP, **stateless**, bound to `127.0.0.1` only, default port `7777` with fallback probing across `mcpPortRange` ports (so multiple VS Code windows coexist; bound ports recorded in `~/.code-atlas/ports.json`). A fresh `McpServer` + transport is built per request; the shared `TourController` is the persistent state.
- **Tool surface**: `get_workspace`, `start_tour`, `add_step`, `insert_step`, `update_step`, `remove_step`, `show_step`, `get_state`, `wait_for_user`, `end_tour`.
- **Typical flow**: `get_workspace` → `start_tour` → repeated `add_step` (each opens the file + highlights immediately). The user navigates locally with Back/Next — no agent polling required.
- **Deepen / follow-up are clipboard bridges, not LLM calls.** `codeAtlas.deeper` and `codeAtlas.followUp` copy a ready-to-paste prompt to the clipboard; the user pastes it into their agent terminal, and the agent calls `insert_step` to splice sub-steps after the current index.

## Tour step schema

`TourStep` (`engine/types.ts`) is the wire format between engine/agent and UX. Any new provider or MCP `add_step`/`insert_step` call must emit this shape. **Ranges are 1-indexed** (line and column); conversion to 0-indexed VS Code `Range` happens in `editorActions.ts`.

## What's deferred

Real LLM provider, Tree-sitter / LSP / git diff / PR-mode parsing / ripgrep / tests / CI. See README TODO section.

@mastery.md
