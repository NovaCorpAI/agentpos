/**
 * usage_events: one row per model call. Ported from agentpos-alexa
 * (packages/bridge/src/storage/usage-events.ts) and narrowed to what the brain and the harness
 * need. Documented in this package's README. Tokens and money are integers; cost is USD micros.
 */

/**
 * Which part of the work made the call. The first four are the reasoning buyer's decision loop
 * (`agentpos-buyer`); the last two are this repository's scanner, which calls a model to redact
 * catalog descriptions and to extract structured drafts. A new consumer adds its stage here, so
 * the set stays a closed union and a typo is a compile error.
 */
export type UsageStage = "plan" | "research" | "decide" | "explain" | "redact" | "extract";

/** How the call ended. A failed call is still a row: failed runs count toward real spend. */
export type UsageOutcome = "ok" | "error";

export interface UsageEvent {
  /** UUID, assigned by the writer. */
  id: string;
  /** Crosses plan, tool call, mandate check and settlement. The join key for everything. */
  traceId: string;
  /** ISO 8601, UTC. */
  at: string;
  stage: UsageStage;
  /** Provider name, e.g. `nebius` or `recorded`. */
  provider: string;
  /** Exactly as the provider names it. Casing matters. */
  modelId: string;
  /** Uncached input tokens, from the provider response. Never estimated. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the prompt cache. Zero when the provider does not report them. */
  cacheReadTokens: number;
  /** Input tokens written to the prompt cache. Zero when the provider does not report them. */
  cacheWriteTokens: number;
  latencyMs: number;
  /** Estimated cost, 1 USD = 1_000_000. Integer, never a float. */
  costUsdMicros: number;
  /** False when the model id is missing from the price table, so unknowns are visible, not silently zero. */
  costKnown: boolean;
  outcome: UsageOutcome;
  /** Machine-readable code of the failure, when `outcome` is `error`. */
  errorCode?: string;
  /** True when no real model answered (recorded model, mock mode). Always written, never inferred. */
  simulated: boolean;
  /** Harness rows only. */
  attemptId?: string;
  /** Harness rows only. */
  attackId?: string;
  /** Harness rows only. */
  seed?: number;
}

/** DDL for node:sqlite. Applied by the storage adapter on open. */
export const USAGE_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS usage_events (
  id                 TEXT PRIMARY KEY,
  trace_id           TEXT NOT NULL,
  at                 TEXT NOT NULL,
  stage              TEXT NOT NULL,
  provider           TEXT NOT NULL,
  model_id           TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms         INTEGER NOT NULL DEFAULT 0,
  cost_usd_micros    INTEGER NOT NULL DEFAULT 0,
  cost_known         INTEGER NOT NULL DEFAULT 0,
  outcome            TEXT NOT NULL,
  error_code         TEXT,
  simulated          INTEGER NOT NULL DEFAULT 0,
  attempt_id         TEXT,
  attack_id          TEXT,
  seed               INTEGER
);
CREATE INDEX IF NOT EXISTS usage_events_trace ON usage_events (trace_id);
CREATE INDEX IF NOT EXISTS usage_events_attempt ON usage_events (attempt_id);
`;

/** Column order of the CSV export. Stable: new columns go at the end. */
export const USAGE_EVENTS_CSV_COLUMNS = [
  "id",
  "trace_id",
  "at",
  "stage",
  "provider",
  "model_id",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "latency_ms",
  "cost_usd_micros",
  "cost_known",
  "outcome",
  "error_code",
  "simulated",
  "attempt_id",
  "attack_id",
  "seed",
] as const;

export type UsageEventsCsvColumn = (typeof USAGE_EVENTS_CSV_COLUMNS)[number];
