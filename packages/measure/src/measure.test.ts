import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MeasureError,
  MemoryUsageEventsRepo,
  SqliteUsageEventsRepo,
  USAGE_EVENTS_CSV_COLUMNS,
  USAGE_EVENTS_DDL,
  csvToUsageEvents,
  estimateCostUsdMicros,
  loadPriceTable,
  measured,
  summarizeByModel,
  usageEventsToCsv,
  type UsageEventsRepo,
} from "./index.js";

const NANO = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";

/** A clock that advances 250 ms per reading, so latency is deterministic. */
function fakeClock(): () => number {
  let t = 1000;
  return () => (t += 250) - 250;
}

const ctxFor = (repo: UsageEventsRepo) => ({
  repo,
  prices: loadPriceTable(""),
  clock: fakeClock(),
  now: () => "2026-09-23T12:00:00.000Z",
});

const labels = { traceId: "tr_1", stage: "plan" as const, provider: "nebius", modelId: NANO, simulated: false };

describe("usage_events schema", () => {
  it("declares every CSV column in the DDL", () => {
    for (const col of USAGE_EVENTS_CSV_COLUMNS) expect(USAGE_EVENTS_DDL).toContain("\n  " + col + " ");
  });

  it("stores tokens and cost as integers, never real", () => {
    expect(USAGE_EVENTS_DDL).not.toMatch(/REAL|FLOAT|DOUBLE|NUMERIC/);
    expect(USAGE_EVENTS_DDL).toMatch(/cost_usd_micros\s+INTEGER/);
  });
});

describe.each([
  ["memory", () => new MemoryUsageEventsRepo()],
  ["sqlite", () => new SqliteUsageEventsRepo(":memory:")],
])("measured, %s adapter", (_name, make) => {
  let repo: UsageEventsRepo;
  afterEach(() => repo.close());

  it("a fake model call lands exactly one row with tokens, latency, cost and traceId", async () => {
    repo = make();
    const { value, event } = await measured(ctxFor(repo), { ...labels, attemptId: "a1", attackId: "price_swap", seed: 7 }, async () => ({
      value: "plan ok",
      usage: { inputTokens: 20_000, outputTokens: 2_000 },
    }));
    expect(value).toBe("plan ok");
    const rows = repo.list();
    expect(rows).toEqual([event]);
    expect(rows[0]).toMatchObject({
      traceId: "tr_1",
      at: "2026-09-23T12:00:00.000Z",
      stage: "plan",
      modelId: NANO,
      inputTokens: 20_000,
      outputTokens: 2_000,
      latencyMs: 250,
      // 20k x 0.06 + 2k x 0.24 USD per 1M = 1200 + 480 micros.
      costUsdMicros: 1680,
      costKnown: true,
      outcome: "ok",
      simulated: false,
      attemptId: "a1",
      attackId: "price_swap",
      seed: 7,
    });
  });

  it("a failed call still lands a row, with its error code, and rethrows", async () => {
    repo = make();
    const boom = Object.assign(new Error("429"), { code: "PROVIDER_RATE_LIMITED" });
    await expect(measured(ctxFor(repo), labels, async () => Promise.reject(boom))).rejects.toBe(boom);
    expect(repo.list()).toEqual([
      expect.objectContaining({ outcome: "error", errorCode: "PROVIDER_RATE_LIMITED", inputTokens: 0, costUsdMicros: 0 }),
    ]);
  });

  it("an unpriced model is flagged, not silently free", async () => {
    repo = make();
    const { event } = await measured(ctxFor(repo), { ...labels, modelId: "nvidia/nemotron-3-nano-30b-a3b" }, async () => ({
      value: null,
      usage: { inputTokens: 10, outputTokens: 10 },
    }));
    expect(event).toMatchObject({ costUsdMicros: 0, costKnown: false });
  });

  it("filters by traceId and attemptId", async () => {
    repo = make();
    const ctx = ctxFor(repo);
    const ok = async () => ({ value: 1, usage: { inputTokens: 1, outputTokens: 1 } });
    await measured(ctx, { ...labels, traceId: "a", attemptId: "x" }, ok);
    await measured(ctx, { ...labels, traceId: "b", attemptId: "x", stage: "decide" }, ok);
    expect(repo.list({ traceId: "a" })).toHaveLength(1);
    expect(repo.list({ attemptId: "x" })).toHaveLength(2);
    expect(repo.list({ stage: "decide" }).map((e) => e.traceId)).toEqual(["b"]);
  });

  it("rejects a float or negative amount with a typed error", () => {
    repo = make();
    const bad = {
      ...labels,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      latencyMs: 1,
      costUsdMicros: 0.5,
      costKnown: true,
      outcome: "ok" as const,
    };
    expect(() => repo.record(bad)).toThrow(MeasureError);
    expect(() => repo.record({ ...bad, costUsdMicros: 1, inputTokens: -1 })).toThrow(/non-negative integer/);
  });
});

