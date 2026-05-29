import { TourPlan, TourRequest, TourStep } from "./types";

/**
 * A TourProvider turns a TourRequest into a TourPlan and can optionally
 * answer follow-up questions or expand a step ("go deeper").
 *
 * Providers must be deterministic in the sense that their output is a
 * structured TourPlan — they never drive the editor themselves.
 */
export interface TourProvider {
  readonly id: string;
  generate(req: TourRequest): Promise<TourPlan>;
  deepen?(step: TourStep, req: TourRequest): Promise<TourStep[]>;
  followUp?(question: string, plan: TourPlan, stepIndex: number): Promise<string>;
}
