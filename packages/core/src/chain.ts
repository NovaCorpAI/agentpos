/**
 * Chains as data: what AgentPOS needs to know about a network to price, address and link a
 * payment on it, without knowing how the payment protocol works there (that is a rail's job,
 * guardrail 3).
 *
 * A chain is identified by its CAIP-2 id (`stellar:pubnet`, `eip155:5042`, `solana:<ref>`).
 * Each chain has a {@link ChainProfile}: the decimals its USDC uses ON THAT NETWORK (7 on
 * Stellar, 6 on EVM chains and Solana), how to tell a valid address, and where a transaction
 * can be seen. Stellar ships built in; a chain package (for example the Arc rail) registers its
 * own profile with {@link registerChainProfile}, so the core never has to know every chain.
 */
import { StrKey } from "@stellar/stellar-sdk";
import { AgentPOSError } from "./errors.js";
import type { MinorAmount } from "./adapter/rails.js";
import type { UsdcMinor } from "./money.js";
import { USDC_DECIMALS, rescaleMinor } from "./money.js";

/** Chain families AgentPOS knows how to address. The CAIP-2 namespace is the family. */
export const CHAIN_FAMILIES = ["stellar", "eip155", "solana"] as const;
export type ChainFamily = (typeof CHAIN_FAMILIES)[number];

/** A CAIP-2 chain id: `<namespace>:<reference>`. */
export type Caip2 = `${string}:${string}`;

const CAIP2_RE = /^([-a-z0-9]{3,8}):([-_a-zA-Z0-9]{1,32})$/;

/** Shape check against the CAIP-2 grammar, without throwing. */
export function isCaip2(value: unknown): value is Caip2 {
  return typeof value === "string" && CAIP2_RE.test(value);
}

/** Splits a CAIP-2 id into namespace and reference, rejecting anything outside the grammar. */
export function parseCaip2(value: string): { namespace: string; reference: string } {
  const match = CAIP2_RE.exec(value);
  if (!match) {
    throw new AgentPOSError("CHAIN_UNKNOWN", `Not a CAIP-2 chain id: '${value}'`, {
      hint: "Use '<namespace>:<reference>', e.g. 'stellar:pubnet' or 'eip155:5042'.",
      details: { value },
    });
  }
  return { namespace: match[1] as string, reference: match[2] as string };
}

/** The family of a chain id, or undefined when AgentPOS has no notion of that namespace. */
export function chainFamilyOf(caip2: string): ChainFamily | undefined {
  const { namespace } = parseCaip2(caip2);
  return (CHAIN_FAMILIES as readonly string[]).includes(namespace)
    ? (namespace as ChainFamily)
    : undefined;
}

