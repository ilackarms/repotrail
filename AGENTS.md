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

A release bumps the version in `package.json`, the skill's
`npx -y repotrail@<version>` pins, and `harness/.claude-plugin/plugin.json`
together (`test/releaseVersions.test.mjs` checks this). A push to main that
changes the version releases it: `.github/workflows/release.yml` publishes
the npm package, the Marketplace extension and a GitHub release with the
.vsix. Until the npm package is out, the skill's `npx` commands fail.
`node scripts/release-status.mjs` shows what's out. Don't rename the
workflow: npm and the Marketplace trust it by file name. Setup and recovery
are in `docs/releasing.md`.

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
7. `src/cli.ts` is the command line for agents (`lint` and `render`). It
   ships as `out/cli.js` in the extension and as the `repotrail` npm package
   (`scripts/pack-npm.mjs` assembles `dist/npm`). It uses `src/engine/` only
   and reads files and git directly; it never imports `vscode`. Lint rules
   live in `src/engine/slides/lint.ts`. `render --artifact` writes a static
   page (`src/engine/staticTourHtml.ts`, no script). Its slides come from
   `src/engine/slides/staticSlide.ts`, a string version of the slide
   webview's `render.ts` and `diagrams.ts`: same markup and classes, styled by
   the same `slides.css`. Change them together.
8. `harness/repo-trail/SKILL.md` is the generic authoring skill. `harness/` is
   also a Claude Code plugin (`harness/.claude-plugin/plugin.json`), listed
   by the repo's `.claude-plugin/marketplace.json`.
9. `harness/README.md` documents the JSON file contract for external agents.

## Product Rule

RepoTrail has one supported generation path: an external agent writes a
complete tour file under the owning project's `.repotrail/` directory. Do not
reintroduce mock tours, built-in provider generation, API-key-driven
in-extension generation, or connection-based tour mutation.

`TourStep` is the wire format between tour JSON and UX. Ranges are 1-indexed;
conversion to VS Code ranges happens in `editorActions.ts`.
