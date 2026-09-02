# RepoTrail

VS Code extension. Agent-guided codebase tours. TypeScript + pnpm. The
extension is the editor surface; an external agent writes complete
`.repotrail/*.json` tour files. `harness/repo-trail/SKILL.md` is the single
canonical skill.

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
3. `src/storage/` owns per-workspace tour persistence under
   `~/.repotrail/tours/` and repo-shared tours under `.repotrail/`.
4. `src/tts/` owns narration. `speechText.ts` is pure preprocessing; hosted
   audio fetches happen in the extension host.
5. `harness/repo-trail/SKILL.md` is the generic authoring skill.
6. `harness/README.md` documents the JSON file contract for external agents.

## Product Rule

RepoTrail has one supported generation path: an external agent writes a
complete tour file under the owning project's `.repotrail/` directory. Do not
reintroduce mock tours, built-in provider generation, API-key-driven
in-extension generation, or connection-based tour mutation.

`TourStep` is the wire format between tour JSON and UX. Ranges are 1-indexed;
conversion to VS Code ranges happens in `editorActions.ts`.
