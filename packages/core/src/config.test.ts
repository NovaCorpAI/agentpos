import { describe, expect, it } from "vitest";
import { FACILITATOR_URLS, configFromEnv, resolveConfig } from "./config.js";
import { AgentGateError } from "./errors.js";

describe("config", () => {
  it("defaults to testnet with the Built on Stellar facilitator", () => {
    const cfg = resolveConfig();
    expect(cfg.network).toBe("testnet");
    expect(cfg.caip2).toBe("stellar:testnet");
    expect(cfg.facilitatorUrl).toBe(FACILITATOR_URLS.testnet);
    expect(cfg.llm.model).toBe("claude-opus-5");
  });

  it("locks mainnet behind explicit confirmation (guardrail 2)", () => {
    expect(() => resolveConfig({ network: "mainnet" })).toThrowError(AgentGateError);
    try {
      resolveConfig({ network: "mainnet" });
    } catch (err) {
      expect((err as AgentGateError).code).toBe("MAINNET_NOT_CONFIRMED");
    }
  });

  it("requires an RPC URL on mainnet even when confirmed", () => {
    try {
      resolveConfig({ network: "mainnet", allowMainnet: true });
      expect.unreachable();
    } catch (err) {
      expect((err as AgentGateError).code).toBe("RPC_URL_REQUIRED");
    }
    const cfg = resolveConfig({
      network: "mainnet",
      allowMainnet: true,
      rpcUrl: "https://rpc.example.com",
    });
    expect(cfg.caip2).toBe("stellar:pubnet");
    expect(cfg.facilitatorUrl).toBe(FACILITATOR_URLS.mainnet);
  });

  it("reads AGENTGATE_* env vars", () => {
    const cfg = configFromEnv({
      AGENTGATE_NETWORK: "testnet",
      AGENTGATE_FACILITATOR_API_KEY: "k1, k2",
      AGENTGATE_LLM_PROVIDER: "openai-compatible",
      AGENTGATE_LLM_MODEL: "some/model",
      AGENTGATE_LLM_BASE_URL: "https://openrouter.ai/api/v1",
      AGENTGATE_LLM_API_KEY: "x",
    });
    expect(cfg.facilitatorApiKeys).toEqual(["k1", "k2"]);
    expect(cfg.llm.provider).toBe("openai-compatible");
    expect(cfg.llm.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("rejects invalid values with CONFIG_INVALID", () => {
    try {
      resolveConfig({ facilitatorUrl: "not a url" });
      expect.unreachable();
    } catch (err) {
      expect((err as AgentGateError).code).toBe("CONFIG_INVALID");
    }
  });
});
