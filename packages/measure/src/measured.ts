/**
 * The one way to call a model: `measured` times the call, prices the tokens the provider
 * reported, and writes exactly one usage_events row, whether the call succeeds or throws.
 * A model call that is not measured is a call whose cost nobody can explain later.
 */
import { estimateCostUsdMicros, loadPriceTable, type PriceTable, type TokenCounts } from "./pricing.js";
import type { UsageEventsRepo } from "./repo.js";
import type { UsageEvent, UsageStage } from "./usage-events.js";

/** What a provider call must return for it to be measured: its result and its reported usage. */
export interface ModelCallResult<T> {
  value: T;
  usage: TokenCounts;
}

export interface MeasureContext {
  repo: UsageEventsRepo;
  /** Defaults to `loadPriceTable()`. */
  prices?: PriceTable;
  /** Monotonic milliseconds; injectable so tests do not depend on wall-clock. */
  clock?: () => number;
  /** ISO timestamp for the row; injectable for the same reason. */
  now?: () => string;
}

export interface CallLabels {
  traceId: string;
  stage: UsageStage;
  provider: string;
  modelId: string;
  simulated: boolean;
  attemptId?: string;
  attackId?: string;
  seed?: number;
}

function errorCodeOf(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") return err.code;
  return "MODEL_CALL_FAILED";
}

/**
 * Runs `call` and records its row. On failure the row has outcome `error`, zero tokens (a
 * failed request reports none) and the error's code; the error is rethrown unchanged.
 */
export async function measured<T>(
  ctx: MeasureContext,
  labels: CallLabels,
  call: () => Promise<ModelCallResult<T>>,
): Promise<{ value: T; event: UsageEvent }> {
  const clock = ctx.clock ?? (() => performance.now());
  const prices = ctx.prices ?? loadPriceTable();
  const start = clock();
  const base = {
    ...labels,
    ...(ctx.now ? { at: ctx.now() } : {}),
  };
  try {
    const { value, usage } = await call();
    const latencyMs = Math.round(clock() - start);
    const { micros, known } = estimateCostUsdMicros(prices, labels.modelId, usage);
    const event = ctx.repo.record({
      ...base,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      latencyMs,
      costUsdMicros: micros,
      costKnown: known,
      outcome: "ok",
    });
    return { value, event };
  } catch (err) {
    ctx.repo.record({
      ...base,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      latencyMs: Math.round(clock() - start),
      costUsdMicros: 0,
      costKnown: labels.modelId in prices,
      outcome: "error",
      errorCode: errorCodeOf(err),
    });
    throw err;
  }
}
