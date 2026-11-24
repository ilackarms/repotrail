// Reports whether the version in package.json is out on each release target:
// the `repotrail` npm package, the VS Code Marketplace and the GitHub release.
// The release workflow publishes only what's missing. Run it locally to see
// what a release still needs:
//
//   node scripts/release-status.mjs
//
// In GitHub Actions it also writes `version`, `npm`, `marketplace` and
// `github` ("published" or "missing") and `pending` ("true" when anything is
// missing) to $GITHUB_OUTPUT. It exits 1 when a registry can't be checked, so
// a release never goes ahead on a guess.

import { appendFile, readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const version = manifest.version;
const extensionId = `${manifest.publisher}.${manifest.name}`;
const repo = process.env.GITHUB_REPOSITORY || "ilackarms/repotrail";

const TIMEOUT_MS = 30_000;

/** True for 200, false for 404, and an error for anything else. */
async function found(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return true;
}

async function onNpm() {
  return found(`https://registry.npmjs.org/repotrail/${version}`);
}

async function onMarketplace() {
  const response = await fetch("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json;api-version=3.0-preview.1" },
    // filterType 7 is the extension id; flag 0x1 includes every version.
    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: extensionId }] }], flags: 0x1 }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`The Marketplace answered HTTP ${response.status}`);
  const body = await response.json();
  const versions = body.results?.[0]?.extensions?.[0]?.versions ?? [];
  return versions.some((entry) => entry.version === version);
}

async function onGitHub() {
  const token = process.env.GITHUB_TOKEN;
  return found(`https://api.github.com/repos/${repo}/releases/tags/v${version}`, {
    headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
}

let results;
try {
  results = await Promise.all([onNpm(), onMarketplace(), onGitHub()]);
} catch (err) {
  const cause = err instanceof Error && err.cause ? ` (${err.cause instanceof Error ? err.cause.message : String(err.cause)})` : "";
  console.error(`Couldn't check what's released: ${err instanceof Error ? err.message : String(err)}${cause}`);
  process.exit(1);
}

const [npm, marketplace, github] = results.map((published) => (published ? "published" : "missing"));
const pending = [npm, marketplace, github].includes("missing");

const rows = [
  [`npm (repotrail@${version})`, npm],
  [`VS Code Marketplace (${extensionId})`, marketplace],
  [`GitHub release (v${version})`, github],
];
const width = Math.max(...rows.map(([label]) => label.length));
console.log(`RepoTrail ${version}`);
for (const [label, state] of rows) console.log(`  ${label.padEnd(width)}  ${state}`);
console.log(pending ? "Something is missing; the release workflow publishes it." : "Everything is out.");

if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `version=${version}\nnpm=${npm}\nmarketplace=${marketplace}\ngithub=${github}\npending=${pending}\n`,
  );
}
