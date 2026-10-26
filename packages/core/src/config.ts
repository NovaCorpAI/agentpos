import { z } from "zod";
import { AgentPOSError } from "./errors.js";

export const NETWORKS = ["testnet", "mainnet"] as const;
export type NetworkName = (typeof NETWORKS)[number];

/**
 * Built on Stellar public facilitator (OpenZeppelin Relayer).
 * Source: https://developers.stellar.org/docs/build/agentic-payments/x402/built-on-stellar
 * Verified 2026-08-25. Re-verify before changing.
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
  /** Asset the checkout charges. XLM exists only so automated e2e can run without a USDC faucet. */
  checkoutAsset: z.enum(["USDC", "XLM"]).default("USDC"),
  facilitatorUrl: z.url().optional(),
  facilitatorApiKeys: z.array(z.string().min(1)).default([]),
  rpcUrl: z.url().optional(),
  llm: llmSchema.default({ provider: "anthropic", model: "claude-opus-5" }),
});

export type CoreConfigInput = z.input<typeof coreConfigSchema>;

export interface CoreConfig {
  network: NetworkName;
  /** The explicit mainnet flag (guardrail 2). Rails check it before adding a mainnet network. */
  allowMainnet: boolean;
  caip2: `stellar:${string}`;
  checkoutAsset: "USDC" | "XLM";
  facilitatorUrl: string;
  facilitatorApiKeys: string[];
  rpcUrl: string | undefined;
  horizonUrl: string;
  usdcIssuer: string;
  llm: z.output<typeof llmSchema>;
}

/**
 * Production gate G1 (docs/GATE-G1.md). Flipped to true in a dedicated commit only when
 * `pnpm gate:check` is 100% green and the founder confirmed. Until then mainnet cannot be
 * configured at all, whatever the env says (guardrail 2, enforced in code).
 *
 * 2026-08-26: gate G1 closed (10/10 green locally and in CI, run 33007207677) and mainnet
 * unlocked with the founder's explicit confirmation. Mainnet still requires
 * AGENTPOS_ALLOW_MAINNET=true, a mainnet facilitator key and an RPC URL per deployment.
 */
export const MAINNET_READY = true;

/**
 * Production gate per network (guardrail 2). A network joins this list only by a dedicated
 * commit after its own gate is green and the founder confirms in chat. Stellar closed G1 on
 * 2026-08-26; every other mainnet stays locked until its rail proves itself the same way.
 */
export const MAINNET_READY_NETWORKS: ReadonlySet<string> = new Set(["stellar:pubnet"]);

export interface ResolveOptions {
  /** Tests only: pretend the gate is closed. */
  mainnetReady?: boolean;
}

