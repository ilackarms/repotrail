import * as vscode from "vscode";
import { TourProvider } from "../engine/tourProvider";
import { DriftStatus, TourPlan, TourRequest, TourStep } from "../engine/types";
import { newTourId, TourRecord } from "../storage/tourStore";
import { checkStepDrift, clearHighlights, executeStep } from "./editorActions";

export type UserAction = "next" | "back" | "deeper" | "stop";

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
 *
 * Two control modes coexist:
 *   - "provider" mode: a TourProvider pre-generated all steps. next/back
 *     navigate within plan.steps; deeper calls provider.deepen.
 *   - "agent" mode: an external agent (via MCP) drives the tour by calling
 *     `appendStep` and waiting on `onUserAction`. next/back still navigate;
 *     when the agent wants to add more steps it calls appendStep.
 */
export type PersistFn = (record: TourRecord | null) => void;

export class TourController {
  private plan: TourPlan | null = null;
  private request: TourRequest | null = null;
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
  private readonly userActionEmitter = new vscode.EventEmitter<UserAction>();
  readonly onDidChange = this.onChangeEmitter.event;
  readonly onUserAction = this.userActionEmitter.event;

  constructor(private provider: TourProvider) {}

  setProvider(p: TourProvider): void {
    this.provider = p;
  }

  setPersistFn(fn: PersistFn): void {
    this.persistFn = fn;
  }

  private resolveWorkspaceRoot(req?: TourRequest): string {
    return (
      req?.workspaceRoot ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      "_no_workspace"
    );
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
    void vscode.commands.executeCommand("setContext", "codeAtlas.tourActive", active);
  }

  /** Start a tour by asking the configured provider to generate the plan. */
  async start(req: TourRequest): Promise<void> {
    this.request = req;
    this.plan = await this.provider.generate(req);
    this.index = 0;
    this.tourId = newTourId();
    this.workspaceRoot = this.resolveWorkspaceRoot(req);
    this.createdAt = Date.now();
    this.lastMutationKind = "start";
    this.driftByIndex.clear();
    this.seen = new Set();
    this.setActiveContext(true);
    await this.applyCurrent();
    this.persist();
    this.onChangeEmitter.fire();
    void this.scanDrift();
  }

  /**
   * Initialize an empty plan that will be filled in step-by-step by an agent.
   * Used by the MCP `start_tour` tool.
   */
  startEmpty(plan: TourPlan, req?: TourRequest): void {
    this.plan = plan;
    this.request = req ?? null;
    this.index = -1; // nothing applied yet; appendStep will set to 0
    this.tourId = newTourId();
    this.workspaceRoot = this.resolveWorkspaceRoot(req);
    this.createdAt = Date.now();
    this.lastMutationKind = "start";
    this.driftByIndex.clear();
    this.seen = new Set();
    this.setActiveContext(true);
    clearHighlights();
    this.persist();
    this.onChangeEmitter.fire();
  }

  /**
   * Load a fully-formed plan as a brand-new tour (imported file or sample
   * demo). Unlike `resume`, this mints a fresh id so it persists as its own
   * entry, and lands the user on the first step.
   */
  async loadPlan(plan: TourPlan, req?: TourRequest): Promise<void> {
    this.plan = plan;
    this.request = req ?? null;
    this.index = plan.steps.length > 0 ? 0 : -1;
    this.tourId = newTourId();
    this.workspaceRoot = this.resolveWorkspaceRoot(req);
    this.createdAt = Date.now();
    this.lastMutationKind = "start";
    this.driftByIndex.clear();
    this.seen = new Set();
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
    this.request = null;
    this.lastMutationKind = "start";
    this.driftByIndex.clear();
    this.seen = new Set(record.seen ?? []);
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
    this.userActionEmitter.fire("next");
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
    this.userActionEmitter.fire("back");
  }

  async deeper(): Promise<void> {
    if (!this.plan) return;
    if (this.request && this.provider.deepen) {
      const current = this.plan.steps[this.index];
      const expanded = await this.provider.deepen(current, this.request);
      this.plan.steps.splice(this.index + 1, 0, ...expanded);
      this.onChangeEmitter.fire();
    }
    this.userActionEmitter.fire("deeper");
  }

  async followUp(question: string): Promise<string> {
    if (!this.plan || !this.provider.followUp) {
      return "No active tour.";
    }
    return this.provider.followUp(question, this.plan, this.index);
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
    this.request = null;
    this.index = 0;
    this.tourId = null;
    this.workspaceRoot = null;
    this.createdAt = null;
    this.lastMutationKind = "stop";
    this.driftByIndex.clear();
    this.seen = new Set();
    this.setActiveContext(false);
    clearHighlights();
    this.onChangeEmitter.fire();
    this.userActionEmitter.fire("stop");
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
