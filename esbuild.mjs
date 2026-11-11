import { build } from "esbuild";
import { rm } from "node:fs/promises";

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

if (watch) {
  console.log("[esbuild] one-shot build (watch flag is a placeholder; use tsc -w for type-watch)");
}
