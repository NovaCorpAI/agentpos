import { z } from "zod";
import { AgentGateError } from "./errors.js";

export const NETWORKS = ["testnet", "mainnet"] as const;
export type NetworkName = (typeof NETWORKS)[number];

/**
 * Built on Stellar public facilitator (OpenZeppelin Relayer).
 * Source: https://developers.stellar.org/docs/build/agentic-payments/x402/built-on-stellar
 * Verified 2026-08-25. Re-verify before changing (CLAUDE.md, Stack).
 */
export const FACILITATOR_URLS: Record<NetworkName, string> = {
  testnet: "https://channels.openzeppelin.com/x402/testnet",
  mainnet: "https://channels.openzeppelin.com/x402",
};

/** CAIP-2 identifiers used by x402 V2 on Stellar. */
export const CAIP2: Record<NetworkName, `stellar:${string}`> = {
  testnet: "stellar:testnet",
  mainnet: "stellar:pubnet",
};

/** Classic-asset issuers for USDC (Circle). Contract ids come from @x402/stellar. */
export const USDC_ISSUER: Record<NetworkName, string> = {
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  mainnet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

export const HORIZON_URLS: Record<NetworkName, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  mainnet: "https://horizon.stellar.org",
};

export const FRIENDBOT_URL = "https://friendbot.stellar.org";

const llmSchema = z.object({
  provider: z.enum(["anthropic", "openai-compatible"]).default("anthropic"),
  model: z.string().min(1).default("claude-opus-5"),
  apiKey: z.string().optional(),
  baseUrl: z.url().optional(),
});

export const coreConfigSchema = z.object({
  network: z.enum(NETWORKS).default("testnet"),
  /** Guardrail 2: mainnet requires explicit confirmation. */
  allowMainnet: z.boolean().default(false),
  facilitatorUrl: z.url().optional(),
  facilitatorApiKeys: z.array(z.string().min(1)).default([]),
  rpcUrl: z.url().optional(),
  llm: llmSchema.default({ provider: "anthropic", model: "claude-opus-5" }),
});

export type CoreConfigInput = z.input<typeof coreConfigSchema>;

export interface CoreConfig {
  network: NetworkName;
  caip2: `stellar:${string}`;
  facilitatorUrl: string;
  facilitatorApiKeys: string[];
  rpcUrl: string | undefined;
  horizonUrl: string;
  usdcIssuer: string;
  llm: z.output<typeof llmSchema>;
}

export function resolveConfig(input: CoreConfigInput = {}): CoreConfig {
  const parsed = coreConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new AgentGateError("CONFIG_INVALID", "Invalid AgentGate configuration", {
      hint: "Check the fields listed in details against packages/core/src/config.ts.",
      details: { issues: parsed.error.issues },
    });
  }
  const cfg = parsed.data;

  if (cfg.network === "mainnet" && !cfg.allowMainnet) {
    throw new AgentGateError("MAINNET_NOT_CONFIRMED", "Mainnet is locked until gate G2", {
      hint: "Set allowMainnet: true (AGENTGATE_ALLOW_MAINNET=true) only after the founder confirms gate G2 in plan/ROADMAP.md.",
    });
  }
  if (cfg.network === "mainnet" && !cfg.rpcUrl) {
    throw new AgentGateError("RPC_URL_REQUIRED", "Mainnet requires an explicit Soroban RPC URL", {
      hint: "Set rpcUrl (AGENTGATE_RPC_URL) to a mainnet RPC provider; the SDK ships no public mainnet default.",
    });
  }

  return {
    network: cfg.network,
    caip2: CAIP2[cfg.network],
    facilitatorUrl: cfg.facilitatorUrl ?? FACILITATOR_URLS[cfg.network],
    facilitatorApiKeys: cfg.facilitatorApiKeys,
    rpcUrl: cfg.rpcUrl,
    horizonUrl: HORIZON_URLS[cfg.network],
    usdcIssuer: USDC_ISSUER[cfg.network],
    llm: cfg.llm,
  };
}

function envBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return ["1", "true", "yes"].includes(value.toLowerCase());
}

/** Reads AGENTGATE_* variables. Pass `process.env` (or a test object). */
export function configFromEnv(env: Record<string, string | undefined>): CoreConfig {
  const apiKeys = env.AGENTGATE_FACILITATOR_API_KEY?.split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const input: CoreConfigInput = {};
  if (env.AGENTGATE_NETWORK) input.network = env.AGENTGATE_NETWORK as NetworkName;
  const allow = envBool(env.AGENTGATE_ALLOW_MAINNET);
  if (allow !== undefined) input.allowMainnet = allow;
  if (env.AGENTGATE_FACILITATOR_URL) input.facilitatorUrl = env.AGENTGATE_FACILITATOR_URL;
  if (apiKeys && apiKeys.length > 0) input.facilitatorApiKeys = apiKeys;
  if (env.AGENTGATE_RPC_URL) input.rpcUrl = env.AGENTGATE_RPC_URL;
  const llm: NonNullable<CoreConfigInput["llm"]> = {};
  if (env.AGENTGATE_LLM_PROVIDER) {
    llm.provider = env.AGENTGATE_LLM_PROVIDER as "anthropic" | "openai-compatible";
  }
  if (env.AGENTGATE_LLM_MODEL) llm.model = env.AGENTGATE_LLM_MODEL;
  const llmKey = env.AGENTGATE_LLM_API_KEY ?? env.ANTHROPIC_API_KEY;
  if (llmKey) llm.apiKey = llmKey;
  if (env.AGENTGATE_LLM_BASE_URL) llm.baseUrl = env.AGENTGATE_LLM_BASE_URL;
  if (Object.keys(llm).length > 0) input.llm = llm;
  return resolveConfig(input);
}
