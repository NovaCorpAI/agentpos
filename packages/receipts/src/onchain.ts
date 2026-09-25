/**
 * On-chain confirmation (M4). The optional half of verification: does the ledger agree with what
 * the receipt says was paid?
 *
 * We read Horizon's `effects` for the transaction, because that is where a payment shows up as
 * facts a third party can compare: which account was credited, with how much, of which asset.
 * Plain HTTP against a public endpoint, so anyone can reproduce this with curl.
 *
 * What it proves: a transaction with that hash exists on that network, succeeded, and credited
 * the quoted amount of the quoted asset to the quoted address.
 * What it does not prove: that the buyer intended it, or that the store shipped anything. A
 * receipt is evidence of terms and settlement, not of satisfaction.
 */
import { HORIZON_URLS, USDC_ISSUER } from "@agentpos/core";
import type { Receipt } from "./types.js";

export interface OnChainOptions {
  /** Overrides the endpoint derived from the receipt's network. */
  horizonUrl?: string;
  /** Overrides the issuer expected for the asset code (defaults to Circle's USDC). */
  expectedIssuer?: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface OnChainResult {
  /** True only when the ledger matches the receipt on amount, asset and destination. */
  confirmed: boolean;
  reason?: string;
  txHash?: string;
  ledger?: number;
  closedAt?: string;
  credited?: { account: string; amount: string; assetCode: string; assetIssuer?: string };
}

interface HorizonTransaction {
  successful?: boolean;
  ledger?: number;
  created_at?: string;
}

interface HorizonEffect {
  type?: string;
  account?: string;
  amount?: string;
  asset_code?: string;
  asset_issuer?: string;
  asset_type?: string;
}

function horizonFor(network: string, override?: string): string | undefined {
  if (override) return override.replace(/\/+$/, "");
  if (network === "stellar:testnet") return HORIZON_URLS.testnet;
  if (network === "stellar:pubnet") return HORIZON_URLS.mainnet;
  return undefined;
}

function issuerFor(network: string, override?: string): string | undefined {
  if (override) return override;
  if (network === "stellar:testnet") return USDC_ISSUER.testnet;
  if (network === "stellar:pubnet") return USDC_ISSUER.mainnet;
  return undefined;
}

/** Amounts on Horizon are decimal strings with 7 places; receipts carry integer minor units. */
function toMinor(amount: string): bigint | undefined {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(amount.trim());
  if (!match) return undefined;
  return BigInt(match[1] as string) * 10_000_000n + BigInt((match[2] ?? "").padEnd(7, "0"));
}

export async function verifyPaymentOnChain(
  receipt: Receipt,
  options: OnChainOptions = {},
): Promise<OnChainResult> {
  const { payment, terms } = receipt.body;
  if (!payment) return { confirmed: false, reason: "This receipt records no payment" };
  // A card rail settles at the acquirer, not on a ledger: there is nothing to look up. The
  // offline verification (4.1) is the whole proof; say so instead of failing a lookup.
  if (payment.rail !== undefined && !payment.network.startsWith("stellar:"))
    return {
      confirmed: false,
      reason: `Rail '${payment.rail}' does not settle on a ledger; offline verification is the proof`,
      txHash: payment.txHash,
    };

  const base = horizonFor(payment.network, options.horizonUrl);
  if (!base)
    return {
      confirmed: false,
      reason: `No Horizon endpoint known for network '${payment.network}'; pass horizonUrl`,
      txHash: payment.txHash,
    };

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  let tx: HorizonTransaction;
  let effects: HorizonEffect[];
  try {
    const txRes = await fetchImpl(`${base}/transactions/${payment.txHash}`, { signal });
    if (txRes.status === 404)
      return {
        confirmed: false,
        reason: "No transaction with that hash on this network",
        txHash: payment.txHash,
      };
    if (!txRes.ok)
      return {
        confirmed: false,
        reason: `Horizon answered ${txRes.status}`,
        txHash: payment.txHash,
      };
    tx = (await txRes.json()) as HorizonTransaction;
    const efRes = await fetchImpl(`${base}/transactions/${payment.txHash}/effects?limit=200`, {
      signal,
    });
    const efBody = efRes.ok
      ? ((await efRes.json()) as { _embedded?: { records?: HorizonEffect[] } })
      : {};
    effects = efBody._embedded?.records ?? [];
  } catch (err) {
    return {
      confirmed: false,
      reason: `Could not reach Horizon: ${err instanceof Error ? err.message : String(err)}`,
      txHash: payment.txHash,
    };
  }

  const found = {
    txHash: payment.txHash,
    ...(tx.ledger !== undefined ? { ledger: tx.ledger } : {}),
    ...(tx.created_at ? { closedAt: tx.created_at } : {}),
  };
  if (tx.successful === false)
    return { ...found, confirmed: false, reason: "The transaction failed on chain" };

  const destination = terms?.payTo;
  const expectedMinor = BigInt(payment.amountMinor);
  const expectedIssuer = issuerFor(payment.network, options.expectedIssuer);

  const credits = effects.filter((e) => e.type === "account_credited");
  const match = credits.find(
    (e) =>
      (!destination || e.account === destination) &&
      e.asset_code === payment.asset &&
      e.amount !== undefined &&
      toMinor(e.amount) === expectedMinor,
  );
  if (!match) {
    return {
      ...found,
      confirmed: false,
      reason:
        credits.length === 0
          ? "The transaction credits no account that Horizon reports; cannot confirm the payment from effects"
          : "No credit on this transaction matches the receipt's amount, asset and destination",
      ...(credits[0]?.account
        ? {
            credited: {
              account: credits[0].account,
              amount: credits[0].amount ?? "",
              assetCode: credits[0].asset_code ?? "",
              ...(credits[0].asset_issuer ? { assetIssuer: credits[0].asset_issuer } : {}),
            },
          }
        : {}),
    };
  }
  if (expectedIssuer && match.asset_issuer && match.asset_issuer !== expectedIssuer) {
    return {
      ...found,
      confirmed: false,
      reason: `The credited asset is issued by ${match.asset_issuer}, not ${expectedIssuer}`,
    };
  }

  return {
    ...found,
    confirmed: true,
    credited: {
      account: match.account ?? "",
      amount: match.amount ?? "",
      assetCode: match.asset_code ?? "",
      ...(match.asset_issuer ? { assetIssuer: match.asset_issuer } : {}),
    },
  };
}
