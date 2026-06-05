/** Data contracts shared by the external harness, MCP server, and editor UX. */

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

export interface TourStepDiff {
  /** Previous/base text for the diff editor's left side. */
  beforeText: string;
  /**
   * Changed/current text for the diff editor's right side. If omitted, RepoTrail
   * uses the step's current selected lines from `file`.
   */
  afterText?: string;
  beforeLabel?: string;
  afterLabel?: string;
  languageId?: string;
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
   * Optional VS Code workspace folder identity from get_workspace. Omit for
   * single-root tours or to target the first workspace folder.
   */
  workspaceFolder?: string;
  file: string;            // workspace-relative path inside workspaceFolder
  range?: TourRange;
  /**
   * How to present the stop. `both` opens the file highlight and a side-by-side
   * diff. Steps without `diff` fall back to code view.
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
  steps: TourStep[];
}

export function formatStepPath(step: Pick<TourStep, "file" | "workspaceFolder">): string {
  return step.workspaceFolder ? `${step.workspaceFolder}/${step.file}` : step.file;
}
