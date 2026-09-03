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
