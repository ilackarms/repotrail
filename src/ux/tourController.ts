import * as vscode from "vscode";
import { TourProvider } from "../engine/tourProvider";
import { TourPlan, TourRequest, TourStep } from "../engine/types";
import { clearHighlights, executeStep } from "./editorActions";

export type UserAction = "next" | "back" | "deeper" | "stop";

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
export class TourController {
  private plan: TourPlan | null = null;
  private request: TourRequest | null = null;
  private index = 0;
  private readonly onChangeEmitter = new vscode.EventEmitter<void>();
  private readonly userActionEmitter = new vscode.EventEmitter<UserAction>();
  readonly onDidChange = this.onChangeEmitter.event;
  readonly onUserAction = this.userActionEmitter.event;

  constructor(private provider: TourProvider) {}

  setProvider(p: TourProvider): void {
    this.provider = p;
  }

  /** Start a tour by asking the configured provider to generate the plan. */
  async start(req: TourRequest): Promise<void> {
    this.request = req;
    this.plan = await this.provider.generate(req);
    this.index = 0;
    await this.applyCurrent();
    this.onChangeEmitter.fire();
  }

  /**
   * Initialize an empty plan that will be filled in step-by-step by an agent.
   * Used by the MCP `start_tour` tool.
   */
  startEmpty(plan: TourPlan, req?: TourRequest): void {
    this.plan = plan;
    this.request = req ?? null;
    this.index = -1; // nothing applied yet; appendStep will set to 0
    clearHighlights();
    this.onChangeEmitter.fire();
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
    await this.applyCurrent();
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
    this.onChangeEmitter.fire();
    return insertAt;
  }

  /** Replace the contents of step `at`. Re-applies if the user is on that step. */
  async updateStep(at: number, step: TourStep): Promise<void> {
    if (!this.plan) return;
    if (at < 0 || at >= this.plan.steps.length) return;
    this.plan.steps[at] = step;
    if (this.index === at) await this.applyCurrent();
    this.onChangeEmitter.fire();
  }

  /** Remove the step at `at`. Adjusts index to stay valid. */
  async removeStep(at: number): Promise<void> {
    if (!this.plan) return;
    if (at < 0 || at >= this.plan.steps.length) return;
    this.plan.steps.splice(at, 1);
    if (this.plan.steps.length === 0) {
      this.index = -1;
      clearHighlights();
    } else {
      if (this.index > at) this.index--;
      this.index = Math.max(0, Math.min(this.index, this.plan.steps.length - 1));
      await this.applyCurrent();
    }
    this.onChangeEmitter.fire();
  }

  async next(): Promise<void> {
    if (!this.plan) return;
    if (this.index < this.plan.steps.length - 1) {
      this.index++;
      await this.applyCurrent();
      this.onChangeEmitter.fire();
    }
    this.userActionEmitter.fire("next");
  }

  async back(): Promise<void> {
    if (!this.plan) return;
    if (this.index > 0) {
      this.index--;
      await this.applyCurrent();
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
    await this.applyCurrent();
    this.onChangeEmitter.fire();
  }

  stop(): void {
    this.plan = null;
    this.request = null;
    this.index = 0;
    clearHighlights();
    this.onChangeEmitter.fire();
    this.userActionEmitter.fire("stop");
  }

  snapshot(): { plan: TourPlan | null; index: number; current: TourStep | null } {
    return {
      plan: this.plan,
      index: this.index,
      current: this.plan && this.index >= 0 ? this.plan.steps[this.index] ?? null : null,
    };
  }

  private async applyCurrent(): Promise<void> {
    if (!this.plan || this.index < 0) return;
    clearHighlights();
    await executeStep(this.plan.steps[this.index]);
  }
}
