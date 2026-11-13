/**
 * RepoTrail's command line, for agents that write tours without seeing them.
 *
 *   repotrail lint <tour.json> [--root <dir> | --root <alias>=<dir>]... [--json]
 *   repotrail render <tour.json> --out <file.html> [--artifact] [--root ...]...
 *
 * Ships two ways: as out/cli.js inside the VS Code extension, and as the
 * `repotrail` npm package (`npx repotrail`) for people without VS Code.
 *
 * `lint` reports what RepoTrail can't use and where text runs over budget.
 * `render` writes the animated HTML export, with slides, which any browser
 * opens at a position through `#stop=<n>&beat=<k>`. With `--artifact` it
 * writes a static page instead (HTML and SVG, no script) to publish as a
 * Claude Artifact. No `vscode` here: files come from disk and diffs from
 * `git show`, read-only.
 */

import Ajv from "ajv";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  buildAnimatedDiffFrame,
  codeFrameFromLines,
  planToAnimatedHtml,
  STANDALONE_CODE_LIMITS,
  type AnimatedTourFrame,
} from "./engine/animatedHtml";
import { formatLintReport, lintTour } from "./engine/slides/lint";
import { planToStaticHtml } from "./engine/staticTourHtml";
import { slideBeats } from "./engine/slides/timeline";
import { parseTourJson, stepLocation } from "./engine/tourSerialize";
import type { TourPlan, TourStep } from "./engine/types";

const USAGE = `RepoTrail tour tools

Usage:
  repotrail lint <tour.json> [--root <dir> | --root <alias>=<dir>]... [--json]
  repotrail render <tour.json> --out <file.html> [--artifact] [--root ...]...
  repotrail --version

lint        Report what RepoTrail can't use (errors, exit code 1) and text over
            the skill's budgets (warnings).
render      Write a standalone HTML player for the tour. Open it in a browser
            at <file.html>#stop=<n>&beat=<k> to see any slide at any beat.

--artifact  Write a static page (HTML and SVG, no script) to publish as a
            Claude Artifact or read without VS Code: every stop on one
            scrolling page, more code around each stop, and slides drawn as
            they stand after their last beat, with the beats listed below.
--root      Where the tour's files live. Defaults to the folder that holds the
            tour's .repotrail directory, or the current directory. Repeat as
            <alias>=<dir> for the root aliases in plan.roots.
`;

interface Options {
  command: string;
  tour: string;
  out?: string;
  json: boolean;
  /** Render a static page for an Artifact: no script, more code context. */
  artifact: boolean;
  roots: Map<string, string>;
  defaultRoot: string;
}

