import { TourProvider } from "./tourProvider";
import { TourPlan, TourRequest, TourStep } from "./types";

/**
 * Anthropic Claude–backed tour provider. STUB.
 *
 * TODO(llm):
 *   - Build a system prompt that explains the TourPlan schema (see types.ts).
 *   - Feed compact repo context: top-level tree, package.json/README excerpts,
 *     seedFiles content, and (in diff mode) the unified diff.
 *   - Use Anthropic tool use / JSON mode to enforce the schema.
 *   - Validate the response against TourStep before returning.
 *   - Cache plans per (workspaceRoot, kind, contextHash).
 *
 * Until wired up, this throws so the controller can fall back to MockTourProvider.
 */
export class ClaudeTourProvider implements TourProvider {
  readonly id = "claude";

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async generate(_req: TourRequest): Promise<TourPlan> {
    // TODO(llm): replace with a real Anthropic call.
    //
    // import Anthropic from "@anthropic-ai/sdk";
    // const client = new Anthropic({ apiKey: this.apiKey });
    // const resp = await client.messages.create({
    //   model: this.model,
    //   max_tokens: 4096,
    //   system: TOUR_SYSTEM_PROMPT,
    //   messages: [{ role: "user", content: buildUserPrompt(_req) }],
    // });
    // return parseAndValidate(resp);
    throw new Error("ClaudeTourProvider not implemented yet — see TODO(llm).");
  }

  async deepen(_step: TourStep, _req: TourRequest): Promise<TourStep[]> {
    throw new Error("ClaudeTourProvider.deepen not implemented yet.");
  }

  async followUp(_question: string, _plan: TourPlan, _stepIndex: number): Promise<string> {
    throw new Error("ClaudeTourProvider.followUp not implemented yet.");
  }
}
