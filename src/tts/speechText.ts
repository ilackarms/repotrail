/**
 * Code-aware text normalization for narration. Pure data — MUST NOT import
 * vscode. Turns markdown tour prose (full of identifiers, paths, and operators)
 * into something a TTS engine can read without sounding robotic:
 *
 *   "Look at `getUserById` then `useEffect(() => {...})`"
 *     -> "Look at get user by id then use effect arrow"
 *
 * The transform matters more for naturalness than the choice of TTS engine —
 * the same preprocessing feeds every provider (kokoro/system/elevenlabs/openai).
 */

/** Full pipeline: strip markdown, then verbalize code-isms. */
export function humanizeForSpeech(md: string): string {
  return expandCodeForSpeech(stripMarkdown(md));
}

/**
 * Strip markdown so TTS doesn't read "asterisk asterisk bold asterisk asterisk".
 * Best-effort — drops code fences, backticks, links/images keep the label,
 * heading markers, emphasis, list markers, blockquote markers.
 */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// Multi-character operators that essentially never occur in English prose, so
// it's safe to verbalize them globally. Order matters — longest first so `===`
// isn't eaten by `==`.
const OPERATORS: [RegExp, string][] = [
  [/===/g, " strictly equals "],
  [/!==/g, " strictly not equals "],
  [/=>/g, " arrow "],
  [/->/g, " arrow "],
  [/==/g, " equals "],
  [/!=/g, " not equals "],
  [/>=/g, " greater than or equal to "],
  [/<=/g, " less than or equal to "],
  [/&&/g, " and "],
  [/\|\|/g, " or "],
  [/::/g, " "],
  [/\+\+/g, " plus plus "],
  [/--/g, " minus minus "],
];

/**
 * Verbalize code-isms in already-plain text:
 *  - split camelCase / PascalCase / snake_case / kebab identifiers into words
 *  - read file paths as "name dot ext"
 *  - speak a curated set of operators
 * Plain English words (no internal case change, underscore, or digit boundary)
 * are left untouched, so ordinary prose is unaffected.
 */
export function expandCodeForSpeech(text: string): string {
  let out = text;

  // Operators first, before identifier splitting touches surrounding chars.
  for (const [re, word] of OPERATORS) out = out.replace(re, word);

  // File paths / dotted identifiers: editorActions.ts -> "editorActions dot ts".
  // Only when a dot sits between word chars (not sentence punctuation).
  out = out.replace(/([A-Za-z0-9_$]+)\.([A-Za-z0-9_$]+)(?=\.[A-Za-z0-9_$]+|\b)/g, "$1 dot $2");

  // Split identifier-shaped tokens into spoken words. A token qualifies if it
  // contains an underscore/hyphen, an internal case change, or a letter/digit
  // boundary — i.e. it looks like code, not an English word.
  out = out.replace(/[A-Za-z][A-Za-z0-9_$-]*[A-Za-z0-9]/g, (tok) => {
    const looksLikeCode = /[_-]/.test(tok) || /[a-z][A-Z]/.test(tok) || /[A-Za-z][0-9]|[0-9][A-Za-z]/.test(tok);
    return looksLikeCode ? splitIdentifier(tok) : tok;
  });

  return out.replace(/\s+/g, " ").trim();
}

function splitIdentifier(tok: string): string {
  return tok
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .toLowerCase()
    .trim();
}
