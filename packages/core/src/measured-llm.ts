/**
 * Wraps an `LlmProvider` so every completion writes one `usage_events` row: tokens as the
 * provider reported them, latency, integer cost in USD micros and the traceId of the run.
 * A failed call is a row too, because a failed request is real spend.
 *
 * The scanner is the only caller today. It exists so a question the business has to answer,
 * "what does it cost us to scan a store", has an answer that comes from data.
 */
import { measured, type MeasureContext, type UsageStage } from "@agentpos/measure";
import type { LlmCompletionRequest, LlmCompletionResult, LlmProvider } from "./llm.js";

export interface MeasuredLlmLabels {
  /** Crosses scan, catalog, cart, checkout and settle. The join key for everything. */
  traceId: string;
  stage: UsageStage;
  /** True when no real model answered (a recorded fixture). Written, never inferred. */
  simulated?: boolean;
}

/**
 * Returns a provider with the same behaviour that records what each call cost. The wrapped
 * provider is unchanged, so measuring is a decision of the caller and never of the transport.
 */
export function measuredLlm(
  provider: LlmProvider,
  ctx: MeasureContext,
  labels: MeasuredLlmLabels,
): LlmProvider {
  return {
    name: provider.name,
    model: provider.model,
    async complete(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
      const { value } = await measured(
        ctx,
        {
          traceId: labels.traceId,
          stage: labels.stage,
          provider: provider.name,
          modelId: provider.model,
          simulated: labels.simulated ?? false,
        },
        async () => {
          const result = await provider.complete(req);
          return { value: result, usage: result.usage };
        },
      );
      return value;
    },
  };
}
