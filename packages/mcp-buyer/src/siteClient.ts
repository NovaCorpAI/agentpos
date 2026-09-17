/**
 * HTTP client for AgentPOS sites (and, later, any UCP/ACP/x402 site through the adapter).
 */
import { AgentPOSError, usdcFromMinor } from "@agentpos/core";
import type { Address, BuyerContact, CartLine, UsdcMinor } from "@agentpos/core";

export interface SiteInfo {
  url: string;
  host: string;
  name: string;
  network: string;
  asset: string;
  basePath: string;
  manifest: unknown;
}

export interface SiteItem {
  id: string;
  title: string;
  description: string;
  url: string;
  price: { amount: string; asset: string; minor: string };
  physical: boolean;
  attributes: Record<string, string>;
}

export interface SiteCart {
  cartId: string;
  expiresAt: string;
  checkout: string;
  /** Merchant policy outcome (M1): `requires_approval` carts cannot be paid until a human approves. */
  policy?: { decision: "allowed" | "requires_approval"; code?: string; message?: string };
  quote: {
    total: string;
    totalMinor: string;
    asset: string;
    network: string;
    payTo: string;
    requiresShipping: boolean;
    lines: Array<{ itemId: string; title: string; quantity: number; physical: boolean }>;
  };
}

export interface SiteOrder {
  orderId: string;
  status: string;
  total: string;
  payment?: { txHash: string; network: string; asset: string; amountMinor: string; payer?: string };
  externalOrderId?: string;
  externalAdminUrl?: string;
  connectorError?: { code: string; message: string; hint: string };
}

type FetchLike = typeof globalThis.fetch;

async function readJson(res: Response, what: string): Promise<Record<string, unknown>> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = body.error as
      | { code?: string; message?: string; hint?: string; details?: Record<string, unknown> }
      | undefined;
    const code = err?.code;
    const known = [
      "CART_EXPIRED",
      "CART_NOT_FOUND",
      "OUT_OF_STOCK",
      "ITEM_NOT_FOUND",
      "SHIPPING_REQUIRED",
      "ORDER_NOT_FOUND",
    ] as const;
    throw new AgentPOSError(
      known.find((k) => k === code) ?? "SITE_UNREACHABLE",
      err?.message ?? `${what} failed (${res.status})`,
      {
        hint: err?.hint ?? "The site answered with an error; see details.",
        retryable: res.status >= 500,
        details: { status: res.status, ...(err?.details ?? {}) },
      },
    );
  }
  return body;
}

export class SiteClient {
  private readonly base: string;
  readonly host: string;
  constructor(
    siteUrl: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    readonly basePath = "/agentpos",
  ) {
    const u = new URL(siteUrl);
    this.base = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
    this.host = u.host;
  }

  get url(): string {
    return this.base;
  }

  private async get(path: string, what: string): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      throw new AgentPOSError("SITE_UNREACHABLE", `Cannot reach ${this.base}`, {
        hint: "Check the site URL and that its AgentPOS sidecar is running.",
        retryable: true,
        cause,
      });
    }
    return readJson(res, what);
  }

  async info(): Promise<SiteInfo> {
    const manifest = await this.get("/.well-known/ucp", "manifest");
    // /health answers 503 when the site's facilitator is down or orders are stuck; the body is
    // still informative, so read it leniently and let the mandate/network checks decide.
    let health: Record<string, unknown> = {};
    try {
      const res = await this.fetchImpl(`${this.base}${this.basePath}/health`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      health = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      /* health unreachable: keep defaults */
    }
    return {
      url: this.base,
      host: this.host,
      name: String(health.name ?? this.host),
      network: String(health.network ?? "unknown"),
      asset: String(health.asset ?? "USDC"),
      basePath: this.basePath,
      manifest,
    };
  }

  async search(query: string): Promise<SiteItem[]> {
    const body = await this.get(
      `${this.basePath}/catalog${query ? `?q=${encodeURIComponent(query)}` : ""}`,
      "catalog",
    );
    return (body.items as SiteItem[]) ?? [];
  }

  async item(id: string): Promise<SiteItem> {
    return (await this.get(
      `${this.basePath}/items/${encodeURIComponent(id)}`,
      "item",
    )) as unknown as SiteItem;
  }

  async createCart(items: CartLine[], buyer?: BuyerContact, shipping?: Address): Promise<SiteCart> {
    const res = await this.fetchImpl(`${this.base}${this.basePath}/cart`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        items,
        ...(buyer ? { buyer } : {}),
        ...(shipping ? { shipping } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    return (await readJson(res, "cart")) as unknown as SiteCart;
  }

  async order(orderId: string): Promise<SiteOrder> {
    return (await this.get(
      `${this.basePath}/orders/${encodeURIComponent(orderId)}`,
      "order",
    )) as unknown as SiteOrder;
  }

  async waitForOrder(orderId: string, timeoutMs = 15_000): Promise<SiteOrder> {
    const deadline = Date.now() + timeoutMs;
    let last = await this.order(orderId);
    while (!last.externalOrderId && !last.connectorError && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      last = await this.order(orderId);
    }
    return last;
  }
}

export function cartTotalMinor(cart: SiteCart): UsdcMinor {
  return usdcFromMinor(cart.quote.totalMinor);
}
