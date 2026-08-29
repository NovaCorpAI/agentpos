/**
 * Configuration for a self-hosted x402 facilitator.
 *
 * Everything comes from the environment, and the signing secret comes from the environment ONLY.
 * A facilitator's key pays fees and submits other people's transactions; a config file that could
 * be committed is exactly the wrong place for it.
 */
import { z } from "zod";
import { AgentGateError } from "@agentgate/core";

export const NETWORKS = ["testnet", "mainnet"] as const;
export type NetworkName = (typeof NETWORKS)[number];

export const CAIP2: Record<NetworkName, `stellar:${string}`> = {
  testnet: "stellar:testnet",
  mainnet: "stellar:pubnet",
};

export const HORIZON_URLS: Record<NetworkName, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  mainnet: "https://horizon.stellar.org",
};

const stellarSecret = z.string().regex(/^S[A-Z2-7]{55}$/, "must be a Stellar secret seed (S...)");
const contractId = z.string().regex(/^C[A-Z2-7]{55}$/, "must be a Stellar contract id (C...)");

export interface FacilitatorConfig {
  network: NetworkName;
  caip2: `stellar:${string}`;
  /** Ed25519 secret that signs and pays fees. Never leaves this process. */
  signerSecret: string;
  /** Soroban RPC. Required on mainnet: there is no sensible public default to assume. */
  rpcUrl: string | undefined;
  horizonUrl: string;
  /**
   * Assets this facilitator will settle, as contract ids. Empty means "any", which is almost
   * never what an operator wants: it lets a caller spend our fees on arbitrary tokens.
   */
  allowedAssets: string[];
  /** Bearer tokens accepted on /verify, /settle and /supported. At least one is required. */
  apiKeys: string[];
  /** Safety ceiling per transaction; verify refuses above it. */
  maxFeeStroops: number;
  port: number;
  /** Warn on /health when the fee account drops below this, in stroops. */
  minBalanceStroops: number;
}

const schema = z.object({
  network: z.enum(NETWORKS).default("testnet"),
  signerSecret: stellarSecret,
  rpcUrl: z.url().optional(),
  allowedAssets: z.array(contractId).default([]),
  apiKeys: z.array(z.string().min(16, "API keys must be at least 16 characters")).min(1),
  maxFeeStroops: z.number().int().positive().max(10_000_000).default(50_000),
  port: z.number().int().min(1).max(65_535).default(8403),
  minBalanceStroops: z.number().int().nonnegative().default(50_000_000), // 5 XLM
});

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export function configFromEnv(
  env: Record<string, string | undefined> = process.env,
): FacilitatorConfig {
  const parsed = schema.safeParse({
    network: env.AGENTGATE_FACILITATOR_NETWORK ?? "testnet",
    signerSecret: env.AGENTGATE_FACILITATOR_SIGNER_SECRET ?? "",
    ...(env.AGENTGATE_FACILITATOR_RPC_URL ? { rpcUrl: env.AGENTGATE_FACILITATOR_RPC_URL } : {}),
    allowedAssets: list(env.AGENTGATE_FACILITATOR_ASSETS),
    apiKeys: list(env.AGENTGATE_FACILITATOR_KEYS),
    ...(env.AGENTGATE_FACILITATOR_MAX_FEE_STROOPS
      ? { maxFeeStroops: Number(env.AGENTGATE_FACILITATOR_MAX_FEE_STROOPS) }
      : {}),
    ...(env.PORT ? { port: Number(env.PORT) } : {}),
    ...(env.AGENTGATE_FACILITATOR_MIN_BALANCE_STROOPS
      ? { minBalanceStroops: Number(env.AGENTGATE_FACILITATOR_MIN_BALANCE_STROOPS) }
      : {}),
  });

  if (!parsed.success) {
    throw new AgentGateError("CONFIG_INVALID", "Invalid facilitator configuration", {
      hint: "Set AGENTGATE_FACILITATOR_SIGNER_SECRET and AGENTGATE_FACILITATOR_KEYS. See apps/facilitator/README.md.",
      details: { issues: parsed.error.issues },
    });
  }
  const cfg = parsed.data;

  // Mainnet refuses to guess. A public RPC that rate-limits or lags is a bad thing to discover
  // while someone's money is in flight.
  if (cfg.network === "mainnet" && !cfg.rpcUrl) {
    throw new AgentGateError("RPC_URL_REQUIRED", "Mainnet requires an explicit Soroban RPC URL", {
      hint: "Set AGENTGATE_FACILITATOR_RPC_URL to an RPC you trust and pay for.",
    });
  }
  if (cfg.allowedAssets.length === 0) {
    throw new AgentGateError("CONFIG_INVALID", "Refusing to start with no asset allowlist", {
      hint: "Set AGENTGATE_FACILITATOR_ASSETS to the contract ids you will settle (comma separated). An empty allowlist lets a caller spend your fees on any token.",
    });
  }

  return {
    ...cfg,
    caip2: CAIP2[cfg.network],
    rpcUrl: cfg.rpcUrl,
    horizonUrl: HORIZON_URLS[cfg.network],
  };
}
