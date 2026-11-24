import { prHtmlUrl, PrRef } from "../github/prRef";

export function composeAgentSetupPrompt(skillText: string, requestText: string): string {
  const skill = skillText.trim();
  if (!skill) throw new Error("The bundled RepoTrail skill is empty.");

  const request = requestText.trim();
  if (!request) throw new Error("The RepoTrail request is empty.");

  return [
    "The complete RepoTrail skill bundled with the installed extension is included below.",
    "If your agent supports persistent skills, install or update it as `repo-trail`. Otherwise, apply it as the active instructions for this request.",
    "Do not fetch another copy; use the bundled version below so the instructions match the installed extension.",
    "",
    "<repo_trail_skill>",
    skill,
    "</repo_trail_skill>",
    "",
    "<repo_trail_request>",
    request,
    "</repo_trail_request>",
  ].join("\n");
}

/**
 * A change a workspace root has checked out: a pull request, or a branch with
 * commits the default branch doesn't have. Agent Setup names it so the agent
 * tours that change instead of the whole codebase.
 */
export type RootCheckout =
  | {
      kind: "pr";
      pr: PrRef;
      /** The local branch, when one is checked out. */
      branch?: string;
      /** The default branch as a ref git can read, like `origin/main`. */
      defaultRef?: string;
    }
  | {
      kind: "branch";
      branch: string;
      defaultRef: string;
      /** Commits on the branch that the default branch doesn't have. */
      ahead: number;
    };

export interface SetupRoot {
  alias: string;
  name: string;
  workspaceFolder: string;
  path: string;
  checkout?: RootCheckout;
}

export interface TourAuthoringRequest {
  roots: SetupRoot[];
  /** The repo-relative tours directory, `.repotrail`. */
  toursDir: string;
  /** Where RepoTrail workspaces are saved, as shown to the user. */
  workspaceRegistryDir: string;
  schemaPath: string;
  cliPath: string;
}

/**
 * Branch names and refs come from the repository, and a pull request's branch
 * is named by its author. Only plain names go into the prompt, and none that
 * reads as a link to a pull request or issue, which a chat box may attach.
 */
const PLAIN_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const ITEM_LINK_PATH = /\/(?:pull|pulls|issues|discussions)\/[0-9]/i;

export function isPlainRefName(name: string): boolean {
  return PLAIN_REF.test(name) && !name.includes("..") && !ITEM_LINK_PATH.test(name);
}

/**
 * Whether being on `branch` is a change worth touring: a named branch other
 * than the default one. `main` and `master` never count, since a clone whose
 * record of the remote's default branch is stale would otherwise report its
 * own default branch as a change.
 */
export function isChangeBranch(branch: string | undefined, defaultBranch: string | undefined): branch is string {
  if (!branch || !defaultBranch) return false;
  return branch !== defaultBranch && branch !== "main" && branch !== "master";
}

function checkoutLine(alias: string, checkout: RootCheckout): string {
  const defaultRef = checkout.defaultRef && isPlainRefName(checkout.defaultRef) ? checkout.defaultRef : undefined;
  const branch = checkout.branch && isPlainRefName(checkout.branch) ? checkout.branch : undefined;
  if (checkout.kind === "pr") {
    const parts = [`pull request ${prHtmlUrl(checkout.pr)}`];
    if (branch) parts.push(`checked out on branch ${branch}`);
    if (defaultRef) parts.push(`default branch ${defaultRef}`);
    return `- ${alias}: ${parts.join("; ")}`;
  }
  const commits = checkout.ahead === 1 ? "1 commit" : `${checkout.ahead} commits`;
  const ahead = defaultRef ? `ahead of default branch ${defaultRef}` : "ahead of the default branch";
  return `- ${alias}: ${branch ? `branch ${branch}` : "the current branch"}; ${commits} ${ahead}`;
}

/** The lines that tell the agent which checked-out change to tour. Empty when no root has one. */
export function checkedOutChangeLines(roots: SetupRoot[]): string[] {
  const changed = roots.filter((root) => root.checkout);
  if (changed.length === 0) return [];
  const bases = [
    changed.some((root) => root.checkout?.kind === "pr")
      ? "for a pull request, its base branch on GitHub when you can look it up, otherwise the repository's default branch"
      : "",
    changed.some((root) => root.checkout?.kind === "branch") ? "for a branch, the default branch" : "",
  ].filter(Boolean).join("; ");
  return [
    "Checked-out change:",
    ...changed.map((root) => checkoutLine(root.alias, root.checkout as RootCheckout)),
    "",
    "Tour what is checked out unless the user names a different subject: a change-review tour (kind \"pr-diff\") of what the change does, not an architecture tour of the whole codebase. A change that is a design document gets a design-review tour instead, as described below.",
    `Set diff.baseRef on every changed-code stop to the merge base SHA of HEAD and the change's base branch: ${bases}.`,
    "Set diff.headRef to HEAD's SHA, so the tour still shows this change after more commits land.",
    "If the user asks for something else, such as an architecture or subsystem tour, do that instead and ignore this section.",
  ];
}

