# @agentpos/measure

One `usage_events` row per model call: tokens as the provider reported them, latency, the model,
the integer cost in USD micros and the `traceId` of the run. Prices are configuration, not code.

Why it exists: AgentPOS sells assisted setup and a hosted buying agent, and until this package
there was no number behind either. A model call that nobody measured is a cost nobody can explain
later.

```ts
import {
  MemoryUsageEventsRepo,
  measured,
  loadPriceTable,
  usageEventsToCsv,
} from "@agentpos/measure";

const repo = new MemoryUsageEventsRepo(); // SqliteUsageEventsRepo(path) in production
const ctx = { repo, prices: loadPriceTable() };

const { value } = await measured(
  ctx,
  {
    traceId: "scan-7f3",
    stage: "extract",
    provider: "anthropic",
    modelId: "claude-opus-5",
    simulated: false,
  },
  async () => {
    const result = await callTheModel();
    return { value: result, usage: { inputTokens: 1_200, outputTokens: 340 } };
  },
);

console.log(usageEventsToCsv(repo.list()));
```

In this repository the wrapper you normally want is `measuredLlm` from `@agentpos/core`, which
applies the above to any `LlmProvider`.

## What it guarantees

- **A failed call is a row too.** `measured` writes `outcome: "error"` with the error's code and
  rethrows the error untouched. Failed attempts are real spend.
- **Integers end to end.** Prices are converted once, at load, to USD micros per million tokens;
  every cost after that is integer arithmetic, rounded half up once over the whole call. No
  floats touch money.
- **Unknown models are visible, not free.** A model missing from the price table costs 0 with
  `costKnown: false`, so it shows up as unknown instead of hiding as zero.
- **`simulated` is written, never inferred.** A row from a recorded fixture says so.
- **A malformed price table fails loudly.** Ignoring `MODEL_PRICES_JSON` would publish numbers at
  the wrong price, so a bad value throws `MEASURE_INVALID_PRICE_TABLE` instead.

## Prices

`MODEL_PRICES_JSON` holds inline JSON or a path to a JSON file, in USD per million tokens:

```json
{ "claude-opus-5": { "inputPerMillionUsd": 5, "outputPerMillionUsd": 25 } }
```

`cacheReadPerMillionUsd` and `cacheWritePerMillionUsd` are optional and default to the input
rate, so an unverified cache discount can never make a run look cheaper than it was.

The built-in defaults cover the Nemotron models used by the reasoning buyer and are **secondhand
and unverified**: check them against the provider's console and record the date before publishing
any figure that comes from them.

## Storage

Behind the storage adapter the repository already uses: `MemoryUsageEventsRepo` for tests,
`SqliteUsageEventsRepo` (`node:sqlite`, no native dependency) for runs. Opening the SQLite
adapter applies its own DDL, so there is no migration step.

`usageEventsToCsv` and `csvToUsageEvents` round-trip the table, so a committed CSV can rebuild
every figure a README or a grant report quotes.

## Shared with the sibling repositories

The same table exists in `agentpos-alexa` and `agentpos-doorstep`, and was written first for the
reasoning buyer (`agentpos-buyer`). This package is the single implementation the four consume,
so the four report the same numbers. Stages are a closed union: a new consumer adds its own to
`UsageStage` rather than passing a string.
