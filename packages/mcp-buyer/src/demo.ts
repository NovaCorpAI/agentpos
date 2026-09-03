/**
 * The reference buying agent (G2): discovers a store it was never told about, quotes a cart, pays
 * it, and shows the transaction hash and the receipt.
 *
 * It exists for three audiences at once, which is why it narrates every step:
 *  - a merchant who wants to check their own store actually works end to end;
 *  - a third party evaluating whether AgentPOS stores are really open (nothing here is special
 *    to us: it is HTTP, an OpenAPI document and an x402 challenge);
 *  - the launch video.
 *
 * `--dry-run` stops before paying, so anyone can exercise discovery and quoting with no wallet
 * and no funds. That is the mode most people should run first.
 */
import { formatUsdc, usdcFromMinor } from "@agentpos/core";
import type { Address, BuyerContact } from "@agentpos/core";
import { SiteClient } from "./siteClient.js";
import type { SiteCart, SiteItem, SiteOrder } from "./siteClient.js";
import type { BuyerService } from "./buyer.js";

export interface DemoStep {
  /** Short label for the step, e.g. "discover". */
  step: string;
  /** One line a human can read while it happens. */
  message: string;
  /** Structured detail, for tests and for machine consumers. */
  detail?: Record<string, unknown>;
}

export interface DemoOptions {
  storeUrl: string;
  /** Item id to buy. Defaults to the cheapest published item. */
  itemId?: string | undefined;
  quantity?: number;
  dryRun?: boolean;
  buyer?: BuyerContact | undefined;
  shipping?: Address | undefined;
  /** Injected in tests; production uses global fetch. */
  fetchImpl?: typeof globalThis.fetch;
  /** Required unless dryRun: the wallet that pays. */
  buyerService?: BuyerService | undefined;
  onStep?: ((step: DemoStep) => void) | undefined;
}

export interface DemoResult {
  store: { url: string; name: string; network: string; asset: string };
  discovery: {
    openapi: boolean;
    llmsTxt: boolean;
    ucpManifest: boolean;
    mcp: boolean;
    /** How the agent learned where to buy. */
    via: "openapi" | "ucp" | "catalog";
  };
  item?: SiteItem;
  cart?: SiteCart;
  order?: SiteOrder;
  txHash?: string;
  receipt?: { hash: string; verified: boolean; issue?: string };
  steps: DemoStep[];
  /** False when --dry-run, or when the run stopped before settling. */
  paid: boolean;
}

interface OpenApiDoc {
  info?: { title?: string; "x-guidance"?: string };
  "x-agentpos"?: {
    network?: string;
    asset?: string;
    mcp?: string;
    manifest?: string;
    publishedItems?: number;
  };
  paths?: Record<string, unknown>;
}

