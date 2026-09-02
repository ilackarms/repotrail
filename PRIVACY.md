# RepoTrail Privacy

RepoTrail does not collect telemetry.

## Local Access

RepoTrail has no local network listener. It reads tour JSON files from
`.repotrail/`, the workspace files named by those tours, and local git objects
needed to render diff steps. It does not upload workspace files or git
contents. Hosted text-to-speech handles narration as described below.

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

Standalone animated HTML exports cannot read VS Code SecretStorage. If you use
a hosted voice in an export, its key is entered separately and stored only in
that browser's local storage. RepoTrail never embeds the key in the exported
file.

## Local Files

RepoTrail caches tour progress under `~/.repotrail/tours/`. It restores a tour
after a VS Code reload only when that tour was still active when the window
closed; explicitly stopping it clears the active marker. Tour content lives
under `.repotrail/`, and optional agent-created VS Code workspace files can live
under `~/.repotrail/workspaces/`.
