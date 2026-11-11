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
5. `src/github/` is pure GitHub-side logic: PR and review-link parsing, tour
   discovery in comment markdown, PR comment composition, the read-only REST
   client, and the GitHub Pull Requests extension's contract. It must not
   import `vscode`. `src/ux/prImport.ts` owns the import prompts;
   `src/ux/pullRequestReview.ts` asks GitHub Pull Requests which PR a folder
   has checked out; `src/ux/prComments.ts` owns "Comment on PR". RepoTrail
   never posts to GitHub. `src/gitRepo.ts` owns the remote listing, commit
   and ancestry checks, and the confirmed PR fetch (the only git write).
6. `src/webview/` is browser-only code bundled for webviews. The slide
   runtime (`src/webview/slides/`) renders slide stops in the RepoTrail Slides
   panel; `src/ux/slidePanel.ts` owns that panel and only `editorActions.ts`
   drives it. Webview code may import `src/engine/` and pure UI helpers, never
   `vscode`.
7. `src/cli.ts` is the command line for agents (`out/cli.js lint` and
   `render`). It uses `src/engine/` only and reads files and git directly;
   it never imports `vscode`. Lint rules live in `src/engine/slides/lint.ts`.
8. `harness/repo-trail/SKILL.md` is the generic authoring skill.
9. `harness/README.md` documents the JSON file contract for external agents.

## Product Rule

RepoTrail has one supported generation path: an external agent writes a
complete tour file under the owning project's `.repotrail/` directory. Do not
reintroduce mock tours, built-in provider generation, API-key-driven
in-extension generation, or connection-based tour mutation.

`TourStep` is the wire format between tour JSON and UX. Ranges are 1-indexed;
conversion to VS Code ranges happens in `editorActions.ts`.
