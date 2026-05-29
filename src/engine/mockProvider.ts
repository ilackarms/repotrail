import { TourProvider } from "./tourProvider";
import { TourPlan, TourRequest, TourStep } from "./types";

/**
 * Mock provider — picks plausible "interesting" files from the workspace and
 * emits canned narration for each. Real LLM-backed narration comes later.
 *
 * Heuristic: prefer entrypoints (main/index/server/app/cli), then config
 * (package.json, go.mod, Cargo.toml, foundry.toml), then any source file.
 */
export class MockTourProvider implements TourProvider {
  readonly id = "mock";

  async generate(req: TourRequest): Promise<TourPlan> {
    const picks = pickInterestingFiles(req.files, 4);
    const steps: TourStep[] = picks.map((file, i) => ({
      title: `${i + 1}. ${describe(file)}`,
      file,
      explanation: explain(file, req.kind),
      actions: ["openFile", "showNarration"],
    }));

    if (steps.length === 0) {
      steps.push({
        title: "No files found",
        file: "",
        explanation:
          "Code Atlas couldn't find any files in this workspace. Open a folder with source code and try again.",
        actions: ["showNarration"],
      });
    }

    return {
      kind: req.kind,
      title: `Mock ${req.kind} tour`,
      summary: `Canned ${steps.length}-step walkthrough. Replace with a real provider (set codeAtlas.anthropicApiKey) for actual analysis.`,
      steps,
    };
  }

  async deepen(step: TourStep): Promise<TourStep[]> {
    return [
      {
        ...step,
        title: `${step.title} (deeper)`,
        explanation: `${step.explanation}\n\n_Deeper explanation TODO — wire up an LLM provider._`,
      },
    ];
  }

  async followUp(question: string): Promise<string> {
    return `Mock answer to: "${question}". Wire up the Claude provider to get real answers.`;
  }
}

const ENTRYPOINT_HINTS = [
  /(^|\/)src\/main\.(ts|tsx|js|jsx|py|go|rs)$/,
  /(^|\/)src\/index\.(ts|tsx|js|jsx)$/,
  /(^|\/)src\/server\.(ts|js)$/,
  /(^|\/)src\/app\.(ts|tsx|js|jsx)$/,
  /(^|\/)src\/extension\.ts$/,
  /(^|\/)main\.(go|py|rs|ts|js)$/,
  /(^|\/)index\.(ts|tsx|js|jsx|html)$/,
  /(^|\/)cmd\/.+\/main\.go$/,
  /(^|\/)app\/page\.(tsx|jsx)$/,
  /(^|\/)app\/layout\.(tsx|jsx)$/,
];

const CONFIG_HINTS = [
  /(^|\/)package\.json$/,
  /(^|\/)go\.mod$/,
  /(^|\/)Cargo\.toml$/,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)foundry\.toml$/,
  /(^|\/)next\.config\.(ts|js|mjs)$/,
];

const README_HINTS = [/^README(\.md)?$/i, /^readme(\.md)?$/];

function pickInterestingFiles(all: string[], n: number): string[] {
  const picked = new Set<string>();
  const pickFrom = (patterns: RegExp[]) => {
    for (const p of patterns) {
      for (const f of all) {
        if (p.test(f) && !picked.has(f)) {
          picked.add(f);
          if (picked.size >= n) return;
        }
      }
      if (picked.size >= n) return;
    }
  };

  pickFrom(README_HINTS);
  pickFrom(ENTRYPOINT_HINTS);
  pickFrom(CONFIG_HINTS);

  if (picked.size < n) {
    // Fall back: any source file under src/, then any file.
    const fallback = all.filter(
      (f) => /\.(ts|tsx|js|jsx|go|py|rs|sol|java|kt|swift|rb|php|cs)$/.test(f),
    );
    for (const f of fallback) {
      if (!picked.has(f)) {
        picked.add(f);
        if (picked.size >= n) break;
      }
    }
  }

  return Array.from(picked).slice(0, n);
}

function describe(file: string): string {
  if (/README/i.test(file)) return "Project overview";
  if (/package\.json|go\.mod|Cargo\.toml|pyproject\.toml/.test(file)) return "Manifest & dependencies";
  if (/foundry\.toml/.test(file)) return "Foundry config";
  if (/next\.config/.test(file)) return "Next.js config";
  if (/extension\.ts$/.test(file)) return "VS Code extension entrypoint";
  if (/main\.(go|py|rs|ts|js)$/.test(file)) return "Program entrypoint";
  if (/server\./.test(file)) return "HTTP server entrypoint";
  if (/app\/(layout|page)\./.test(file)) return "App router root";
  if (/index\./.test(file)) return "Module entrypoint";
  return file;
}

function explain(file: string, kind: string): string {
  return (
    `**${file}**\n\n` +
    `Mock narration for a "${kind}" tour. A real provider would explain this file's role, ` +
    `point at the important ranges, and link to neighboring files.\n\n` +
    `Set \`codeAtlas.anthropicApiKey\` in settings to use Claude.`
  );
}
