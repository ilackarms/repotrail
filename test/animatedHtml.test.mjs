import assert from "node:assert/strict";
import { test } from "node:test";
import { planToAnimatedHtml } from "../out-test/engine/animatedHtml.js";

test("emits parseable browser code with centralized TTS defaults", () => {
  const html = planToAnimatedHtml({
    plan: {
      kind: "architecture",
      title: "Settings tour",
      summary: "",
      steps: [],
    },
    exportedAt: "2026-09-02T00:00:00.000Z",
    frames: [],
  });

  const script = html.match(/<script>\n([\s\S]*?)\n<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /const defaultTts = \{"provider":"system"/);
  assert.match(script, /const browserTtsProviders = \["off","kokoro","system","elevenlabs","openai"\]/);
});
