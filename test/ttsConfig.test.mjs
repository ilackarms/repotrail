import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import {
  browserTtsProvider,
  normalizeTtsProvider,
  TTS_DEFAULTS,
  TTS_PROVIDERS,
} from "../out-test/tts/config.js";

const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("normalizes extension and browser TTS providers", () => {
  assert.equal(normalizeTtsProvider("openai"), "openai");
  assert.equal(normalizeTtsProvider("unknown"), TTS_DEFAULTS.provider);
  assert.equal(browserTtsProvider("say"), "system");
  assert.equal(browserTtsProvider("kokoro"), "kokoro");
});

test("keeps manifest defaults aligned with runtime defaults and excludes API keys", () => {
  const sections = Array.isArray(manifest.contributes.configuration)
    ? manifest.contributes.configuration
    : [manifest.contributes.configuration];
  const properties = Object.assign({}, ...sections.map((section) => section.properties));

  assert.equal(properties["repoTrail.tts.provider"].default, TTS_DEFAULTS.provider);
  assert.equal(properties["repoTrail.tts.command"].default, TTS_DEFAULTS.command);
  assert.equal(properties["repoTrail.tts.kokoroVoice"].default, TTS_DEFAULTS.kokoroVoice);
  assert.equal(properties["repoTrail.tts.elevenLabsVoiceId"].default, TTS_DEFAULTS.elevenLabsVoiceId);
  assert.equal(properties["repoTrail.tts.elevenLabsModel"].default, TTS_DEFAULTS.elevenLabsModel);
  assert.equal(properties["repoTrail.tts.openAiModel"].default, TTS_DEFAULTS.openAiModel);
  assert.equal(properties["repoTrail.tts.openAiVoice"].default, TTS_DEFAULTS.openAiVoice);
  assert.equal(properties["repoTrail.tts.openAiInstructions"].default, TTS_DEFAULTS.openAiInstructions);
  assert.deepEqual(properties["repoTrail.tts.provider"].enum, TTS_PROVIDERS);
  assert.ok(properties["repoTrail.tts.kokoroVoice"].enum.includes(TTS_DEFAULTS.kokoroVoice));
  assert.equal(properties["repoTrail.autoResume"], undefined);
  assert.equal(properties["repoTrail.tts.elevenLabsApiKey"], undefined);
  assert.equal(properties["repoTrail.tts.openAiApiKey"], undefined);
});