describe("price table", () => {
  it("prices in integer micros, rounded once per call", () => {
    const t = loadPriceTable("");
    // 1 token at 0.06 USD per 1M is 0.06 micros: rounds to 0. 9 tokens is 0.54: rounds to 1.
    expect(estimateCostUsdMicros(t, NANO, { inputTokens: 1, outputTokens: 0 }).micros).toBe(0);
    expect(estimateCostUsdMicros(t, NANO, { inputTokens: 9, outputTokens: 0 }).micros).toBe(1);
    const c = estimateCostUsdMicros(t, "nvidia/Nemotron-3-Ultra-550b-a55b", { inputTokens: 20_000, outputTokens: 2_000 });
    expect(c).toEqual({ micros: 26_000, known: true });
  });

  it("charges cached tokens at the input rate unless a cache price is configured", () => {
    const t = loadPriceTable('{"m": {"inputPerMillionUsd": 1, "outputPerMillionUsd": 2, "cacheReadPerMillionUsd": 0.1}}');
    expect(estimateCostUsdMicros(t, "m", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1000, cacheWriteTokens: 1000 }).micros).toBe(100 + 1000);
  });

  it("overrides per model from inline JSON or a file, keeping the other defaults", () => {
    const inline = loadPriceTable(`{"${NANO}": {"inputPerMillionUsd": 0.1, "outputPerMillionUsd": 0.4}}`);
    expect(inline[NANO]?.inputMicrosPerMillion).toBe(100_000);
    expect(inline["nvidia/nemotron-3-super-120b-a12b"]?.inputMicrosPerMillion).toBe(300_000);

    const dir = mkdtempSync(join(tmpdir(), "prices-"));
    try {
      const file = join(dir, "prices.json");
      writeFileSync(file, JSON.stringify({ other: { inputPerMillionUsd: 2, outputPerMillionUsd: 8 } }));
      expect(loadPriceTable(file)["other"]?.outputMicrosPerMillion).toBe(8_000_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails loud on a malformed override instead of publishing wrong prices", () => {
    expect(() => loadPriceTable("{not json")).toThrow(expect.objectContaining({ code: "MEASURE_INVALID_PRICE_TABLE" }));
    expect(() => loadPriceTable('{"m": {"inputPerMillionUsd": -1, "outputPerMillionUsd": 0}}')).toThrow(MeasureError);
    expect(() => loadPriceTable("./does/not/exist.json")).toThrow(expect.objectContaining({ code: "MEASURE_PRICE_FILE_UNREADABLE" }));
  });
});

describe("CSV export", () => {
  it("writes the documented columns and round-trips byte for byte, quotes and optionals kept", async () => {
    const repo = new SqliteUsageEventsRepo(":memory:");
    const ctx = ctxFor(repo);
    await measured(ctx, labels, async () => ({ value: 1, usage: { inputTokens: 812, outputTokens: 96, cacheReadTokens: 2318 } }));
    await measured(ctx, { ...labels, stage: "decide", attemptId: "a1", attackId: "prompt_injection", seed: 0 }, async () => ({
      value: 1,
      usage: { inputTokens: 5, outputTokens: 5 },
    }));
    await expect(measured(ctx, { ...labels, traceId: 'a,"b"\r\nc' }, async () => Promise.reject(new Error("x")))).rejects.toThrow();
    const events = repo.list();
    repo.close();

    const csv = usageEventsToCsv(events);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(USAGE_EVENTS_CSV_COLUMNS.join(","));
    expect(lines[1]).toContain(`,plan,nebius,${NANO},812,96,2318,0,250,`);
    expect(lines[2]).toMatch(/,ok,,0,a1,prompt_injection,0$/);
    expect(csv).toContain('"a,""b""\r\nc"');

    const back = csvToUsageEvents(csv);
    expect(back).toEqual(events);
    expect(usageEventsToCsv(back)).toBe(csv);
  });

  it("summarizes per model, failed and unpriced calls included and visible", () => {
    const base = csvToUsageEvents(
      [
        USAGE_EVENTS_CSV_COLUMNS.join(","),
        `1,t,2026-09-23T00:00:00Z,plan,nebius,${NANO},100,10,50,0,1,9,1,ok,,0,,,`,
        `2,t,2026-09-23T00:00:01Z,plan,nebius,${NANO},0,0,0,0,1,0,1,error,PROVIDER_TIMEOUT,0,,,`,
        `3,t,2026-09-23T00:00:02Z,plan,nebius,mystery,5,5,0,0,1,0,0,ok,,0,,,`,
      ].join("\r\n"),
    );
    expect(summarizeByModel(base)).toEqual({
      [NANO]: { calls: 2, failedCalls: 1, inputTokens: 150, outputTokens: 10, costUsdMicros: 9, unpricedCalls: 0 },
      mystery: { calls: 1, failedCalls: 0, inputTokens: 5, outputTokens: 5, costUsdMicros: 0, unpricedCalls: 1 },
    });
  });
});
