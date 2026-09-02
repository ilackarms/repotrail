export const TTS_PROVIDERS = ["off", "kokoro", "system", "say", "elevenlabs", "openai"] as const;
export type TtsProvider = (typeof TTS_PROVIDERS)[number];

export const BROWSER_TTS_PROVIDERS = ["off", "kokoro", "system", "elevenlabs", "openai"] as const;
export type BrowserTtsProvider = (typeof BROWSER_TTS_PROVIDERS)[number];

export const TTS_DEFAULTS = {
  provider: "system" as TtsProvider,
  command: "say",
  kokoroVoice: "af_heart",
  elevenLabsVoiceId: "21m00Tcm4TlvDq8ikWAM",
  elevenLabsModel: "eleven_flash_v2_5",
  openAiModel: "gpt-4o-mini-tts",
  openAiVoice: "ash",
  openAiInstructions:
    "Read this code walkthrough aloud like a friendly senior engineer pair-programming: clear, calm, with natural pacing.",
} as const;

export const TTS_SECRET_KEYS = {
  elevenLabs: "repotrail.tts.elevenLabsApiKey",
  openAi: "repotrail.tts.openAiApiKey",
} as const;

export function normalizeTtsProvider(value: unknown): TtsProvider {
  return typeof value === "string" && (TTS_PROVIDERS as readonly string[]).includes(value)
    ? value as TtsProvider
    : TTS_DEFAULTS.provider;
}

export function browserTtsProvider(provider: TtsProvider): BrowserTtsProvider {
  return provider === "say" ? "system" : provider;
}
