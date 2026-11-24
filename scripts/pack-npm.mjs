// Assembles the `repotrail` npm package in dist/npm from a finished build:
// the CLI, the slide runtime it inlines into exports, and the tour schema.
// The release workflow publishes it. By hand, run `npm publish ./dist/npm`
// (without `./`, npm reads `dist/npm` as a GitHub repo). The version follows
// package.json, so the npm package, the extension and the skill's pinned
// `npx repotrail@<version>` always match.

import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dist = path.join(root, "dist", "npm");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

const files = [
  "out/cli.js",
  "out/slides.js",
  "out/slides.css",
  "harness/tour.schema.json",
  "LICENSE",
];

await rm(dist, { recursive: true, force: true });
for (const file of files) {
  await mkdir(path.dirname(path.join(dist, file)), { recursive: true });
  try {
    await copyFile(path.join(root, file), path.join(dist, file));
  } catch {
    console.error(`Missing ${file}. Run pnpm build first.`);
    process.exit(1);
  }
}
await chmod(path.join(dist, "out/cli.js"), 0o755);
await copyFile(path.join(root, "npm", "README.md"), path.join(dist, "README.md"));

await writeFile(
  path.join(dist, "package.json"),
  `${JSON.stringify(
    {
      name: "repotrail",
      version: manifest.version,
      description: "Lint RepoTrail tours and render them as pages you can open or share without VS Code.",
      license: manifest.license,
      // npm checks provenance against this URL, in the form `npm pkg fix` gives it.
      repository: { type: "git", url: manifest.repository.url.replace(/^(?!git\+)/, "git+") },
      bugs: manifest.bugs,
      homepage: manifest.homepage,
      keywords: ["code tour", "walkthrough", "onboarding", "claude", "agent"],
      bin: { repotrail: "out/cli.js" },
      files: ["out", "harness"],
      engines: { node: ">=18" },
    },
    null,
    2,
  )}\n`,
);

console.log(`Assembled ${path.relative(root, dist)} (repotrail@${manifest.version}). Publish with: npm publish ./dist/npm`);