export function resolveConfig(
  input: CoreConfigInput = {},
  options: ResolveOptions = {},
): CoreConfig {
  const parsed = coreConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new AgentPOSError("CONFIG_INVALID", "Invalid AgentPOS configuration", {
      hint: "Check the fields listed in details against packages/core/src/config.ts.",
      details: { issues: parsed.error.issues },
    });
  }
  const cfg = parsed.data;

  const ready = options.mainnetReady ?? MAINNET_READY;
  if (cfg.network === "mainnet" && !ready) {
    throw new AgentPOSError(
      "MAINNET_NOT_CONFIRMED",
      "Mainnet is locked: production gate G1 is not closed in this release",
      {
        hint: "Run `pnpm gate:check`; when 100% green the founder flips MAINNET_READY in packages/core/src/config.ts (docs/GATE-G1.md).",
      },
    );
  }
  if (cfg.network === "mainnet" && !cfg.allowMainnet) {
    throw new AgentPOSError("MAINNET_NOT_CONFIRMED", "Mainnet requires an explicit flag", {
      hint: "Set allowMainnet: true (AGENTPOS_ALLOW_MAINNET=true) and a mainnet facilitator API key.",
    });
  }
  if (cfg.network === "mainnet" && !cfg.rpcUrl) {
    throw new AgentPOSError("RPC_URL_REQUIRED", "Mainnet requires an explicit Soroban RPC URL", {
      hint: "Set rpcUrl (AGENTPOS_RPC_URL) to a mainnet RPC provider; the SDK ships no public mainnet default.",
    });
  }

  if (cfg.network === "mainnet" && cfg.checkoutAsset !== "USDC") {
    throw new AgentPOSError("CONFIG_INVALID", "Mainnet checkout must use USDC", {
      hint: "checkoutAsset: 'XLM' is a testnet-only convenience for automated e2e.",
    });
  }

  return {
    network: cfg.network,
    allowMainnet: cfg.allowMainnet,
    caip2: CAIP2[cfg.network],
    checkoutAsset: cfg.checkoutAsset,
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

const STELLAR_SEED = /\bS[A-Z2-7]{55}\b/;
/**
 * An EVM private key as wallets export it: 0x + 64 hex. A transaction hash has the same shape,
 * but a merchant configuration never carries one, so any match is treated as a key.
 */
const EVM_PRIVATE_KEY = /\b0x[0-9a-fA-F]{64}\b/;

/**
 * Zero custody at startup (G1): a merchant configuration must never carry a Stellar secret
 * seed. Scans every string value of the given object recursively and throws on the first hit.
 */
export function assertNoSecretsInConfig(config: unknown, label = "configuration"): void {
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      if (EVM_PRIVATE_KEY.test(value)) {
        throw new AgentPOSError(
          "SECRET_IN_CONFIG",
          `Something that looks like an EVM private key was found in ${label} at ${path}`,
          {
            hint: "AgentPOS never stores merchant private keys. Put only the PUBLIC address (0x + 40 hex) in the config and keep the key in your wallet.",
            details: { path },
          },
        );
      }
      if (STELLAR_SEED.test(value)) {
        throw new AgentPOSError(
          "SECRET_IN_CONFIG",
          `A Stellar secret seed was found in ${label} at ${path}`,
          {
            hint: "AgentPOS never stores merchant private keys. Put only the PUBLIC address (G...) in the config and keep the seed in your wallet.",
            details: { path },
          },
        );
      }
      return;
    }
    if (Array.isArray(value)) value.forEach((v, i) => visit(v, `${path}[${i}]`));
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>))
        visit(v, path ? `${path}.${k}` : k);
    }
  };
  visit(config, "");
}

/** Reads AGENTPOS_* variables. Pass `process.env` (or a test object). */
export function configFromEnv(env: Record<string, string | undefined>): CoreConfig {
  const input: CoreConfigInput = {};
  if (env.AGENTPOS_NETWORK) input.network = env.AGENTPOS_NETWORK as NetworkName;
  // Facilitator keys are per network. Prefer the network-specific variable, fall back to the generic one.
  const network = (env.AGENTPOS_NETWORK as NetworkName | undefined) ?? "testnet";
  const keySource =
    (network === "mainnet"
      ? env.AGENTPOS_FACILITATOR_API_KEY_MAINNET
      : env.AGENTPOS_FACILITATOR_API_KEY_TESTNET) ?? env.AGENTPOS_FACILITATOR_API_KEY;
  const apiKeys = keySource
    ?.split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const allow = envBool(env.AGENTPOS_ALLOW_MAINNET);
  if (allow !== undefined) input.allowMainnet = allow;
  if (env.AGENTPOS_CHECKOUT_ASSET)
    input.checkoutAsset = env.AGENTPOS_CHECKOUT_ASSET as "USDC" | "XLM";
  if (env.AGENTPOS_FACILITATOR_URL) input.facilitatorUrl = env.AGENTPOS_FACILITATOR_URL;
  if (apiKeys && apiKeys.length > 0) input.facilitatorApiKeys = apiKeys;
  if (env.AGENTPOS_RPC_URL) input.rpcUrl = env.AGENTPOS_RPC_URL;
  const llm: NonNullable<CoreConfigInput["llm"]> = {};
  if (env.AGENTPOS_LLM_PROVIDER) {
    llm.provider = env.AGENTPOS_LLM_PROVIDER as "anthropic" | "openai-compatible";
  }
  if (env.AGENTPOS_LLM_MODEL) llm.model = env.AGENTPOS_LLM_MODEL;
  const llmKey = env.AGENTPOS_LLM_API_KEY ?? env.ANTHROPIC_API_KEY;
  if (llmKey) llm.apiKey = llmKey;
  if (env.AGENTPOS_LLM_BASE_URL) llm.baseUrl = env.AGENTPOS_LLM_BASE_URL;
  if (Object.keys(llm).length > 0) input.llm = llm;
  return resolveConfig(input);
}
