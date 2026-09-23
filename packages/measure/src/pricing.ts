/**
 * Price table for usage_events.cost_usd_micros. Ported from agentpos-alexa
 * (packages/agents/src/pricing.ts). A price change is configuration, not code:
 * MODEL_PRICES_JSON holds either inline JSON or a path to a JSON file, in USD per 1M tokens:
 *   {"nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": {"inputPerMillionUsd": 0.06, "outputPerMillionUsd": 0.24}}
 *
 * USD per 1M tokens is numerically USD micros per token, so prices are converted once, at load,
 * to integer micros per 1M tokens, and every cost after that is integer arithmetic.
 */
import { readFileSync } from "node:fs";
import { MeasureError } from "./errors.js";

/** A price as written in configuration, USD per 1M tokens. */
export interface ModelPriceConfig {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  /** Defaults to the input rate: an unverified cache discount must not make a run look cheaper. */
  cacheReadPerMillionUsd?: number;
  /** Defaults to the input rate. */
  cacheWritePerMillionUsd?: number;
}

/** A price after loading: integer USD micros per 1M tokens. */
export interface ModelPrice {
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  cacheReadMicrosPerMillion: number;
  cacheWriteMicrosPerMillion: number;
}

export type PriceTable = Readonly<Record<string, ModelPrice>>;

/**
 * Built-in defaults. Secondhand and unverified (unverified, see README):
 * verify in the Token Factory console and record the date before the first measured run.
 */
export const DEFAULT_PRICES: Readonly<Record<string, ModelPriceConfig>> = {
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": { inputPerMillionUsd: 0.06, outputPerMillionUsd: 0.24 },
  "nvidia/nemotron-3-super-120b-a12b": { inputPerMillionUsd: 0.3, outputPerMillionUsd: 0.9 },
  "nvidia/Nemotron-3-Ultra-550b-a55b": { inputPerMillionUsd: 1, outputPerMillionUsd: 3 },
  // The recorded model of mock mode. It costs nothing and its rows say simulated.
  recorded: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
};

const MICROS_PER_USD = 1_000_000;

function toMicros(modelId: string, field: string, usd: unknown): number {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) {
    throw new MeasureError(
      "MEASURE_INVALID_PRICE_TABLE",
      `Price ${field} for ${modelId} must be a non-negative number of USD per 1M tokens.`,
      "Fix MODEL_PRICES_JSON; see the README of @agentpos/measure for the shape.",
    );
  }
  // Configuration conversion, done once. Rounds to the micro-dollar per 1M tokens.
  return Math.round(usd * MICROS_PER_USD);
}

function load(modelId: string, c: ModelPriceConfig): ModelPrice {
  const input = toMicros(modelId, "inputPerMillionUsd", c.inputPerMillionUsd);
  return {
    inputMicrosPerMillion: input,
    outputMicrosPerMillion: toMicros(modelId, "outputPerMillionUsd", c.outputPerMillionUsd),
    cacheReadMicrosPerMillion:
      c.cacheReadPerMillionUsd === undefined ? input : toMicros(modelId, "cacheReadPerMillionUsd", c.cacheReadPerMillionUsd),
    cacheWriteMicrosPerMillion:
      c.cacheWritePerMillionUsd === undefined ? input : toMicros(modelId, "cacheWritePerMillionUsd", c.cacheWritePerMillionUsd),
  };
}

function readOverride(raw: string): Record<string, ModelPriceConfig> {
  let text = raw.trim();
  if (!text.startsWith("{")) {
    try {
      text = readFileSync(text, "utf8");
    } catch {
      throw new MeasureError(
        "MEASURE_PRICE_FILE_UNREADABLE",
        `MODEL_PRICES_JSON is not inline JSON and the file ${text} could not be read.`,
        "Set MODEL_PRICES_JSON to inline JSON, a readable file path, or leave it empty for the defaults.",
      );
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    // Fails loud: a silently ignored override would publish numbers at the wrong price.
    throw new MeasureError(
      "MEASURE_INVALID_PRICE_TABLE",
      "MODEL_PRICES_JSON is not a JSON object of model id to price.",
      "Fix MODEL_PRICES_JSON; see the README of @agentpos/measure for the shape.",
    );
  }
  return parsed as Record<string, ModelPriceConfig>;
}

/**
 * The effective price table: built-in defaults, overridden per model by `override`
 * (inline JSON or a JSON file path; defaults to `process.env.MODEL_PRICES_JSON`).
 */
export function loadPriceTable(override: string | undefined = process.env.MODEL_PRICES_JSON): PriceTable {
  const merged: Record<string, ModelPriceConfig> = { ...DEFAULT_PRICES };
  if (override && override.trim() !== "") Object.assign(merged, readOverride(override));
  const table: Record<string, ModelPrice> = {};
  for (const [id, c] of Object.entries(merged)) table[id] = load(id, c);
  return table;
}

/** Token counts of one call, as the provider reported them. */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Integer USD micros of one call, rounded half up once over the whole call. An unknown model
 * costs 0 with `known: false`, so the caller can flag it rather than hide it.
 */
export function estimateCostUsdMicros(
  table: PriceTable,
  modelId: string,
  tokens: TokenCounts,
): { micros: number; known: boolean } {
  const p = table[modelId];
  if (!p) return { micros: 0, known: false };
  const microsTimesMillion =
    tokens.inputTokens * p.inputMicrosPerMillion +
    tokens.outputTokens * p.outputMicrosPerMillion +
    (tokens.cacheReadTokens ?? 0) * p.cacheReadMicrosPerMillion +
    (tokens.cacheWriteTokens ?? 0) * p.cacheWriteMicrosPerMillion;
  return { micros: Math.floor((microsTimesMillion + 500_000) / 1_000_000), known: true };
}
