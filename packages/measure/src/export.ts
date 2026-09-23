/**
 * CSV export of usage_events, in the order of USAGE_EVENTS_CSV_COLUMNS, and the reader that
 * turns a committed CSV back into events so every README figure rebuilds from data/raw/.
 */
import {
  USAGE_EVENTS_CSV_COLUMNS,
  type UsageEvent,
  type UsageEventsCsvColumn,
  type UsageOutcome,
  type UsageStage,
} from "./usage-events.js";

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "boolean" ? (v ? "1" : "0") : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const FIELD_BY_COLUMN: Record<UsageEventsCsvColumn, (e: UsageEvent) => unknown> = {
  id: (e) => e.id,
  trace_id: (e) => e.traceId,
  at: (e) => e.at,
  stage: (e) => e.stage,
  provider: (e) => e.provider,
  model_id: (e) => e.modelId,
  input_tokens: (e) => e.inputTokens,
  output_tokens: (e) => e.outputTokens,
  cache_read_tokens: (e) => e.cacheReadTokens,
  cache_write_tokens: (e) => e.cacheWriteTokens,
  latency_ms: (e) => e.latencyMs,
  cost_usd_micros: (e) => e.costUsdMicros,
  cost_known: (e) => e.costKnown,
  outcome: (e) => e.outcome,
  error_code: (e) => e.errorCode,
  simulated: (e) => e.simulated,
  attempt_id: (e) => e.attemptId,
  attack_id: (e) => e.attackId,
  seed: (e) => e.seed,
};

/** CRLF, header first, trailing newline. */
export function usageEventsToCsv(events: readonly UsageEvent[]): string {
  const header = USAGE_EVENTS_CSV_COLUMNS.join(",");
  const rows = events.map((e) => USAGE_EVENTS_CSV_COLUMNS.map((c) => cell(FIELD_BY_COLUMN[c](e))).join(","));
  return [header, ...rows].join("\r\n") + "\r\n";
}

/** Reads a CSV written by `usageEventsToCsv`. Columns are found by header name, not position. */
export function csvToUsageEvents(csv: string): UsageEvent[] {
  const rows = parseCsv(csv);
  const header = rows.shift() ?? [];
  return rows
    .filter((r) => r.length > 1 || (r[0] ?? "") !== "")
    .map((r) => {
      const get = (col: UsageEventsCsvColumn) => r[header.indexOf(col)] ?? "";
      const int = (col: UsageEventsCsvColumn) => Number.parseInt(get(col) || "0", 10);
      const e: UsageEvent = {
        id: get("id"),
        traceId: get("trace_id"),
        at: get("at"),
        stage: get("stage") as UsageStage,
        provider: get("provider"),
        modelId: get("model_id"),
        inputTokens: int("input_tokens"),
        outputTokens: int("output_tokens"),
        cacheReadTokens: int("cache_read_tokens"),
        cacheWriteTokens: int("cache_write_tokens"),
        latencyMs: int("latency_ms"),
        costUsdMicros: int("cost_usd_micros"),
        costKnown: get("cost_known") === "1",
        outcome: get("outcome") as UsageOutcome,
        simulated: get("simulated") === "1",
      };
      if (get("error_code") !== "") e.errorCode = get("error_code");
      if (get("attempt_id") !== "") e.attemptId = get("attempt_id");
      if (get("attack_id") !== "") e.attackId = get("attack_id");
      if (get("seed") !== "") e.seed = int("seed");
      return e;
    });
}

/** RFC 4180 reader: quoted cells, doubled quotes, CRLF or LF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cellText = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cellText += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cellText += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cellText);
      cellText = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cellText);
      rows.push(row);
      row = [];
      cellText = "";
    } else cellText += ch;
  }
  if (cellText !== "" || row.length) {
    row.push(cellText);
    rows.push(row);
  }
  return rows;
}

export interface UsageTotals {
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsdMicros: number;
  /** Calls whose model had no price. Their cost is missing from `costUsdMicros`, not zero. */
  unpricedCalls: number;
}

/** Totals per model id, failed calls included (they are part of real spend). */
export function summarizeByModel(events: readonly UsageEvent[]): Record<string, UsageTotals> {
  const out: Record<string, UsageTotals> = {};
  for (const e of events) {
    const t = (out[e.modelId] ??= { calls: 0, failedCalls: 0, inputTokens: 0, outputTokens: 0, costUsdMicros: 0, unpricedCalls: 0 });
    t.calls += 1;
    if (e.outcome === "error") t.failedCalls += 1;
    if (!e.costKnown) t.unpricedCalls += 1;
    t.inputTokens += e.inputTokens + e.cacheReadTokens + e.cacheWriteTokens;
    t.outputTokens += e.outputTokens;
    t.costUsdMicros += e.costUsdMicros;
  }
  return out;
}
