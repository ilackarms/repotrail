import * as vscode from "vscode";
import { TourProvider } from "../engine/tourProvider";
import { TourPlan, TourRequest, TourStep } from "../engine/types";
import { clearHighlights, executeStep } from "./editorActions";

/**
 * Owns the active TourPlan and current step index. The webview view and the
 * extension's commands both talk to this controller — never to editorActions
 * directly.
 */
export class TourController {
  private plan: TourPlan | null = null;
  private request: TourRequest | null = null;
  private index = 0;
  private readonly onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onChangeEmitter.event;

  constructor(private provider: TourProvider) {}

  setProvider(p: TourProvider): void {
    this.provider = p;
  }

  async start(req: TourRequest): Promise<void> {
    this.request = req;
    this.plan = await this.provider.generate(req);
    this.index = 0;
    await this.applyCurrent();
    this.onChangeEmitter.fire();
  }

  async next(): Promise<void> {
    if (!this.plan) return;
    if (this.index < this.plan.steps.length - 1) {
      this.index++;
      await this.applyCurrent();
      this.onChangeEmitter.fire();
    }
  }

  async back(): Promise<void> {
    if (!this.plan) return;
    if (this.index > 0) {
      this.index--;
      await this.applyCurrent();
      this.onChangeEmitter.fire();
    }
  }

  async deeper(): Promise<void> {
    if (!this.plan || !this.request || !this.provider.deepen) return;
    const current = this.plan.steps[this.index];
    const expanded = await this.provider.deepen(current, this.request);
    this.plan.steps.splice(this.index + 1, 0, ...expanded);
    this.onChangeEmitter.fire();
  }

  async followUp(question: string): Promise<string> {
    if (!this.plan || !this.provider.followUp) {
      return "No active tour.";
    }
    return this.provider.followUp(question, this.plan, this.index);
  }

  stop(): void {
    this.plan = null;
    this.request = null;
    this.index = 0;
    clearHighlights();
    this.onChangeEmitter.fire();
  }

  snapshot(): { plan: TourPlan | null; index: number; current: TourStep | null } {
    return {
      plan: this.plan,
      index: this.index,
      current: this.plan?.steps[this.index] ?? null,
    };
  }

  private async applyCurrent(): Promise<void> {
    if (!this.plan) return;
    clearHighlights();
    await executeStep(this.plan.steps[this.index]);
  }
}
