/** Data contracts shared by JSON tour files and editor UX. */

export type TourKind =
  | "architecture"
  | "pr-diff"
  | "file-walkthrough"
  | "request-lifecycle"
  | "bug-investigation";

export interface TourRange {
  startLine: number;     // 1-indexed
  startColumn: number;   // 1-indexed
  endLine: number;
  endColumn: number;
}

export type TourStepViewMode = "code" | "diff" | "both";
export type TourStepDiffScope = "hunk" | "file";

export interface TourStepDiff {
  /**
   * Previous/base text for the diff editor's left side. Kept for old tours and
   * non-git sources; PR/change tours should prefer baseRef so RepoTrail reads
   * the real file from local git instead of trusting generated text.
   */
  beforeText?: string;
  /**
   * Changed/current text for the diff editor's right side. If omitted, RepoTrail
   * uses the step's current selected lines from `file` for hunk diffs, or the
   * whole current file for git-backed file diffs.
   */
  afterText?: string;
  /** Git commit-ish for the left side, such as a base SHA or `origin/main`. */
  baseRef?: string;
  /** Optional git commit-ish for the right side. Omit to use the workspace file. */
  headRef?: string;
  /** Optional path at baseRef when the file was renamed. Defaults to step.file. */
  baseFile?: string;
  /** Optional path at headRef when the file was renamed. Defaults to step.file. */
  headFile?: string;
  /** Git-backed diffs default to whole-file context; legacy text diffs default to hunks. */
  scope?: TourStepDiffScope;
  beforeLabel?: string;
  afterLabel?: string;
  languageId?: string;
}

export interface TourRootRef {
  /**
   * Stable VS Code workspace folder identity. Shared tour files should prefer
   * name/pathHint when they can stay stable across machines.
   */
  workspaceFolder?: string;
  /** Human-readable workspace name, usually the folder name shown by VS Code. */
  name?: string;
  /**
   * Portable hint used to match an open root, such as "agentregistry-enterprise"
   * or "repos/agentregistry-enterprise". Not required to be an absolute path.
   */
  pathHint?: string;
  /** Absolute path is accepted for local-only tours but is less portable. */
  path?: string;
}

export type TourAction =
  | "openFile"
  | "highlightRange"
  | "revealSymbol"
  | "showDiff"
  | "showNarration";

export interface TourStep {
  title: string;
  /**
   * Optional key into TourPlan.roots. This is the preferred compact form for
   * committed multi-root JSON tours.
   */
  root?: string;
  /**
   * Optional legacy VS Code workspace folder identity. Omit for single-root
   * tours or to target the first workspace folder.
   */
  workspaceFolder?: string;
  file: string;            // workspace-relative path inside workspaceFolder
  range?: TourRange;
  /**
   * How to present the stop. Diff-backed steps default to a compact native diff.
   * `both` is accepted for old tours but renders as `diff` to avoid crowding the
   * editor with a separate source pane.
   */
  viewMode?: TourStepViewMode;
  diff?: TourStepDiff;
  symbol?: string;         // optional symbol name for revealSymbol
  explanation: string;     // markdown
  actions: TourAction[];
  /**
   * Trimmed text of the anchored range's first non-empty line, captured the
   * first time the step is executed. Used to detect/repair drift: if the code
   * at `range` no longer matches `anchor`, the UX searches the file for the
   * anchor text and re-points the highlight. Persisted so shared/resumed tours
   * survive edits to the underlying code.
   */
  anchor?: string;
}

/**
 * Result of checking a step's anchor against the current file contents.
 *   - "ok": the anchored line is where the range says it is (or no anchor yet).
 *   - "relocated": the code moved; we found the anchor elsewhere and re-pointed.
 *   - "missing": the anchor text is gone from the file entirely.
 */
export type DriftStatus = "ok" | "relocated" | "missing";

export interface TourPlan {
  kind: TourKind;
  title: string;
  summary: string;
  /** Optional root aliases used by step.root. */
  roots?: Record<string, TourRootRef>;
  steps: TourStep[];
}

export function formatStepPath(step: Pick<TourStep, "file" | "workspaceFolder">): string {
  const keyedStep = step as Pick<TourStep, "file" | "workspaceFolder" | "root">;
  const prefix = keyedStep.root ?? keyedStep.workspaceFolder;
  return prefix ? `${prefix}/${step.file}` : step.file;
}
