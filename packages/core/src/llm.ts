/**
 * LLM router: direct HTTP to the provider API, no vendor SDK (CLAUDE.md, Stack).
 * Used by the scanner to redact catalog descriptions and extract structured drafts.
 */
import { AgentPOSError } from "./errors.js";
import type { CoreConfig } from "./config.js";

export interface LlmCompletionRequest {
  system?: string;
  prompt: string;
  /** When provided, the provider is asked for JSON matching this schema and the result is parsed. */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
}

export interface LlmCompletionResult {
  text: string;
  json?: unknown;
  provider: string;
  model: string;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(req: LlmCompletionRequest): Promise<LlmCompletionResult>;
}

type FetchLike = typeof globalThis.fetch;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidate = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")
    : trimmed;
  try {
    return JSON.parse(candidate);
  } catch (cause) {
    throw new AgentPOSError("LLM_INVALID_JSON", "LLM response is not valid JSON", {
      hint: "Retry with a stricter schema or lower effort; inspect details.text.",
      retryable: true,
      details: { text: text.slice(0, 500) },
      cause,
    });
  }
}

async function readJsonResponse(res: Response, provider: string): Promise<Record<string, unknown>> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new AgentPOSError("LLM_REQUEST_FAILED", `${provider} request failed (${res.status})`, {
      hint:
        res.status === 401 ? "Check the API key." : "Inspect details.body; 429/5xx are retryable.",
      retryable: res.status === 429 || res.status >= 500,
      details: { status: res.status, body },
    });
  }
  return body;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    private readonly baseUrl: string = ANTHROPIC_URL,
  ) {}

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? 16_000,
      messages: [{ role: "user", content: req.prompt }],
      output_config: {
        effort: req.effort ?? "medium",
        ...(req.jsonSchema ? { format: { type: "json_schema", schema: req.jsonSchema } } : {}),
      },
    };
    if (req.system) body.system = req.system;

    const res = await this.fetchImpl(this.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
    const data = await readJsonResponse(res, this.name);
    if (data.stop_reason === "refusal") {
      throw new AgentPOSError("LLM_REQUEST_FAILED", "Model refused the request", {
        hint: "The scanner prompt should only contain the merchant's own public content.",
        details: { stop_details: data.stop_details },
      });
    }
    const content = Array.isArray(data.content)
      ? (data.content as Array<Record<string, unknown>>)
      : [];
    const text = content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");
    return {
      text,
      ...(req.jsonSchema ? { json: extractJson(text) } : {}),
      provider: this.name,
      model: this.model,
    };
  }
}

/** OpenAI-compatible chat completions (OpenRouter, local servers, other vendors). */
export class OpenAICompatibleProvider implements LlmProvider {
  readonly name = "openai-compatible";
  constructor(
    readonly model: string,
    private readonly apiKey: string | undefined,
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
  ) {}

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const messages: Array<{ role: string; content: string }> = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.prompt });
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? 16_000,
      messages,
      ...(req.jsonSchema
        ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: "output", schema: req.jsonSchema },
            },
          }
        : {}),
    };
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await readJsonResponse(res, this.name);
    const choices = Array.isArray(data.choices)
      ? (data.choices as Array<Record<string, unknown>>)
      : [];
    const message = choices[0]?.message as Record<string, unknown> | undefined;
    const text = typeof message?.content === "string" ? message.content : "";
    return {
      text,
      ...(req.jsonSchema ? { json: extractJson(text) } : {}),
      provider: this.name,
      model: this.model,
    };
  }
}

export function createLlm(
  config: CoreConfig["llm"],
  fetchImpl: FetchLike = globalThis.fetch,
): LlmProvider {
  if (config.provider === "anthropic") {
    if (!config.apiKey) {
      throw new AgentPOSError("CONFIG_INVALID", "Anthropic provider requires an API key", {
        hint: "Set ANTHROPIC_API_KEY (or AGENTPOS_LLM_API_KEY).",
      });
    }
    return new AnthropicProvider(
      config.model,
      config.apiKey,
      fetchImpl,
      config.baseUrl ?? ANTHROPIC_URL,
    );
  }
  if (!config.baseUrl) {
    throw new AgentPOSError("CONFIG_INVALID", "openai-compatible provider requires baseUrl", {
      hint: "Set AGENTPOS_LLM_BASE_URL, e.g. https://openrouter.ai/api/v1.",
    });
  }
  return new OpenAICompatibleProvider(config.model, config.apiKey, config.baseUrl, fetchImpl);
}