/** What AgentPOS knows about one network. Pure data plus two small pure functions. */
export interface ChainProfile {
  /** CAIP-2 id, e.g. "eip155:5042". */
  readonly caip2: Caip2;
  readonly family: ChainFamily;
  /** Human name shown to merchants, e.g. "Arc", "Stellar". */
  readonly label: string;
  /** True for test networks. Mainnet profiles still go through guardrail 2 in config. */
  readonly testnet: boolean;
  /** Decimals of USDC's minor unit on this network (Stellar 7, EVM and Solana 6). */
  readonly usdcDecimals: number;
  /** True when `address` is a well-formed receiving address on this network. */
  isValidAddress(address: string): boolean;
  /** Public explorer page for a transaction, when the network has one. */
  explorerTxUrl?(txHash: string): string;
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Family-level address shape checks. A chain package may tighten these (for example, EIP-55
 * checksum) in its own profile; the core keeps them dependency-free.
 */
export const FAMILY_ADDRESS_CHECKS: Record<ChainFamily, (address: string) => boolean> = {
  stellar: (a) => StrKey.isValidEd25519PublicKey(a) || StrKey.isValidContract(a),
  eip155: (a) => EVM_ADDRESS_RE.test(a) && !/^0x0{40}$/.test(a),
  solana: (a) => SOLANA_ADDRESS_RE.test(a),
};

const stellarProfile = (caip2: Caip2, testnet: boolean): ChainProfile => ({
  caip2,
  family: "stellar",
  label: testnet ? "Stellar testnet" : "Stellar",
  testnet,
  usdcDecimals: 7,
  isValidAddress: FAMILY_ADDRESS_CHECKS.stellar,
  explorerTxUrl: (tx) =>
    `https://stellar.expert/explorer/${testnet ? "testnet" : "public"}/tx/${encodeURIComponent(tx)}`,
});

/** Profiles that ship with the core. Other chains arrive through their rail packages. */
export const BUILTIN_CHAIN_PROFILES: readonly ChainProfile[] = [
  stellarProfile("stellar:testnet", true),
  stellarProfile("stellar:pubnet", false),
];

const registry = new Map<string, ChainProfile>(
  BUILTIN_CHAIN_PROFILES.map((p) => [p.caip2, p] as const),
);

function assertProfile(profile: ChainProfile): void {
  const family = chainFamilyOf(profile.caip2);
  if (family === undefined || family !== profile.family) {
    throw new AgentPOSError(
      "CHAIN_UNKNOWN",
      `Chain profile '${profile.caip2}' does not match family '${profile.family}'`,
      {
        hint: `The CAIP-2 namespace must be one of: ${CHAIN_FAMILIES.join(", ")}, and equal the profile's family.`,
        details: { caip2: profile.caip2, family: profile.family },
      },
    );
  }
  if (
    !Number.isInteger(profile.usdcDecimals) ||
    profile.usdcDecimals < 0 ||
    profile.usdcDecimals > 18
  ) {
    throw new AgentPOSError("INVALID_AMOUNT", `Invalid USDC decimals for ${profile.caip2}`, {
      hint: "USDC uses 7 decimals on Stellar and 6 on EVM chains and Solana.",
      details: { caip2: profile.caip2, usdcDecimals: profile.usdcDecimals },
    });
  }
}

/**
 * Adds a chain the core does not ship. Idempotent for the exact same profile object; a
 * different profile under an existing id is refused, so two packages cannot silently disagree
 * on decimals for the same network.
 */
export function registerChainProfile(profile: ChainProfile): void {
  assertProfile(profile);
  const existing = registry.get(profile.caip2);
  if (existing && existing !== profile) {
    if (existing.usdcDecimals !== profile.usdcDecimals || existing.family !== profile.family) {
      throw new AgentPOSError(
        "CHAIN_UNKNOWN",
        `Chain '${profile.caip2}' is already registered with different parameters`,
        {
          hint: "Register each network once; decimals and family must agree everywhere.",
          details: {
            caip2: profile.caip2,
            existing: { family: existing.family, usdcDecimals: existing.usdcDecimals },
            incoming: { family: profile.family, usdcDecimals: profile.usdcDecimals },
          },
        },
      );
    }
  }
  registry.set(profile.caip2, profile);
}

export function getChainProfile(caip2: string): ChainProfile | undefined {
  return registry.get(caip2);
}

export function requireChainProfile(caip2: string): ChainProfile {
  const profile = registry.get(caip2);
  if (!profile) {
    throw new AgentPOSError("CHAIN_UNKNOWN", `No chain profile for '${caip2}'`, {
      hint: "Install and import the rail package for that network, or check the CAIP-2 id.",
      details: { caip2, known: [...registry.keys()] },
    });
  }
  return profile;
}

export function listChainProfiles(): ChainProfile[] {
  return [...registry.values()];
}

/**
 * Validates a merchant's receiving address for a given network and returns it unchanged.
 * Never ours: a payTo is always the merchant's own wallet (guardrail 1).
 */
export function assertAddressFor(caip2: string, address: string): string {
  const profile = requireChainProfile(caip2);
  if (!profile.isValidAddress(address)) {
    throw new AgentPOSError(
      "ADDRESS_INVALID",
      `'${address}' is not a valid ${profile.label} address`,
      {
        hint:
          profile.family === "stellar"
            ? "Use the public address of your wallet: 56 characters starting with G (or C for a contract)."
            : profile.family === "eip155"
              ? "Use the public address of your wallet: 0x followed by 40 hexadecimal characters."
              : "Use the public address of your wallet (base58).",
        details: { caip2, address },
      },
    );
  }
  return address;
}

/**
 * A catalog price (always USDC in 7-decimal minor units, the catalog's canonical unit) expressed
 * in the minor unit USDC uses on `caip2`. Exact or an error: 1.2345678 USDC cannot be charged on
 * a 6-decimal network, and AgentPOS will not round it to 1.234568.
 */
export function usdcOnChain(price: UsdcMinor, caip2: string): MinorAmount {
  const { usdcDecimals } = requireChainProfile(caip2);
  return {
    minor: rescaleMinor(price, USDC_DECIMALS, usdcDecimals),
    currency: "USDC",
    decimals: usdcDecimals,
  };
}

/** Test hook: forget every profile that is not built in. */
export function resetChainProfilesForTests(): void {
  registry.clear();
  for (const p of BUILTIN_CHAIN_PROFILES) registry.set(p.caip2, p);
}
