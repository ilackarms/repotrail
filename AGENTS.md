# RepoTrail

VS Code extension. Agent-guided codebase tours. TypeScript + pnpm. The
extension is the editor surface; the supported generation path is any
MCP-capable external agent over local MCP. The repo-owned Claude Code skill is
the bundled convenience harness.

## Knowledge Pack

Before non-trivial work, read `docs/knowledge-pack/README.md`. Keep
`docs/knowledge-pack/` updated when architecture, release rules, product
priorities, or known risks change.

## Commands

- `pnpm install` - install deps
- `pnpm typecheck` - `tsc -p ./ --noEmit`
- `pnpm compile` - `node esbuild.mjs`
- `pnpm watch` - incremental typecheck during dev
- `pnpm build` - typecheck then bundle; primary validation gate
- `pnpm package` - build + `vsce package --no-dependencies`
- `pnpm install-local` - build + reinstall into VS Code

## Release Rule

After every complete user-visible fix or feature:

1. Commit the change.
2. Run `pnpm package`.
3. Run `pnpm install-local`.

Skip only if the user explicitly says not to commit, package, or reinstall.

## Architecture Rule

Layers stay separated:

1. `src/ux/` owns editor effects, webview UI, CodeLens, and commands that touch
   VS Code UI. `editorActions.ts` remains the single chokepoint for opening
   files, showing editors, decorations, and editor side effects.
2. `src/engine/` is pure data: `TourPlan`, `TourStep`, serialization, and
   schema-adjacent helpers. It must not import `vscode`.
3. `src/analysis/` may use VS Code APIs for workspace introspection, but returns
   plain data.
4. `src/mcp/` exposes the token-authenticated local Streamable HTTP MCP server
   on `127.0.0.1` and drives the shared `TourController`.
5. `src/storage/` owns per-workspace tour persistence under
   `~/.repotrail/tours/` and repo-shared tours under `.repotrail/`.
6. `src/tts/` owns narration. `speechText.ts` is pure preprocessing; hosted
   audio fetches happen in the extension host.
7. `harness/README.md` documents the generic MCP harness contract.
8. `harness/claude/repotrail/` is the repo-owned Claude Code convenience skill.
   Keep it in sync with MCP tool names and setup behavior.

## Product Rule

RepoTrail has one supported generation path: an MCP-capable external agent
calls MCP and emits a complete tour. Do not reintroduce mock tours, built-in
provider generation, API-key-driven in-extension generation, or polling-style
tour control.

`TourStep` is the wire format between the harness/MCP server and UX. Ranges are
1-indexed; conversion to VS Code ranges happens in `editorActions.ts`.
