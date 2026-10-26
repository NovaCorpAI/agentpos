import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider, OpenAICompatibleProvider, createLlm } from "./llm.js";
import { AgentPOSError } from "./errors.js";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("llm router", () => {
  it("calls the Anthropic Messages API over plain HTTP and parses JSON output", async () => {
    const fetchImpl = fakeFetch(200, {
      content: [{ type: "text", text: '{"items":[1]}' }],
      stop_reason: "end_turn",
    });
    const llm = new AnthropicProvider("claude-opus-5", "key", fetchImpl);
    const res = await llm.complete({ prompt: "hi", jsonSchema: { type: "object" } });
    expect(res.json).toEqual({ items: [1] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe("claude-opus-5");
    expect(body.output_config).toMatchObject({ effort: "medium", format: { type: "json_schema" } });
  });

  it("surfaces HTTP failures as retryable typed errors", async () => {
    const llm = new AnthropicProvider("claude-opus-5", "key", fakeFetch(429, { error: "rate" }));
    try {
      await llm.complete({ prompt: "hi" });
      expect.unreachable();
    } catch (err) {
      expect((err as AgentPOSError).code).toBe("LLM_REQUEST_FAILED");
      expect((err as AgentPOSError).retryable).toBe(true);
    }
  });

  it("supports openai-compatible providers and strips code fences", async () => {
    const fetchImpl = fakeFetch(200, {
      choices: [{ message: { content: '```json\n{"a":1}\n```' } }],
    });
    const llm = new OpenAICompatibleProvider("m", undefined, "https://llm.local/v1/", fetchImpl);
    const res = await llm.complete({ prompt: "x", jsonSchema: { type: "object" } });
    expect(res.json).toEqual({ a: 1 });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://llm.local/v1/chat/completions",
    );
  });

  it("validates provider configuration", () => {
    expect(() => createLlm({ provider: "anthropic", model: "claude-opus-5" })).toThrowError(
      AgentPOSError,
    );
    expect(() => createLlm({ provider: "openai-compatible", model: "m" })).toThrowError(
      AgentPOSError,
    );
  });
});

describe("reasoning models", () => {
  it("drops <think> blocks and keeps the last JSON object, not the draft one", async () => {
    const answer = [
      "<think>",
      'Maybe the shape is {"items":[]} ... no, it needs the price.',
      "</think>",
      'Here is the result: {"items":[{"id":"mug","price":"9.90"}]}',
    ].join("\n");
    const llm = new OpenAICompatibleProvider(
      "nvidia/nemotron",
      undefined,
      "https://llm.local/v1",
      fakeFetch(200, { choices: [{ message: { content: answer } }] }),
    );
    const res = await llm.complete({ prompt: "x", jsonSchema: { type: "object" } });
    expect(res.json).toEqual({ items: [{ id: "mug", price: "9.90" }] });
  });

  it("survives a truncated response that never closes its <think> block", async () => {
    const llm = new OpenAICompatibleProvider(
      "nvidia/nemotron",
      undefined,
      "https://llm.local/v1",
      fakeFetch(200, {
        choices: [{ message: { content: '{"a":1}\n<think>and then I would check' } }],
      }),
    );
    const res = await llm.complete({ prompt: "x", jsonSchema: { type: "object" } });
    expect(res.json).toEqual({ a: 1 });
  });

  it("does not split an object on a brace inside a string", async () => {
    const llm = new OpenAICompatibleProvider(
      "m",
      undefined,
      "https://llm.local/v1",
      fakeFetch(200, { choices: [{ message: { content: 'note: {"name":"a { b","ok":true}' } }] }),
    );
    const res = await llm.complete({ prompt: "x", jsonSchema: { type: "object" } });
    expect(res.json).toEqual({ name: "a { b", ok: true });
  });

  it("still fails loudly when there is no JSON at all", async () => {
    const llm = new OpenAICompatibleProvider(
      "m",
      undefined,
      "https://llm.local/v1",
      fakeFetch(200, { choices: [{ message: { content: "<think>only prose</think> sorry" } }] }),
    );
    await expect(
      llm.complete({ prompt: "x", jsonSchema: { type: "object" } }),
    ).rejects.toMatchObject({ code: "LLM_INVALID_JSON" });
  });
});

describe("usage reporting", () => {
  it("reads Anthropic token counts, including the cache ones", async () => {
    const llm = new AnthropicProvider(
      "claude-opus-5",
      "key",
      fakeFetch(200, {
        content: [{ type: "text", text: "ok" }],
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          cache_read_input_tokens: 400,
          cache_creation_input_tokens: 10,
        },
      }),
    );
    const res = await llm.complete({ prompt: "hi" });
    expect(res.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 400,
      cacheWriteTokens: 10,
    });
  });

  it("reads the openai-compatible names and never invents a number", async () => {
    const withUsage = new OpenAICompatibleProvider(
      "m",
      undefined,
      "https://llm.local/v1",
      fakeFetch(200, {
        choices: [{ message: { content: "ok" } }],
        usage: {
          prompt_tokens: 7,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 5 },
        },
      }),
    );
    expect((await withUsage.complete({ prompt: "x" })).usage).toEqual({
      inputTokens: 7,
      outputTokens: 2,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
    });

    const silent = new OpenAICompatibleProvider(
      "m",
      undefined,
      "https://llm.local/v1",
      fakeFetch(200, { choices: [{ message: { content: "ok" } }] }),
    );
    expect((await silent.complete({ prompt: "x" })).usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});