function main(argv: string[]): number {
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  const options = parseArgs(argv);
  if (!options) {
    process.stderr.write(USAGE);
    return 2;
  }
  let text: string;
  try {
    text = readFileSync(options.tour, "utf8");
  } catch (err) {
    process.stderr.write(`Can't read ${options.tour}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (options.command === "lint") return lint(options, text);
  if (options.command === "render") return render(options, text);
  process.stderr.write(USAGE);
  return 2;
}

function lint(options: Options, text: string): number {
  const report = lintTour({
    text,
    schemaErrors: schemaErrors(text),
    lineCount: (step) => {
      const text = readOrNull(stepFile(options, step)) ?? pinnedRevisionText(options, step);
      return text === null ? null : text.split("\n").length;
    },
  });
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatLintReport(report, options.tour)}\n`);
  return report.errors.length > 0 ? 1 : 0;
}

function render(options: Options, text: string): number {
  if (!options.out) {
    process.stderr.write("render needs --out <file.html>\n");
    return 2;
  }
  const plan = parseTourJson(text);
  if (!plan) {
    process.stderr.write(`${options.tour} isn't a RepoTrail tour. Run lint for details.\n`);
    return 1;
  }
  const frames = plan.steps.map((step, index) => frameFor(options, plan, step, index));
  if (options.artifact) {
    const slidesCss = plan.steps.some((step) => step.slide) ? readSlidesCss() : undefined;
    const html = planToStaticHtml({ plan, exportedAt: new Date().toISOString(), frames, slidesCss });
    writeFileSync(options.out, html);
    process.stdout.write(
      `Wrote ${options.out}: ${plan.steps.length} stops, ${Math.ceil(Buffer.byteLength(html) / 1024)} KB, no script.\n` +
        `Publish it as an Artifact, or open it in any browser.\n`,
    );
    return 0;
  }
  const runtime = plan.steps.some((step) => step.slide) ? readRuntime() : undefined;
  const html = planToAnimatedHtml({ plan, exportedAt: new Date().toISOString(), frames, slideRuntime: runtime });
  writeFileSync(options.out, html);
  const withBeats = plan.steps.findIndex((step) => step.slide && slideBeats(step.slide).length > 0);
  process.stdout.write(
    `Wrote ${options.out}: ${plan.steps.length} stops.\n` +
      `Open it in a browser at #stop=<n>&beat=<k> to see a position` +
      (withBeats >= 0 ? `, e.g. ${path.resolve(options.out)}#stop=${withBeats + 1}&beat=1.\n` : ".\n"),
  );
  return 0;
}

function frameFor(options: Options, plan: TourPlan, step: TourStep, index: number): AnimatedTourFrame {
  const frame: AnimatedTourFrame = {
    index,
    title: step.title,
    location: stepLocation(step),
    explanation: step.explanation,
    viewLabel: step.slide ? "Slide" : step.diff && step.viewMode !== "code" ? "Diff" : "Code",
    warnings: [],
  };
  if (step.slide) {
    frame.slide = step.slide;
    return frame;
  }
  const file = stepFile(options, step);
  const root = rootFor(options, step);
  if (step.diff && step.viewMode !== "code") {
    const before = step.diff.baseRef
      ? gitShow(root, step.diff.baseRef, step.diff.baseFile ?? step.file!)
      : step.diff.beforeText ?? null;
    const after = step.diff.headRef
      ? gitShow(root, step.diff.headRef, step.diff.headFile ?? step.file!)
      : step.diff.afterText ?? readOrNull(file);
    if (before === null || after === null) frame.warnings.push("Couldn't read both sides of this diff.");
    else {
      frame.diff = buildAnimatedDiffFrame({
        beforeText: before,
        afterText: after,
        beforeLabel: step.diff.beforeLabel ?? step.diff.baseRef ?? "Before",
        afterLabel: step.diff.afterLabel ?? step.diff.headRef ?? "Working tree",
        languageId: step.diff.languageId,
        // The range is in file lines, so it only applies when both sides are whole files.
        focus: step.diff.baseRef && (step.diff.headRef || step.diff.afterText === undefined) ? step.range : undefined,
      });
      if (frame.diff.truncated) frame.warnings.push("Diff snapshot was trimmed for a compact shareable export.");
    }
    return frame;
  }
  const text = readOrNull(file);
  if (text === null) {
    frame.warnings.push(`Couldn't read ${step.file}.`);
    return frame;
  }
  const snapshot = codeFrameFromLines(
    text.replace(/\r\n/g, "\n").split("\n"),
    step.range,
    undefined,
    "\n",
    options.artifact ? STANDALONE_CODE_LIMITS : undefined,
  );
  frame.code = snapshot.frame;
  frame.warnings.push(...snapshot.warnings);
  return frame;
}

function schemaErrors(text: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  const schemaPath = path.join(__dirname, "..", "harness", "tour.schema.json");
  if (!existsSync(schemaPath)) return [];
  const validate = new Ajv({ allErrors: true, strict: false }).compile(JSON.parse(readFileSync(schemaPath, "utf8")));
  if (validate(value)) return [];
  // if/then and anyOf repeat the same problem; report each place once.
  const seen = new Set<string>();
  return (validate.errors ?? [])
    .filter((e) => e.keyword !== "if" && e.keyword !== "anyOf")
    .map((e) => `${e.instancePath || "/"} ${e.message ?? ""}${e.keyword === "additionalProperties" ? `: "${(e.params as { additionalProperty?: string }).additionalProperty}"` : ""}`)
    .filter((message) => !seen.has(message) && Boolean(seen.add(message)));
}

/** This CLI's version, from the package.json beside out/ (the extension's or the npm package's). */
function version(): string {
  try {
    return (JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

/** The slide stylesheet beside cli.js, which static pages inline. */
function readSlidesCss(): string | undefined {
  try {
    return readFileSync(path.join(__dirname, "slides.css"), "utf8");
  } catch {
    process.stderr.write("The slide stylesheet (slides.css) isn't next to cli.js; slides will be unstyled.\n");
    return undefined;
  }
}

function readRuntime(): { script: string; css: string } | undefined {
  try {
    return {
      script: readFileSync(path.join(__dirname, "slides.js"), "utf8"),
      css: readFileSync(path.join(__dirname, "slides.css"), "utf8"),
    };
  } catch {
    process.stderr.write("The slide runtime (slides.js, slides.css) isn't next to cli.js; slides won't play.\n");
    return undefined;
  }
}

function rootFor(options: Options, step: TourStep): string {
  const alias = step.root ?? step.workspaceFolder;
  return (alias && options.roots.get(alias)) || options.defaultRoot;
}

/** The step's file on disk, or null when the path tries to leave its root. */
function stepFile(options: Options, step: TourStep): string | null {
  if (!step.file || path.isAbsolute(step.file) || step.file.split(/[\\/]/).includes("..")) return null;
  return path.join(rootFor(options, step), step.file);
}

function readOrNull(file: string | null): string | null {
  if (!file) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * A stop that names both diff refs plays from git when its file isn't on disk:
 * the file at headRef, or at baseRef for a file the change deletes. Lint reads
 * it the same way, so those stops aren't reported as missing.
 */
function pinnedRevisionText(options: Options, step: TourStep): string | null {
  const diff = step.diff;
  if (!step.file || !diff?.baseRef || !diff.headRef) return null;
  const root = rootFor(options, step);
  return gitShow(root, diff.headRef, diff.headFile ?? step.file) ?? gitShow(root, diff.baseRef, diff.baseFile ?? step.file);
}

/** `git show <ref>:<path>`, read-only. Null when git, the ref or the path is missing. */
function gitShow(root: string, ref: string, file: string): string | null {
  if (!/^[\w./~^@{}-]+$/.test(ref) || file.split("/").includes("..")) return null;
  const result = spawnSync("git", ["-C", root, "show", `${ref}:${file}`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

function parseArgs(argv: string[]): Options | null {
  const [command, tour, ...rest] = argv;
  if (!command || !tour || command.startsWith("-") || tour.startsWith("-")) return null;
  const options: Options = { command, tour, json: false, artifact: false, roots: new Map(), defaultRoot: defaultRoot(tour) };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--artifact") options.artifact = true;
    else if (arg === "--out") options.out = rest[++i];
    else if (arg === "--root") {
      const value = rest[++i];
      if (!value) return null;
      const eq = value.indexOf("=");
      if (eq > 0 && !existsSync(value)) options.roots.set(value.slice(0, eq), path.resolve(value.slice(eq + 1)));
      else options.defaultRoot = path.resolve(value);
    } else return null;
  }
  return options;
}

function defaultRoot(tour: string): string {
  const dir = path.dirname(path.resolve(tour));
  return path.basename(dir) === ".repotrail" ? path.dirname(dir) : process.cwd();
}

process.exitCode = main(process.argv.slice(2));