function exampleTour(roots: SetupRoot[]): string {
  const rootJson = Object.fromEntries(
    roots.map((root) => [root.alias, { name: root.name, pathHint: root.name }]),
  );
  const firstAlias = roots[0]?.alias ?? "project";
  const reviewsChange = roots.some((root) => root.checkout);
  const step = reviewsChange
    ? {
        root: roots.find((root) => root.checkout)?.alias ?? firstAlias,
        file: "src/example.ts",
        range: { startLine: 1, endLine: 20 },
        title: "Bad requests now fail before the database",
        explanation: "Markdown narration. Keep it focused; do not paste code here.",
        viewMode: "diff",
        diff: { baseRef: "MERGE_BASE_SHA", headRef: "HEAD_SHA", scope: "file" },
      }
    : {
        root: firstAlias,
        file: "src/example.ts",
        range: { startLine: 1, endLine: 20 },
        title: "Requests are validated before they reach a handler",
        explanation: "Markdown narration. Keep it focused; do not paste code here.",
        viewMode: "code",
      };
  return JSON.stringify(
    {
      repoTrailTour: 2,
      exportedAt: "ISO_TIMESTAMP",
      plan: {
        kind: reviewsChange ? "pr-diff" : "architecture",
        title: "Short useful tour title",
        summary: "One paragraph describing what this tour teaches.",
        roots: roots.length > 0 ? rootJson : { [firstAlias]: { name: firstAlias, pathHint: firstAlias } },
        steps: [step],
      },
    },
    null,
    2,
  );
}

/** The request half of Agent Setup: what to write, where, and for which roots. */
export function buildTourAuthoringRequest(input: TourAuthoringRequest): string {
  const { roots, toursDir, workspaceRegistryDir, schemaPath, cliPath } = input;
  const rootLines = roots
    .map((root) => `- ${root.alias}: name=${root.name}; workspaceFolder=${root.workspaceFolder}; path=${root.path}; shared tours go in ${root.path}/${toursDir}/`)
    .join("\n");
  const changeLines = checkedOutChangeLines(roots);

  return [
    "Create a RepoTrail tour for this VS Code workspace.",
    "",
    "Mode: existing VS Code workspace. The target roots are already open below.",
    "",
    "Write one complete JSON tour file into the owning project's .repotrail/ directory.",
    "",
    `If the user instead asks you to create a new RepoTrail workspace, save the .code-workspace under ${workspaceRegistryDir}/, open it in VS Code if possible, and still write tours into repo-local .repotrail/ directories.`,
    "",
    "Open workspace roots:",
    rootLines || "- No workspace roots detected. Ask the user to open the target project in VS Code.",
    "",
    ...(changeLines.length > 0 ? [...changeLines, ""] : []),
    "Choose the output path:",
    `- If the tour primarily explains one project, write ${toursDir}/<descriptive-slug>.json inside that project.`,
    `- For a cross-project tour, write the JSON into the project that owns the story and reference the other open roots through plan.roots plus per-step root aliases.`,
    "- After writing the file, tell the user the path and stop. RepoTrail will refresh its library from the filesystem.",
    "",
    "Presentation mode decision:",
    "- If the user mentions a PR, PRs, commit, commits, branch comparison, diff, changes, review, or another explicit change window, create a change-review tour: use kind \"pr-diff\" and make every changed-code stop diff-backed.",
    "- Changed-code stops in change-review tours use viewMode \"diff\" with diff.baseRef and diff.headRef pinned to commit SHAs. Omit headRef only to compare against uncommitted work in the workspace.",
    "- Use diff.scope \"file\" for normal PR/commit review stops so RepoTrail reads real full-file contents from git and VS Code can show unchanged surrounding code.",
    "- Do not paste generated code into diff.beforeText/diff.afterText for git-backed reviews. Use pasted text only when there is no local git ref to compare.",
    "- Use highlight-only viewMode \"code\" only for codebase, file, subsystem, request-path, or architecture tours unrelated to a window of changes, plus optional orientation/context stops that do not review changed code.",
    "- If the subject is a design document, RFC, ADR, proposal, or architecture plan, even one that arrives as a PR, create a design-review tour (kind \"design-review\") built from slides, as the skill's \"Design Reviews And Slides\" section describes.",
    "",
    "JSON format:",
    "```json",
    exampleTour(roots),
    "```",
    "",
    "Rules:",
    "- Read the repo before choosing stops.",
    "- Use workspace-relative forward-slash file paths only.",
    "- Ranges are 1-indexed and cover startLine through endLine, both included. Point them at the lines the explanation is about.",
    "- Order stops by how the system works, not by file path. Open with what the change does and why, give mechanical changes one shared stop, and make each title state the point. The repo-trail skill's \"What Makes A Good Tour\" section has the full guidance.",
    "- Do not use absolute file paths in steps, empty file paths, or paths containing \"..\".",
    `- Check the finished file with RepoTrail's linter and fix every error: node "${cliPath}" lint <tour file>. It validates against the JSON Schema at ${schemaPath}, checks beat ids, sources and text budgets. Pass --root <alias>=<dir> for roots outside the tour's project.`,
    `- For slides, if you can open a browser: node "${cliPath}" render <tour file> --out <file.html>, then open <file.html>#stop=<n>&beat=<k> to see any slide at any beat.`,
  ].join("\n");
}
