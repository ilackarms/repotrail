# RepoTrail Privacy

RepoTrail does not collect telemetry.

## Local Access

RepoTrail has no local network listener. It reads tour JSON files from
`.repotrail/`, the workspace files named by those tours, and local git objects
needed to render diff steps. It does not upload workspace files or git
contents. Hosted text-to-speech handles narration as described below.

## GitHub Pull Request Tours

When you open a RepoTrail review link or run **Import Tour from GitHub PR** or
**Find Tours on a PR**, RepoTrail reads that pull request and its issue comments
from `api.github.com`. It sends your VS Code GitHub sign-in token when you are
already signed in or choose to sign in, and nothing else about you or your
workspace. RepoTrail makes no GitHub requests in the background or at startup.

If the tour needs commits your clone lacks, RepoTrail asks before running
`git fetch --no-tags <remote> pull/<n>/head` against the remote you already
configured, which uses your normal git credentials. **Copy Tour as PR Comment**
only writes to your clipboard; RepoTrail never posts to GitHub.

Review comments go through the GitHub Pull Requests extension, if you have it
installed. To decide whether a tour stop can show a commentable file,
RepoTrail asks that extension, through its API, which pull request a folder has
checked out. RepoTrail passes only the folder's location and nothing about your
tour. The extension answers from its own state, and it may call GitHub to
describe the repository, as it already does by itself.

**Comment on PR** reopens the current stop when the PR is already checked out.
Otherwise it waits for you to pick one of its buttons:

- **Check Out PR** opens that extension's own checkout link. RepoTrail then asks
  the extension every few seconds, for up to three minutes, whether the
  checkout has landed, so that it can reopen the stop.
- **Comment on GitHub** opens the pull request in your browser.

## Command Line And Shared Pages

The `repotrail` command line (the npm package, or `out/cli.js` inside the
extension) reads the tour, the files it names and local git objects, and
writes one HTML file. It makes no network requests. Running it with `npx`
downloads the package from the npm registry.

A page rendered with `render --artifact` is static HTML and SVG: it runs no
script and loads nothing when opened. It contains excerpts of the code, diffs
and narration in the tour. Publishing it, for example as a
Claude Artifact, shares those excerpts with everyone who can open it.

## Source Code Access

RepoTrail itself does not send your source code to a hosted model. Tour
generation is performed by your external agent. What that agent reads or sends
depends on its tools, model configuration, and skill-install behavior.

## Text-To-Speech Providers

The default `system` voice uses the webview's browser speech synthesis. Hosted
TTS providers such as ElevenLabs and OpenAI are opt-in and require your own API
key. When enabled, narration text is sent to the selected provider so audio can
be generated. Keys saved with `RepoTrail: Manage TTS Credentials` live in VS
Code SecretStorage rather than `settings.json`; environment variables remain a
supported fallback.

The local `kokoro` voice runs inside the sidebar. When you first use it, it
downloads its speech library and the Kokoro-82M model from public CDNs and
Hugging Face. Narration text stays on your machine.

Standalone animated HTML exports cannot read VS Code SecretStorage. If you use
a hosted voice in an export, its key is entered separately and stored only in
that browser's local storage. RepoTrail never embeds the key in the exported
file.

## Local Files

RepoTrail keeps a copy of each tour you open, with your progress in it, under
`~/.repotrail/tours/`. It restores a tour
after a VS Code reload only when that tour was still active when the window
closed; explicitly stopping it clears the active marker. Tour content lives
under `.repotrail/`, and optional agent-created VS Code workspace files can live
under `~/.repotrail/workspaces/`.
