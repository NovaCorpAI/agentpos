/**
 * Storage adapter for usage_events: node:sqlite for runs, memory for tests. Opening the SQLite
 * adapter applies the DDL, so a judge needs no migration step and no service to create.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MeasureError } from "./errors.js";
import { USAGE_EVENTS_DDL, type UsageEvent, type UsageOutcome, type UsageStage } from "./usage-events.js";

/** An event before the writer assigns `id` and `at`. */
export type NewUsageEvent = Omit<UsageEvent, "id" | "at"> & { id?: string; at?: string };

export interface UsageEventsFilter {
  traceId?: string;
  attemptId?: string;
  stage?: UsageStage;
}

export interface UsageEventsRepo {
  record(event: NewUsageEvent): UsageEvent;
  /** Oldest first, in insertion order. */
  list(filter?: UsageEventsFilter): UsageEvent[];
  close(): void;
}

const INTEGER_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "latencyMs",
  "costUsdMicros",
] as const;

function complete(event: NewUsageEvent): UsageEvent {
  const full: UsageEvent = { ...event, id: event.id ?? randomUUID(), at: event.at ?? new Date().toISOString() };
  for (const k of INTEGER_FIELDS) {
    const v = full[k];
    if (!Number.isInteger(v) || v < 0) {
      throw new MeasureError(
        "MEASURE_INVALID_EVENT",
        `usage_events.${k} must be a non-negative integer, got ${String(v)}.`,
        "Tokens, latency and cost are integers. Cost is USD micros, never a float.",
      );
    }
  }
  if (full.traceId === "") {
    throw new MeasureError("MEASURE_INVALID_EVENT", "usage_events.traceId is empty.", "Every model call carries the traceId of its run.");
  }
  return full;
}

function matches(e: UsageEvent, f: UsageEventsFilter): boolean {
  return (
    (f.traceId === undefined || e.traceId === f.traceId) &&
    (f.attemptId === undefined || e.attemptId === f.attemptId) &&
    (f.stage === undefined || e.stage === f.stage)
  );
}

/** In-memory adapter, for tests and mock mode. */
export class MemoryUsageEventsRepo implements UsageEventsRepo {
  private readonly events: UsageEvent[] = [];

  record(event: NewUsageEvent): UsageEvent {
    const full = complete(event);
    this.events.push(full);
    return { ...full };
  }

  list(filter: UsageEventsFilter = {}): UsageEvent[] {
    return this.events.filter((e) => matches(e, filter)).map((e) => ({ ...e }));
  }

  close(): void {}
}

interface Row {
  id: string;
  trace_id: string;
  at: string;
  stage: string;
  provider: string;
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  latency_ms: number;
  cost_usd_micros: number;
  cost_known: number;
  outcome: string;
  error_code: string | null;
  simulated: number;
  attempt_id: string | null;
  attack_id: string | null;
  seed: number | null;
}

function rowToEvent(r: Row): UsageEvent {
  const e: UsageEvent = {
    id: r.id,
    traceId: r.trace_id,
    at: r.at,
    stage: r.stage as UsageStage,
    provider: r.provider,
    modelId: r.model_id,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    latencyMs: r.latency_ms,
    costUsdMicros: r.cost_usd_micros,
    costKnown: r.cost_known === 1,
    outcome: r.outcome as UsageOutcome,
    simulated: r.simulated === 1,
  };
  if (r.error_code !== null) e.errorCode = r.error_code;
  if (r.attempt_id !== null) e.attemptId = r.attempt_id;
  if (r.attack_id !== null) e.attackId = r.attack_id;
  if (r.seed !== null) e.seed = r.seed;
  return e;
}

/** node:sqlite adapter. `path` is a file, or `:memory:`. */
export class SqliteUsageEventsRepo implements UsageEventsRepo {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(USAGE_EVENTS_DDL);
  }

  record(event: NewUsageEvent): UsageEvent {
    const e = complete(event);
    this.db
      .prepare(
        `INSERT INTO usage_events (id, trace_id, at, stage, provider, model_id, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, latency_ms, cost_usd_micros, cost_known, outcome, error_code,
           simulated, attempt_id, attack_id, seed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id,
        e.traceId,
        e.at,
        e.stage,
        e.provider,
        e.modelId,
        e.inputTokens,
        e.outputTokens,
        e.cacheReadTokens,
        e.cacheWriteTokens,
        e.latencyMs,
        e.costUsdMicros,
        e.costKnown ? 1 : 0,
        e.outcome,
        e.errorCode ?? null,
        e.simulated ? 1 : 0,
        e.attemptId ?? null,
        e.attackId ?? null,
        e.seed ?? null,
      );
    return e;
  }

  list(filter: UsageEventsFilter = {}): UsageEvent[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.traceId !== undefined) {
      where.push("trace_id = ?");
      params.push(filter.traceId);
    }
    if (filter.attemptId !== undefined) {
      where.push("attempt_id = ?");
      params.push(filter.attemptId);
    }
    if (filter.stage !== undefined) {
      where.push("stage = ?");
      params.push(filter.stage);
    }
    const sql = `SELECT * FROM usage_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid`;
    return (this.db.prepare(sql).all(...params) as unknown as Row[]).map(rowToEvent);
  }

  close(): void {
    this.db.close();
  }
}
