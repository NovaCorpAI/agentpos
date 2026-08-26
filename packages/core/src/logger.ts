/**
 * Structured logging (G1): one JSON line per event with a `traceId` that follows a purchase
 * across scan, cart, checkout, settle and order creation. Pretty mode for interactive CLIs.
 */
import { randomBytes } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Returns a logger that adds `fields` (e.g. traceId) to every line. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  format?: "json" | "pretty";
  level?: LogLevel;
  sink?: (line: string) => void;
  base?: LogFields;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function serialize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

export function newTraceId(): string {
  return randomBytes(8).toString("hex");
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const format = options.format ?? "json";
  const min = ORDER[options.level ?? "info"];
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const base = options.base ?? {};

  const emit = (
    level: LogLevel,
    event: string,
    fields: LogFields | undefined,
    extra: LogFields,
  ) => {
    if (ORDER[level] < min) return;
    const record = { ts: new Date().toISOString(), level, event, ...extra, ...(fields ?? {}) };
    if (format === "json") {
      sink(JSON.stringify(record, (_k, v) => serialize(v)));
    } else {
      const rest = Object.entries({ ...extra, ...(fields ?? {}) })
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(serialize(v))}`)
        .join(" ");
      sink(`${record.ts} ${level.toUpperCase().padEnd(5)} ${event}${rest ? ` ${rest}` : ""}`);
    }
  };

  const make = (extra: LogFields): Logger => ({
    debug: (e, f) => emit("debug", e, f, extra),
    info: (e, f) => emit("info", e, f, extra),
    warn: (e, f) => emit("warn", e, f, extra),
    error: (e, f) => emit("error", e, f, extra),
    child: (f) => make({ ...extra, ...f }),
  });
  return make(base);
}

/** A logger that records events in memory (tests). */
export function createMemoryLogger(): Logger & { records: Array<Record<string, unknown>> } {
  const records: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    format: "json",
    level: "debug",
    sink: (line) => records.push(JSON.parse(line) as Record<string, unknown>),
  });
  return Object.assign(logger, { records });
}

export const silentLogger: Logger = createLogger({ sink: () => {}, level: "error" });
