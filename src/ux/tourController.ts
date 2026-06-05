import * as vscode from "vscode";
import { DriftStatus, TourPlan, TourStep } from "../engine/types";
import { newTourId, TourRecord } from "../storage/tourStore";
import { currentWorkspaceStorageRoot } from "../workspace";
import { checkStepDrift, clearHighlights, executeStep, resetTourEditorLayout } from "./editorActions";

/**
 * What produced the most recent onDidChange. Lets the UX distinguish an agent
 * splicing in new steps (`insert`) from the user navigating (`nav`) or the
 * initial emission (`append`), so it can surface a "steps added" banner only
 * when it's genuinely a deepening.
 */
export type TourMutation =
  | "start"
  | "append"
  | "insert"
  | "update"
  | "remove"
  | "nav"
  | "stop"
  | null;

/**
 * Owns the active TourPlan and current step index. The webview view, the
 * extension's commands, and the MCP server all talk to this controller —
 * never to editorActions directly.
 */
export type PersistFn = (record: TourRecord | null) => void;

export class TourController {
  private plan: TourPlan | null = null;
  private index = 0;
  private tourId: string | null = null;
  private workspaceRoot: string | null = null;
  private createdAt: number | null = null;
  private persistFn: PersistFn | null = null;
  private lastMutationKind: TourMutation = null;
  // Per-step drift status (does the highlighted code still match what the tour
  // was authored against?) and the set of visited ("understood") steps.
  private driftByIndex = new Map<number, DriftStatus>();
  private seen = new Set<number>();
  private readonly onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onChangeEmitter.event;

  setPersistFn(fn: PersistFn): void {
    this.persistFn = fn;
  }

  private resolveWorkspaceRoot(workspaceRoot?: string): string {
    return workspaceRoot ?? currentWorkspaceStorageRoot();
  }

  private persist(): void {
    if (!this.persistFn) return;
    if (!this.plan || !this.tourId || !this.workspaceRoot || this.createdAt == null) {
      this.persistFn(null);
      return;
    }
    this.persistFn({
      id: this.tourId,
      workspaceRoot: this.workspaceRoot,
      createdAt: this.createdAt,
      updatedAt: Date.now(),
      lastIndex: this.index,
      plan: this.plan,
      seen: [...this.seen].sort((a, b) => a - b),
    });
  }

  private setActiveContext(active: boolean): void {
    void vscode.commands.executeCommand("setContext", "repoTrail.tourActive", active);
  }

  /**
   * Initialize an empty plan that will be filled in step-by-step by an agent.
   * Used by the MCP `start_tour` tool.
   */
  startEmpty(plan: TourPlan, workspaceRoot?: string): void {
    this.plan = plan;
    this.index = -1; // nothing applied yet; appendStep will set to 0
    this.tourId = newTourId();
    this.workspaceRoot = this.resolveWorkspaceRoot(workspaceRoot);
    this.createdAt = Date.now();
    this.lastMutationKind = "start";
    this.driftByIndex.clear();
    this.seen = new Set();
    resetTourEditorLayout();
    this.setActiveContext(true);
    clearHighlights();
    this.persist();
    this.onChangeEmitter.fire();
  }

  /**
   * Load a fully-formed plan as a brand-new tour. Unlike `resume`, this mints
   * a fresh id so it persists as its own entry, and lands the user on step 1.
   */
  async loadPlan(plan: TourPlan, workspaceRoot?: string): Promise<void> {
    this.plan = plan;
    this.index = plan.steps.length > 0 ? 0 : -1;
    this.tourId = newTourId();
    this.workspaceRoot = this.resolveWorkspaceRoot(workspaceRoot);
    this.createdAt = Date.now();
    this.lastMutationKind = "start";
    this.driftByIndex.clear();
    this.seen = new Set();
    resetTourEditorLayout();
    this.setActiveContext(true);
    await this.applyCurrent();
    this.persist();
    this.onChangeEmitter.fire();
    void this.scanDrift();
  }

  /** Load a previously-saved tour back into the controller. */
  async resume(record: TourRecord): Promise<void> {
    this.plan = record.plan;
    this.tourId = record.id;
    this.workspaceRoot = record.workspaceRoot;
    this.createdAt = record.createdAt;
    this.index = Math.max(0, Math.min(record.lastIndex, record.plan.steps.length - 1));
    this.lastMutationKind = "start";
    this.driftByIndex.clear();
    this.seen = new Set(record.seen ?? []);
    resetTourEditorLayout();
    this.setActiveContext(true);
    await this.applyCurrent();
    this.persist(); // bump updatedAt so resume bubbles to top of list
    this.onChangeEmitter.fire();
    void this.scanDrift();
  }

  get activeTourId(): string | null {
    return this.tourId;
  }

  /** What produced the most recent change. See {@link TourMutation}. */
  get lastMutation(): TourMutation {
    return this.lastMutationKind;
  }

  get activeWorkspaceRoot(): string | null {
    return this.workspaceRoot;
  }

  /** Append a step (agent-driven) and immediately show it. Returns new index. */
  async appendStep(step: TourStep): Promise<number> {
    if (!this.plan) {
      this.plan = {
        kind: "architecture",
        title: "Tour",
        summary: "",
        steps: [],
      };
    }
    this.plan.steps.push(step);
    this.index = this.plan.steps.length - 1;
    this.lastMutationKind = "append";
    await this.applyCurrent();
    this.persist();
    this.onChangeEmitter.fire();
    return this.index;
  }

