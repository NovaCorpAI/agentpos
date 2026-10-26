import { describe, expect, it } from "vitest";
import { MemoryUsageEventsRepo, loadPriceTable } from "@agentpos/measure";
import { measuredLlm } from "./measured-llm.js";
import type { LlmCompletionResult, LlmProvider } from "./llm.js";

function stubProvider(result: Partial<LlmCompletionResult>, fail?: Error): LlmProvider {
  return {
    name: "openai-compatible",
    model: "nvidia/nemotron",
    async complete(): Promise<LlmCompletionResult> {
      if (fail) throw fail;
      return {
        text: "ok",
        provider: "openai-compatible",
        model: "nvidia/nemotron",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        ...result,
      };
    },
  };
}

const prices = loadPriceTable(
  JSON.stringify({ "nvidia/nemotron": { inputPerMillionUsd: 0.06, outputPerMillionUsd: 0.24 } }),
);

describe("measuredLlm", () => {
  it("writes one row per call, with the tokens the provider reported and integer cost", async () => {
    const repo = new MemoryUsageEventsRepo();
    const llm = measuredLlm(
      stubProvider({
        usage: {
          inputTokens: 1_000_000,
          outputTokens: 1_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      }),
      { repo, prices },
      { traceId: "trace-1", stage: "extract" },
    );

    const res = await llm.complete({ prompt: "describe this catalog" });

    expect(res.text).toBe("ok");
    const [row, ...rest] = repo.list();
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      traceId: "trace-1",
      stage: "extract",
      provider: "openai-compatible",
      modelId: "nvidia/nemotron",
      inputTokens: 1_000_000,
      outputTokens: 1_000,
      outcome: "ok",
      costKnown: true,
      simulated: false,
    });
    // 1M input at US$0.06 plus 1k output at US$0.24 per million: 60_000 + 240 micros.
    expect(row?.costUsdMicros).toBe(60_240);
    expect(Number.isInteger(row?.costUsdMicros)).toBe(true);
  });

  it("records the failed call too, and rethrows it unchanged", async () => {
    const repo = new MemoryUsageEventsRepo();
    const boom = Object.assign(new Error("upstream down"), { code: "LLM_REQUEST_FAILED" });
    const llm = measuredLlm(
      stubProvider({}, boom),
      { repo, prices },
      {
        traceId: "trace-2",
        stage: "redact",
      },
    );

    await expect(llm.complete({ prompt: "x" })).rejects.toBe(boom);

    expect(repo.list()).toMatchObject([
      { traceId: "trace-2", stage: "redact", outcome: "error", errorCode: "LLM_REQUEST_FAILED" },
    ]);
  });

  it("keeps the provider identity and does not change its behaviour", async () => {
    const repo = new MemoryUsageEventsRepo();
    const inner = stubProvider({ text: "untouched" });
    const llm = measuredLlm(inner, { repo, prices }, { traceId: "t", stage: "extract" });
    expect(llm.name).toBe(inner.name);
    expect(llm.model).toBe(inner.model);
    expect((await llm.complete({ prompt: "x" })).text).toBe("untouched");
  });
});
