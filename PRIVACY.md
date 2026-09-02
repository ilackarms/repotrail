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
be generated.

## Local Files

RepoTrail caches active-tour progress under `~/.repotrail/tours/` so it can
restore your place after a VS Code reload. Tour content lives under
`.repotrail/`, and optional agent-created VS Code workspace files can live under
`~/.repotrail/workspaces/`.
