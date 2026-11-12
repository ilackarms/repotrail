# repotrail

Command-line tools for [RepoTrail](https://github.com/ilackarms/repotrail)
tours: guided walks through a codebase that a coding agent writes as a
`.repotrail/<name>.json` file.

You don't need VS Code to use this package. It checks a tour and turns it
into a page you can open in a browser or publish as a Claude Artifact.

```bash
npx -y repotrail lint .repotrail/my-tour.json
npx -y repotrail render .repotrail/my-tour.json --artifact --out my-tour.html
```

## Commands

`lint <tour.json>` reports what RepoTrail can't use (errors, exit code 1) and
text over the authoring skill's budgets (warnings). Add `--json` for
machine-readable output.

`render <tour.json> --out <file.html>` writes a standalone page that plays the
tour: code and diff stops, slides, narration. Open it at
`<file.html>#stop=<n>&beat=<k>` to jump to a position.

- Without `--artifact`, the page carries everything it needs and works
  offline. A tour with slides comes to about 200 KB or more.
- With `--artifact`, the page carries only the tour and loads the player from
  `cdn.jsdelivr.net/npm/repotrail@<version>/out/player.js`. That keeps it small
  enough to read and publish as a Claude Artifact. It also shows more code
  around each stop and offers only the browser's own voice.
  `--player <url>` loads the player from somewhere else.

`--root <dir>` says where the tour's files live. It defaults to the folder
that holds the tour's `.repotrail` directory. Repeat it as
`--root <alias>=<dir>` for multi-root tours.

Diff stops read both sides with `git show`, so the refs they name must exist
in the local clone.

## With Claude

Install the RepoTrail plugin, which carries the authoring skill. Then ask
Claude for a tour of a repo, a PR or a subsystem:

```text
/plugin marketplace add ilackarms/repotrail
/plugin install repotrail@repotrail
```

In VS Code, the [RepoTrail extension](https://marketplace.visualstudio.com/items?itemName=repotrail.repotrail)
plays the same tour files in the editor.
