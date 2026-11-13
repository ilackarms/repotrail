/** Data contracts shared by JSON tour files and editor UX. */

export type TourKind =
  | "architecture"
  | "pr-diff"
  | "file-walkthrough"
  | "request-lifecycle"
  | "bug-investigation"
  | "design-review";

/**
 * Lines `startLine` through `endLine`, both included, 1-indexed. Columns only
 * narrow the first and last line; an `endColumn` of 1 means all of `endLine`
 * (see `editorSpan` in range.ts).
 */
export interface TourRange {
  startLine: number;     // 1-indexed
  startColumn: number;   // 1-indexed
  endLine: number;       // 1-indexed, included
  endColumn: number;     // 1-indexed, exclusive; 1 means the whole of endLine
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
  /**
   * Workspace-relative path inside workspaceFolder. Required for code and diff
   * stops. On a slide stop it is optional and names the slide's source (the
   * doc section it summarizes), which "Open source" opens on request.
   */
  file?: string;
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
  /**
   * Present on slide stops. Landing on the stop shows the slide in the
   * RepoTrail Slides panel instead of opening `file`.
   */
  slide?: TourSlide;
}

export type SlideTone = "default" | "accent" | "good" | "warn" | "bad" | "muted";
export type SlideLayout = "stack" | "columns" | "title";
export type SlideCalloutTone = "info" | "warn" | "risk" | "decision" | "question";
export type SlideNodeShape =
  | "box"
  | "service"
  | "store"
  | "file"
  | "actor"
  | "device"
  | "queue"
  | "external"
  | "decision"
  | "note";

interface SlideBlockBase {
  /** Unique within the slide. Defaults to `b1`, `b2`, … */
  id: string;
  title?: string;
  /**
   * In the `columns` layout, the 1-based column for this block. Blocks that
   * share a column stack top to bottom. Without it, a block starts the column
   * after the previous block's.
   */
  column?: number;
  /** Column weight in the `columns` layout. */
  span?: number;
  /** Reveal items one beat at a time (bullets, table rows). */
  build?: boolean;
}

export interface SlideTextBlock extends SlideBlockBase {
  type: "text";
  md: string;
}

export interface SlideBulletItem {
  /** Defaults to `<block>.<n>` (nested: `<block>.<n>.<m>`). */
  id: string;
  text: string;
  tone?: SlideTone;
  items?: SlideBulletItem[];
}

export interface SlideBulletsBlock extends SlideBlockBase {
  type: "bullets";
  ordered?: boolean;
  items: SlideBulletItem[];
}

export interface SlideTableRow {
  /** Defaults to `<block>.<n>`. */
  id: string;
  cells: string[];
  tone?: SlideTone;
}

export interface SlideTableBlock extends SlideBlockBase {
  type: "table";
  columns: string[];
  rows: SlideTableRow[];
}

/** A file a slide element points at; clicking the element opens it beside the slide. */
export interface SlideRef {
  /** Root alias; defaults to the slide stop's root. */
  root?: string;
  file: string;
  range?: TourRange;
}

export interface SlideCodeBlock extends SlideBlockBase {
  type: "code";
  code: string;
  language?: string;
  /** Line number shown for the first line. Defaults to 1. */
  startLine?: number;
  ref?: SlideRef;
}

export interface SlideCalloutBlock extends SlideBlockBase {
  type: "callout";
  tone: SlideCalloutTone;
  md: string;
}

export interface SlideFlowNode {
  id: string;
  label: string;
  sub?: string;
  shape: SlideNodeShape;
  tone?: SlideTone;
  badge?: string;
  group?: string;
  ref?: SlideRef;
}

export interface SlideFlowEdge {
  /** Defaults to `<from>-><to>`, then `<from>-><to>#2` for a repeat. */
  id: string;
  from: string;
  to: string;
  label?: string;
  style: "solid" | "dashed";
  arrow: "end" | "both" | "none";
  tone?: SlideTone;
}

export interface SlideFlowGroup {
  id: string;
  label?: string;
  tone?: SlideTone;
}

export interface SlideFlowBlock extends SlideBlockBase {
  type: "flow";
  direction: "LR" | "TB";
  nodes: SlideFlowNode[];
  edges: SlideFlowEdge[];
  groups: SlideFlowGroup[];
}

export interface SlideSequenceParticipant {
  id: string;
  label: string;
  sub?: string;
  shape: SlideNodeShape;
  tone?: SlideTone;
  ref?: SlideRef;
}

export interface SlideSequenceMessage {
  /** Defaults to `<block>.<n>`, counting messages and notes together. */
  id: string;
  from: string;
  to: string;
  label?: string;
  /** Drawn dashed, as a response. */
  reply?: boolean;
  tone?: SlideTone;
}

export interface SlideSequenceNote {
  id: string;
  note: string;
  /** Participants the note spans. */
  over: string[];
  tone?: SlideTone;
}

export interface SlideSequenceBlock extends SlideBlockBase {
  type: "sequence";
  participants: SlideSequenceParticipant[];
  messages: Array<SlideSequenceMessage | SlideSequenceNote>;
}

export type SlideBlock =
  | SlideTextBlock
  | SlideBulletsBlock
  | SlideTableBlock
  | SlideCodeBlock
  | SlideCalloutBlock
  | SlideFlowBlock
  | SlideSequenceBlock;

export interface SlideElementPatch {
  label?: string;
  sub?: string;
  badge?: string;
  tone?: SlideTone;
}

export interface SlideFlowEffect {
  edge: string;
  label?: string;
  tone?: SlideTone;
  reverse?: boolean;
}

/**
 * One build step. `show`, `hide` and `set` carry forward; `focus` and
 * `highlight` last one beat; `flow` and `pulse` play once on entering it.
 */
export interface SlideBeat {
  say?: string;
  show?: string[];
  hide?: string[];
  set?: Record<string, SlideElementPatch>;
  focus?: string[];
  highlight?: string[];
  flow?: SlideFlowEffect[];
  pulse?: string[];
}

export interface TourSlide {
  layout: SlideLayout;
  eyebrow?: string;
  subtitle?: string;
  blocks: SlideBlock[];
  beats?: SlideBeat[];
  /**
   * Problems found while reading the slide JSON. Set by RepoTrail, ignored on
   * input, and left out of exported tours.
   */
  warnings?: string[];
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

/** Display path for a stop. A slide stop with no source shows as "Slide". */
export function formatStepPath(step: Pick<TourStep, "file" | "workspaceFolder">): string {
  const keyedStep = step as Pick<TourStep, "file" | "workspaceFolder" | "root">;
  if (!step.file) return "Slide";
  const prefix = keyedStep.root ?? keyedStep.workspaceFolder;
  return prefix ? `${prefix}/${step.file}` : step.file;
}