async function head(fetchImpl: typeof globalThis.fetch, url: string): Promise<boolean> {
  try {
    const res = await fetchImpl(url, { headers: { accept: "*/*" } });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Runs the whole loop. Never throws for a store that simply cannot sell (empty catalog, policy
 * refusal): those are answers, and the caller wants to see them, not a stack trace.
 */
export async function runDemoPurchase(options: DemoOptions): Promise<DemoResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const steps: DemoStep[] = [];
  const emit = (step: DemoStep): void => {
    steps.push(step);
    options.onStep?.(step);
  };

  const origin = options.storeUrl.replace(/\/+$/, "");
  const client = new SiteClient(origin, fetchImpl);

  // 1. Discovery, exactly as an agent that was never told this store exists would do it.
  emit({ step: "discover", message: `Looking at ${origin} the way an agent would.` });
  let doc: OpenApiDoc | undefined;
  try {
    const res = await fetchImpl(`${origin}/openapi.json`, { headers: { accept: "application/json" } });
    if (res.ok) doc = (await res.json()) as OpenApiDoc;
  } catch {
    doc = undefined;
  }
  const [llmsTxt, ucpManifest] = await Promise.all([
    head(fetchImpl, `${origin}/llms.txt`),
    head(fetchImpl, `${origin}/.well-known/ucp`),
  ]);

  const info = await client.info();
  const mcp = Boolean(doc?.["x-agentpos"]?.mcp);
  const via: DemoResult["discovery"]["via"] = doc ? "openapi" : ucpManifest ? "ucp" : "catalog";
  emit({
    step: "discover",
    message: doc
      ? `Found an OpenAPI contract: "${doc.info?.title ?? info.name}". It says how to buy without asking anyone.`
      : ucpManifest
        ? "No OpenAPI document, but there is a UCP manifest; using that."
        : "No discovery document; falling back to the catalog endpoint.",
    detail: { openapi: Boolean(doc), llmsTxt, ucpManifest, mcp, via },
  });
  emit({
    step: "store",
    message: `${info.name} settles on ${info.network} in ${info.asset}.`,
    detail: { name: info.name, network: info.network, asset: info.asset },
  });

  const result: DemoResult = {
    store: { url: origin, name: info.name, network: info.network, asset: info.asset },
    discovery: { openapi: Boolean(doc), llmsTxt, ucpManifest, mcp, via },
    steps,
    paid: false,
  };

  // 2. Catalog.
  const items = await client.search("");
  if (items.length === 0) {
    emit({ step: "catalog", message: "This store has nothing published. Nothing to buy." });
    return result;
  }
  emit({
    step: "catalog",
    message: `${items.length} item(s) for sale, from ${items
      .map((i) => `${i.price.amount} ${i.price.asset}`)
      .join(", ")}.`,
    detail: { items: items.map((i) => ({ id: i.id, title: i.title, price: i.price.amount })) },
  });

  const item = options.itemId
    ? items.find((i) => i.id === options.itemId)
    : [...items].sort((a, b) =>
        BigInt(a.price.minor) < BigInt(b.price.minor)
          ? -1
          : BigInt(a.price.minor) > BigInt(b.price.minor)
            ? 1
            : 0,
      )[0];
  if (!item) {
    emit({
      step: "catalog",
      message: `No item '${options.itemId}' in this catalog.`,
      detail: { available: items.map((i) => i.id) },
    });
    return result;
  }
  result.item = item;
  const quantity = options.quantity ?? 1;
  emit({
    step: "choose",
    message: `Buying ${quantity} x ${item.title} at ${item.price.amount} ${item.price.asset}.`,
    detail: { itemId: item.id, quantity },
  });

  // 3. Quote. Free, reserves nothing, and returns the exact terms the 402 will demand.
  const cart = await client.createCart(
    [{ itemId: item.id, quantity }],
    options.buyer,
    options.shipping,
  );
  result.cart = cart;
  emit({
    step: "quote",
    message: `Quoted ${cart.quote.total} ${cart.quote.asset} to ${cart.quote.payTo.slice(0, 8)}..., valid until ${cart.expiresAt}.`,
    detail: { cartId: cart.cartId, total: cart.quote.total, payTo: cart.quote.payTo },
  });
  if (cart.policy && cart.policy.decision !== "allowed") {
    emit({
      step: "policy",
      message: `The merchant sends this order to a human: ${cart.policy.message ?? cart.policy.code}. Nothing is charged while they decide.`,
      detail: { policy: cart.policy },
    });
  }

  if (options.dryRun) {
    emit({
      step: "done",
      message: "Dry run: stopping before payment. Everything above needed no wallet and no funds.",
    });
    return result;
  }

  const buyer = options.buyerService;
  if (!buyer) {
    emit({
      step: "pay",
      message: "No wallet configured, so the run stops here. Use --dry-run, or `agentpos-buyer init` first.",
    });
    return result;
  }

  // 4. Pay the 402 and wait for the order.
  emit({ step: "pay", message: `Paying ${cart.quote.total} ${cart.quote.asset} over x402...` });
  const bought = await buyer.buy(origin, cart.cartId);
  result.order = bought.order;
  result.txHash = bought.receipt.txHash;
  result.paid = true;
  emit({
    step: "settled",
    message: `Settled on ${bought.receipt.network}. Transaction ${bought.receipt.txHash}.`,
    detail: { txHash: bought.receipt.txHash, orderId: bought.orderId },
  });
  emit({
    step: "order",
    message: bought.order.externalOrderId
      ? `The merchant's own system created order ${bought.order.externalOrderId}.`
      : `Order ${bought.order.orderId} is ${bought.order.status}; the platform order is still pending.`,
    detail: {
      orderId: bought.order.orderId,
      status: bought.order.status,
      externalOrderId: bought.order.externalOrderId,
      connectorError: bought.order.connectorError,
    },
  });

  // 5. The receipt, if the store keeps them. Verified here rather than trusted.
  const receipt = await fetchReceipt(fetchImpl, origin, client.basePath, bought.orderId);
  if (receipt) {
    result.receipt = receipt;
    emit({
      step: "receipt",
      message: receipt.verified
        ? `Signed receipt ${receipt.hash.slice(0, 16)}... verifies. Keep it: it proves the terms, the policy and the settlement.`
        : `The store returned a receipt that does NOT verify: ${receipt.issue ?? "unknown reason"}.`,
      detail: receipt,
    });
  }
  return result;
}

async function fetchReceipt(
  fetchImpl: typeof globalThis.fetch,
  origin: string,
  basePath: string,
  orderId: string,
): Promise<{ hash: string; verified: boolean; issue?: string } | undefined> {
  try {
    const res = await fetchImpl(`${origin}${basePath}/orders/${encodeURIComponent(orderId)}/receipt`);
    if (!res.ok) return undefined;
    const body = (await res.json()) as {
      receipts?: Array<{ hash?: string }>;
      verification?: { valid?: boolean; issues?: Array<{ message?: string }> };
    };
    const hash = body.receipts?.[0]?.hash;
    if (!hash) return undefined;
    const verified = body.verification?.valid === true;
    const issue = body.verification?.issues?.[0]?.message;
    return { hash, verified, ...(issue ? { issue } : {}) };
  } catch {
    return undefined;
  }
}

/** Total the demo would spend, for a caller that wants to check limits before running. */
export function demoCost(cart: SiteCart): string {
  return formatUsdc(usdcFromMinor(cart.quote.totalMinor));
}
