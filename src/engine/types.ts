/**
 * Tour engine data contracts.
 *
 * The engine emits a TourPlan composed of TourSteps. Each step is a
 * deterministic, declarative instruction the UX layer executes. The engine
 * does NOT touch the editor directly — it only produces data.
 */

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

export type TourAction =
  | "openFile"
  | "highlightRange"
  | "revealSymbol"
  | "showNarration";

export interface TourStep {
  title: string;
  file: string;            // workspace-relative path
  range?: TourRange;
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

export interface TourRequest {
  kind: TourKind;
  workspaceRoot: string;
  /** Workspace-relative file paths discovered by the analysis layer. */
  files: string[];
  /** Optional seed files the user pre-selected. */
  seedFiles?: string[];
  /** Optional unified diff / PR description for diff-mode tours. */
  diff?: string;
  /** Free-form user question for bug-investigation mode. */
  question?: string;
}
