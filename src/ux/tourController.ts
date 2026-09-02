import * as vscode from "vscode";
import type { DriftStatus, TourPlan, TourStep } from "../engine/types";
import type { RepoTourSource } from "../storage/repoTours";
import { newTourId, repoTourProgressId } from "../storage/tourStore";
import type { TourRecord } from "../storage/tourStore";
import { currentWorkspaceStorageRoot, resolveTourPlanRoots } from "../workspace";
import { checkStepDrift, clearHighlights, executeStep, openStepSource, resetTourEditorLayout } from "./editorActions";
import { reconcileTourUpdate } from "./tourProgress";

/**
 * Owns the active TourPlan and current step index. The webview view, the
 * extension's commands and webview talk to this controller, never to
 * editorActions directly.
 */
export type PersistFn = (record: TourRecord | null) => void;

export class TourController {
  private plan: TourPlan | null = null;
  private index = 0;
  private tourId: string | null = null;
  private repoTourSource: RepoTourSource | null = null;
  private workspaceRoot: string | null = null;
  private createdAt: number | null = null;
  private persistFn: PersistFn | null = null;
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
      repoTourSource: this.repoTourSource ?? undefined,
      seen: [...this.seen].sort((a, b) => a - b),
    });
  }

  private setActiveContext(active: boolean): void {
    void vscode.commands.executeCommand("setContext", "repoTrail.tourActive", active);
  }

  /**
   * Load a fully-formed plan and land on step 1. Repo-local tours reuse one
   * stable progress id so opening the same JSON never creates duplicate cache
   * records. Imported files without a repo source still receive a fresh id.
   */
  async loadPlan(plan: TourPlan, workspaceRoot?: string, repoTourSource?: RepoTourSource): Promise<void> {
    this.plan = resolveTourPlanRoots(plan);
    this.index = plan.steps.length > 0 ? 0 : -1;
    this.tourId = repoTourSource ? repoTourProgressId(repoTourSource) : newTourId();
    this.repoTourSource = repoTourSource ?? null;
    this.workspaceRoot = this.resolveWorkspaceRoot(workspaceRoot);
    this.createdAt = Date.now();
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
    this.plan = resolveTourPlanRoots(record.plan);
    this.tourId = record.id;
    this.repoTourSource = record.repoTourSource ?? null;
    this.workspaceRoot = record.workspaceRoot;
    this.createdAt = record.createdAt;
    this.index = Math.max(0, Math.min(record.lastIndex, record.plan.steps.length - 1));
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

  get activeRepoTourSource(): RepoTourSource | null {
    return this.repoTourSource;
  }

  renameActiveTitle(title: string): boolean {
    if (!this.plan) return false;
    this.plan.title = title;
    this.persist();
    this.onChangeEmitter.fire();
    return true;
  }

  /** Replace an active repo tour after its JSON file changes on disk. */
  async reloadPlan(plan: TourPlan): Promise<void> {
    if (!this.plan || !this.repoTourSource) return;
    const nextPlan = resolveTourPlanRoots(plan);
    const progress = reconcileTourUpdate(this.plan.steps, this.index, this.seen, nextPlan.steps);
    this.plan = { ...nextPlan, steps: progress.steps };
    this.index = progress.index;
    this.seen = new Set(progress.seen);
    this.driftByIndex.clear();
    if (this.index >= 0 && progress.editorRefreshNeeded) await this.applyCurrent();
    else if (this.index >= 0) this.seen.add(this.index);
    else clearHighlights();
    this.persist();
    this.onChangeEmitter.fire();
    void this.scanDrift();
  }

  async next(): Promise<void> {
    if (!this.plan) return;
    if (this.index < this.plan.steps.length - 1) {
      this.index++;
      await this.applyCurrent();
      this.persist();
      this.onChangeEmitter.fire();
    }
  }

  async back(): Promise<void> {
    if (!this.plan) return;
    if (this.index > 0) {
      this.index--;
      await this.applyCurrent();
      this.persist();
      this.onChangeEmitter.fire();
    }
  }

  async showStep(index: number): Promise<void> {
    if (!this.plan) return;
    if (index < 0 || index >= this.plan.steps.length) return;
    this.index = index;
    await this.applyCurrent();
    this.persist();
    this.onChangeEmitter.fire();
  }

  /** Re-open and reveal the currently selected tour step without changing state. */
  async revealCurrent(): Promise<void> {
    if (!this.plan || this.index < 0) return;
    await this.applyCurrent();
  }

  /** Open the current stop in its real editable workspace file, even for diff steps. */
  async openCurrentSource(): Promise<void> {
    if (!this.plan || this.index < 0) return;
    clearHighlights();
    const step = this.plan.steps[this.index];
    const result = await openStepSource(step, {
      allSteps: this.plan.steps,
      currentIndex: this.index,
      plan: this.plan,
    });
    this.driftByIndex.set(this.index, result.drift);
    if (result.capturedAnchor && !step.anchor) {
      step.anchor = result.capturedAnchor;
      this.persist();
    }
    this.onChangeEmitter.fire();
  }

  /**
   * Clear the active tour from memory. Progress stays on disk for automatic
   * restoration after a VS Code reload.
   */
  stop(options?: { forgetRepoSource?: boolean }): void {
    if (options?.forgetRepoSource) this.repoTourSource = null;
    // Persist final state before tearing down in-memory references.
    this.persist();
    this.plan = null;
    this.index = 0;
    this.tourId = null;
    this.repoTourSource = null;
    this.workspaceRoot = null;
    this.createdAt = null;
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
    const planAtStart = this.plan;
    const indexAtStart = this.index;
    clearHighlights();
    const step = planAtStart.steps[indexAtStart];
    const result = await executeStep(step, {
      allSteps: planAtStart.steps,
      currentIndex: indexAtStart,
      plan: planAtStart,
    });
    if (this.plan !== planAtStart || this.index !== indexAtStart) return;
    this.driftByIndex.set(indexAtStart, result.drift);
    this.seen.add(indexAtStart);
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
        const res = await checkStepDrift(step, planAtStart);
        if (this.plan !== planAtStart) return;
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