  /**
   * Insert a step at a specific position (0-indexed). The current view stays
   * on whatever step the user is on — we adjust `index` if necessary to keep
   * the user looking at the same step they were on. Returns the inserted index.
   */
  insertStep(at: number, step: TourStep): number {
    if (!this.plan) {
      this.plan = { kind: "architecture", title: "Tour", summary: "", steps: [] };
    }
    const insertAt = Math.max(0, Math.min(at, this.plan.steps.length));
    this.plan.steps.splice(insertAt, 0, step);
    if (this.index >= insertAt) this.index++;
    this.lastMutationKind = "insert";
    this.persist();
    this.onChangeEmitter.fire();
    return insertAt;
  }

  /** Replace the contents of step `at`. Re-applies if the user is on that step. */
  async updateStep(at: number, step: TourStep): Promise<void> {
    if (!this.plan) return;
    if (at < 0 || at >= this.plan.steps.length) return;
    this.plan.steps[at] = step;
    this.lastMutationKind = "update";
    if (this.index === at) await this.applyCurrent();
    this.persist();
    this.onChangeEmitter.fire();
  }

  /** Remove the step at `at`. Adjusts index to stay valid. */
  async removeStep(at: number): Promise<void> {
    if (!this.plan) return;
    if (at < 0 || at >= this.plan.steps.length) return;
    this.plan.steps.splice(at, 1);
    this.lastMutationKind = "remove";
    if (this.plan.steps.length === 0) {
      this.index = -1;
      clearHighlights();
    } else {
      if (this.index > at) this.index--;
      this.index = Math.max(0, Math.min(this.index, this.plan.steps.length - 1));
      await this.applyCurrent();
    }
    this.persist();
    this.onChangeEmitter.fire();
  }

  async next(): Promise<void> {
    if (!this.plan) return;
    if (this.index < this.plan.steps.length - 1) {
      this.index++;
      this.lastMutationKind = "nav";
      await this.applyCurrent();
      this.persist();
      this.onChangeEmitter.fire();
    }
  }

  async back(): Promise<void> {
    if (!this.plan) return;
    if (this.index > 0) {
      this.index--;
      this.lastMutationKind = "nav";
      await this.applyCurrent();
      this.persist();
      this.onChangeEmitter.fire();
    }
  }

  async showStep(index: number): Promise<void> {
    if (!this.plan) return;
    if (index < 0 || index >= this.plan.steps.length) return;
    this.index = index;
    this.lastMutationKind = "nav";
    await this.applyCurrent();
    this.persist();
    this.onChangeEmitter.fire();
  }

  /** Re-open and reveal the currently selected tour step without changing state. */
  async revealCurrent(): Promise<void> {
    if (!this.plan || this.index < 0) return;
    await this.applyCurrent();
  }

  /**
   * Clear the active tour from memory. The persisted record stays on disk so
   * the user can resume from the sidebar list.
   */
  stop(): void {
    // Persist final state before tearing down in-memory references.
    this.persist();
    this.plan = null;
    this.index = 0;
    this.tourId = null;
    this.workspaceRoot = null;
    this.createdAt = null;
    this.lastMutationKind = "stop";
    this.driftByIndex.clear();
    this.seen = new Set();
    resetTourEditorLayout();
    this.setActiveContext(false);
    clearHighlights();
    this.onChangeEmitter.fire();
  }

  snapshot(): {
    plan: TourPlan | null;
    index: number;
    current: TourStep | null;
    drift: Record<number, DriftStatus>;
    currentDrift: DriftStatus;
    seen: number[];
  } {
    const drift: Record<number, DriftStatus> = {};
    for (const [i, s] of this.driftByIndex) if (s !== "ok") drift[i] = s;
    return {
      plan: this.plan,
      index: this.index,
      current: this.plan && this.index >= 0 ? this.plan.steps[this.index] ?? null : null,
      drift,
      currentDrift: this.driftByIndex.get(this.index) ?? "ok",
      seen: [...this.seen].sort((a, b) => a - b),
    };
  }

  private async applyCurrent(): Promise<void> {
    if (!this.plan || this.index < 0) return;
    clearHighlights();
    const step = this.plan.steps[this.index];
    const result = await executeStep(step, {
      allSteps: this.plan.steps,
      currentIndex: this.index,
    });
    this.driftByIndex.set(this.index, result.drift);
    this.seen.add(this.index);
    if (result.capturedAnchor && !step.anchor) {
      step.anchor = result.capturedAnchor;
      this.persist();
    }
  }

  /**
   * Pre-scan every ranged step for drift against the current files (used on
   * load/resume/import so the route can flag stale stops before the user walks
   * to them). Captures missing anchors as a side effect. Best-effort.
   */
  private async scanDrift(): Promise<void> {
    if (!this.plan) return;
    const planAtStart = this.plan;
    let changed = false;
    for (let i = 0; i < planAtStart.steps.length; i++) {
      if (this.plan !== planAtStart) return; // tour changed under us — abort
      const step = planAtStart.steps[i];
      if (!step.range) continue;
      try {
        const res = await checkStepDrift(step);
        this.driftByIndex.set(i, res.drift);
        if (res.capturedAnchor && !step.anchor) {
          step.anchor = res.capturedAnchor;
          changed = true;
        }
      } catch {
        /* ignore a single bad file */
      }
    }
    if (this.plan !== planAtStart) return;
    if (changed) this.persist();
    this.onChangeEmitter.fire();
  }
}
