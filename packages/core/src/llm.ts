/**
 * LLM router: direct HTTP to the provider API, no vendor SDK.
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

/**
 * Tokens as the provider reported them, never estimated. Zero when the provider does not report
 * a field: a guess here becomes a wrong number in a price table later.
 */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmCompletionResult {
  text: string;
  json?: unknown;
  provider: string;
  model: string;
  /** What the call cost in tokens. Feed it to `@agentpos/measure` to turn it into money. */
  usage: LlmUsage;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(req: LlmCompletionRequest): Promise<LlmCompletionResult>;
}

type FetchLike = typeof globalThis.fetch;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Removes the reasoning of a reasoning model. Nemotron, DeepSeek R1 and friends wrap their
 * thinking in `<think>...</think>`; parsing with it still in place fails every time, and an
 * unclosed block at the end of a truncated response has to go too.
 */
function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
}

/**
 * The last top-level JSON object of a response, or null. A reasoning model writes example JSON
 * while it thinks, so the first object in the text is usually a draft and the last one is the
 * answer. Quoted braces are ignored so a `{` inside a string does not shift the span.
 */
function lastJsonSpan(text: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let last: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) last = text.slice(start, i + 1);
      if (depth < 0) depth = 0;
    }
  }
  return last;
}

function extractJson(text: string): unknown {
  const trimmed = stripReasoning(text);
  const candidate = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")
    : trimmed;
  let cause: unknown;
  try {
    return JSON.parse(candidate);
  } catch (err) {
    cause = err;
  }
  // A reasoning model surrounds its answer with prose: the last complete object is the answer.
  const span = lastJsonSpan(candidate);
  if (span !== null && span !== candidate) {
    try {
      return JSON.parse(span);
    } catch {
      // keep the first failure as the cause: it describes the whole response, not a fragment
    }
  }
  throw new AgentPOSError("LLM_INVALID_JSON", "LLM response is not valid JSON", {
    hint: "Retry with a stricter schema or lower effort; inspect details.text.",
    retryable: true,
    details: { text: text.slice(0, 500) },
    cause,
  });
}

/** Zero usage, for a provider that reported none. Never a guess. */
const NO_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0;
}

/** Reads the `usage` block of either provider shape, tolerating its absence. */
function readUsage(data: Record<string, unknown>): LlmUsage {
  const usage = data.usage as Record<string, unknown> | undefined;
  if (!usage) return { ...NO_USAGE };
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  return {
    // Anthropic names them input/output; OpenAI-compatible, prompt/completion.
    inputTokens: count(usage.input_tokens ?? usage.prompt_tokens),
    outputTokens: count(usage.output_tokens ?? usage.completion_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens ?? details?.cached_tokens),
    cacheWriteTokens: count(usage.cache_creation_input_tokens),
  };
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
      usage: readUsage(data),
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
      usage: readUsage(data),
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
