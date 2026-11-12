import { build } from "esbuild";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";

const watch = process.argv.includes("--watch");
const prod = process.argv.includes("--production");

await rm("out", { recursive: true, force: true });

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: !prod,
  minify: prod,
  logLevel: "info",
}).catch(() => process.exit(1));

// Slide webview runtime: browser-only, loaded by the RepoTrail Slides panel.
// Writes out/slides.js and out/slides.css.
await build({
  entryPoints: ["src/webview/slides/main.ts"],
  bundle: true,
  outfile: "out/slides.js",
  platform: "browser",
  format: "iife",
  target: "chrome114",
  sourcemap: !prod,
  minify: prod,
  logLevel: "info",
}).catch(() => process.exit(1));

// Command line for agents: lint and render tours without VS Code. Writes
// out/cli.js, which reads harness/tour.schema.json and out/slides.* beside it.
await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  outfile: "out/cli.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: !prod,
  minify: prod,
  logLevel: "info",
}).catch(() => process.exit(1));

// Hosted player for `render --artifact` pages: the page styles, the slide
// runtime and the player script in one file. Writes out/player.js, which the
// npm package ships and jsDelivr serves.
const engineFile = "out/.player-build.cjs";
await build({
  entryPoints: ["src/engine/animatedHtml.ts"],
  bundle: true,
  outfile: engineFile,
  platform: "node",
  format: "cjs",
  target: "node18",
  logLevel: "warning",
}).catch(() => process.exit(1));
const { hostedPlayerScript } = createRequire(import.meta.url)(path.resolve(engineFile));
await writeFile(
  "out/player.js",
  hostedPlayerScript({
    script: await readFile("out/slides.js", "utf8"),
    css: await readFile("out/slides.css", "utf8"),
  }),
);
await rm(engineFile);

if (watch) {
  console.log("[esbuild] one-shot build (watch flag is a placeholder; use tsc -w for type-watch)");
}
