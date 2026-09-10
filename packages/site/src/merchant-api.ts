/**
 * Read-only merchant API under `{base}/api/merchant/*` (AgentPOS Cloud foundation,
 * plan/COMERCIAL.md phase 2).
 *
 * The bearer token (`MERCHANT_API_TOKEN`) belongs to the STORE OWNER: it lets them, or a
 * dashboard they authorize (AgentPOS Cloud), read their own orders, receipts, rules and health
 * programmatically. It is not an agent credential and it unlocks nothing an agent-facing
 * endpoint does not already require.
 *
 * READ-ONLY BY DESIGN: this surface has no mutations, in this milestone and on purpose. Prices,
 * policies and rules live in the merchant's own `agentpos.config.json` on their machine; a
 * hosted dashboard must never be able to change what a store sells or for how much. If a future
 * feature seems to need a remote write here, stop and reconsider (guardrail 7 territory).
 *
 * The routes are mounted only when the token is configured, exactly like the buyer-web signer
 * bridge: without `MERCHANT_API_TOKEN` the paths do not exist at all.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { ADAPTER_VERSION, AgentPOSError } from "@agentpos/core";
import type { CoreConfig, FacilitatorHealth, Logger, Order, OrderStatus } from "@agentpos/core";
import { ORDER_STATUSES, formatUsdc, usdc } from "@agentpos/core";
import type { ReceiptChain } from "@agentpos/receipts";
import type { Receipt } from "@agentpos/receipts";
import { orderView } from "./app.js";
import type { CheckoutService } from "./checkout.js";
import type { SiteConfig } from "./config.js";
import { railOf } from "./export.js";
import { clientIp, rateLimit } from "./ratelimit.js";
import type { TokenBucketLimiter } from "./ratelimit.js";
import type { SiteStorage } from "./storage.js";

/** Server-side minimum for the owner token: anything shorter is guessable. */
export const MERCHANT_API_TOKEN_MIN_LENGTH = 24;

const MAX_PAGE_LIMIT = 200;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_RECEIPT_PAGE_LIMIT = 500;
const DEFAULT_RECEIPT_PAGE_LIMIT = 100;

export interface MerchantApiDeps {
  /** The store owner's bearer token. Min 24 chars; validated here and in config. */
  token: string;
  base: string;
  siteUrl: string;
  site: SiteConfig;
  core: CoreConfig;
  storage: SiteStorage;
  checkout: CheckoutService;
  /** Signed audit chain (M4), when the site keeps receipts. */
  receipts: ReceiptChain | undefined;
  /** Reuses the app's cached facilitator health: hosts and statuses only, never keys. */
  facilitatorReport: () => Promise<{
    facilitator: FacilitatorHealth;
    pool: Array<Record<string, unknown>>;
  }>;
  limiter: TokenBucketLimiter;
  logger: Logger;
}

/**
 * The rules a store enforces on agents, as one JSON document. Shared by `/dashboard/rules`
 * (the human dashboard's Rules tab) and `/api/merchant/rules` (the Cloud reads the same shape),
 * so the two can never drift apart.
 *
 * Read-only view derived from SiteConfig. Exposing it adds no attack surface: every rule here
 * is already discoverable by probing the store (policy denials carry code + details, the 402
 * carries the payment terms, the UCP manifest carries payTo), so this only saves the probing.
 * Secrets never appear: channels are reduced to configured/not booleans on purpose.
 */
export function buildRulesView(site: SiteConfig, core: CoreConfig): Record<string, unknown> {
  const p = site.policy;
  // Optional USDC amounts normalized through the money types; null means "no limit".
  const money = (v: string | undefined): string | null =>
    v === undefined ? null : formatUsdc(usdc(v));
  return {
    store: { name: site.displayName, url: site.siteUrl.replace(/\/+$/, "") },
    network: core.caip2,
    asset: core.checkoutAsset,
    payTo: site.payTo,
    cartTtlMinutes: site.cartTtlMinutes,
    policy: {
      status: p.status,
      maxOrderUsdc: money(p.maxOrderUsdc),
      period: p.period,
      maxPeriodUsdc: money(p.maxPeriodUsdc),
      maxQuantityPerItem: p.maxQuantityPerItem ?? null,
      maxQuantityPerOrder: p.maxQuantityPerOrder ?? null,
      excludedItemsCount: p.excludedItems.length,
      allowedShippingCountries: p.allowedShippingCountries,
      approvalThresholdUsdc: money(p.approvalThresholdUsdc),
    },
    approvals: {
      enabled: site.approvals.enabled,
      ttlMinutes: site.approvals.ttlMinutes,
      channels: {
        webhook: site.approvals.webhookUrl !== undefined,
        whatsapp: site.approvals.whatsapp !== undefined,
      },
    },
    identity: { mode: site.identity.mode, autoRegister: site.identity.autoRegister },
    receipts: {
      enabled: site.receipts.enabled,
      publicOrderReceipts: site.receipts.publicOrderReceipts,
    },
  };
}

/**
 * The merchant's view of an order: the agent-facing serialization plus what only the merchant
 * sees (buyer, shipping, cart id) and the rail fields the reconciliation export uses, so the
 * Cloud can reconcile from this endpoint alone.
 */
function merchantOrderView(order: Order): Record<string, unknown> {
  return {
    ...orderView(order),
    cartId: order.cartId,
    // Same rail derivation as the reconciliation export: "stellar:testnet" -> "x402-stellar".
    rail: order.payment ? railOf(order.payment.network) : null,
    txHash: order.payment?.txHash ?? null,
    ...(order.buyer ? { buyer: order.buyer } : {}),
    ...(order.shipping ? { shipping: order.shipping } : {}),
  };
}

/** Chain entry as the list endpoint returns it: enough to sync and detect gaps, nothing more. */
function receiptEntry(receipt: Receipt): Record<string, unknown> {
  return {
    seq: receipt.body.seq,
    hash: receipt.hash,
    event: receipt.body.event,
    orderId: receipt.body.order?.id ?? null,
    at: receipt.body.at,
  };
}

/** Opaque cursors: base64url JSON, so the wire format can change without breaking clients. */
function encodeCursor(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined || raw === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw.slice(0, 256), "base64url").toString("utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to the typed error below
  }
  throw new AgentPOSError("CONFIG_INVALID", "Invalid cursor", {
    hint: "Cursors are opaque; pass the nextCursor value from the previous page unmodified.",
  });
}

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new AgentPOSError("CONFIG_INVALID", `limit must be an integer between 1 and ${max}`, {
      hint: `Omit limit for the default of ${fallback}.`,
    });
  }
  return n;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** `from`/`to` accept YYYY-MM-DD (whole days, like the CSV export) or a full ISO timestamp. */
function parseBound(raw: string | undefined, name: "from" | "to"): Date | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = DATE_ONLY.test(raw)
    ? `${raw}T${name === "from" ? "00:00:00.000" : "23:59:59.999"}Z`
    : raw;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AgentPOSError("CONFIG_INVALID", `Invalid ${name} date`, {
      hint: "Use YYYY-MM-DD or a full ISO 8601 timestamp.",
    });
  }
  return date;
}

export function registerMerchantApi(app: Hono, deps: MerchantApiDeps): void {
  const { site, core, storage, receipts, logger } = deps;
  if (deps.token.length < MERCHANT_API_TOKEN_MIN_LENGTH) {
    throw new AgentPOSError("CONFIG_INVALID", "MERCHANT_API_TOKEN is too short", {
      hint: "Use at least 24 characters, e.g. `openssl rand -hex 24`. A guessable token would expose every order and buyer email to anyone.",
    });
  }
  const prefix = `${deps.base}/api/merchant`;
  const expected = Buffer.from(deps.token, "utf8");
  // Logged instead of the token: enough to correlate requests to a credential, useless to authenticate.
  const tokenHash = createHash("sha256").update(deps.token, "utf8").digest("hex").slice(0, 8);

  // Rate limit before auth: a wrong token still spends the caller's budget.
  app.use(`${prefix}/*`, rateLimit(deps.limiter, clientIp, "merchant API"));
  app.use(`${prefix}/*`, async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const presented = Buffer.from(
      header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "",
      "utf8",
    );
    // timingSafeEqual requires equal lengths; a length mismatch is already a wrong token.
    if (presented.length !== expected.length || !timingSafeEqual(expected, presented)) {
      return c.json(
        {
          error: {
            code: "MERCHANT_UNAUTHORIZED",
            message: "Merchant token missing or wrong",
            hint: "Send `Authorization: Bearer <MERCHANT_API_TOKEN>` (the store owner's token, from the sidecar's environment).",
            retryable: false,
          },
        },
        401,
      );
    }
    logger.info("merchant_api.request", {
      traceId: c.res.headers.get("x-trace-id"),
      route: c.req.path,
      token: tokenHash, // sha256-8 of the token, never the token itself
    });
    await next();
  });

  // Paginated order list, oldest first. The cursor is opaque (created_at + id underneath), so
  // the Cloud can sync incrementally: keep the last nextCursor and ask again later.
  app.get(`${prefix}/orders`, (c) => {
    const rawStatus = c.req.query("status");
    if (rawStatus !== undefined && rawStatus !== "" && !(ORDER_STATUSES as readonly string[]).includes(rawStatus)) {
      throw new AgentPOSError("CONFIG_INVALID", `Unknown order status '${rawStatus.slice(0, 32)}'`, {
        hint: `Use one of: ${ORDER_STATUSES.join(", ")}.`,
      });
    }
    const status = rawStatus === "" ? undefined : (rawStatus as OrderStatus | undefined);
    const since = parseBound(c.req.query("from"), "from");
    const until = parseBound(c.req.query("to"), "to");
    const limit = parseLimit(c.req.query("limit"), DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const cursor = decodeCursor(c.req.query("cursor"));
    const after =
      cursor && typeof cursor.c === "string" && typeof cursor.i === "string"
        ? { createdAt: cursor.c, id: cursor.i }
        : undefined;
    const rows = storage.listOrdersPage({
      ...(status ? { status } : {}),
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
      ...(after ? { after } : {}),
      limit: limit + 1, // one extra row answers "is there a next page" without a count query
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return c.json({
      orders: page.map(merchantOrderView),
      nextCursor:
        rows.length > limit && last ? encodeCursor({ c: last.createdAt, i: last.id }) : null,
    });
  });

  // Full order detail, connectorError and hold included when present (the two states the
  // merchant most needs to see from a dashboard).
  app.get(`${prefix}/orders/:id`, (c) =>
    c.json({ order: merchantOrderView(deps.checkout.getOrder(c.req.param("id").slice(0, 64))) }),
  );

  // The receipt chain, ascending by seq. Chain entries only; fetch /receipts/:seq for a body.
  app.get(`${prefix}/receipts`, (c) => {
    const limit = parseLimit(
      c.req.query("limit"),
      DEFAULT_RECEIPT_PAGE_LIMIT,
      MAX_RECEIPT_PAGE_LIMIT,
    );
    const cursor = decodeCursor(c.req.query("cursor"));
    const afterSeq = cursor && typeof cursor.s === "number" && Number.isInteger(cursor.s) ? cursor.s : 0;
    const rows = storage.listReceiptsAfterSeq(afterSeq, limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return c.json({
      receipts: page.map(receiptEntry),
      nextCursor: rows.length > limit && last ? encodeCursor({ s: last.body.seq }) : null,
      ...(receipts ? { signer: receipts.signer } : {}),
    });
  });

  // One full receipt: body, hash and signature, so the Cloud can verify what it archives.
  app.get(`${prefix}/receipts/:seq`, (c) => {
    const raw = c.req.param("seq").slice(0, 16);
    const seq = Number(raw);
    if (!Number.isInteger(seq) || seq < 1) {
      throw new AgentPOSError("CONFIG_INVALID", `Invalid receipt seq '${raw}'`, {
        hint: "seq is a positive integer from the receipts list.",
      });
    }
    const receipt = storage.getReceiptBySeq(seq);
    if (!receipt) {
      throw new AgentPOSError("RECEIPT_NOT_FOUND", `No receipt with seq '${seq}'`, {
        hint: "List the chain at /api/merchant/receipts; seq is 1-based and gap-free.",
      });
    }
    return c.json({ receipt });
  });

  // Same shape as /dashboard/rules: both call buildRulesView, so they cannot drift.
  app.get(`${prefix}/rules`, (c) => c.json(buildRulesView(site, core)));

  // The Cloud dashboard's front page in one call: identity, counts and health.
  app.get(`${prefix}/summary`, async (c) => {
    const { facilitator, pool } = await deps.facilitatorReport();
    const byStatus = storage.orderStatusCounts();
    return c.json({
      store: { name: site.displayName, url: deps.siteUrl },
      network: core.caip2,
      asset: core.checkoutAsset,
      adapterVersion: ADAPTER_VERSION,
      counts: {
        orders: {
          total: Object.values(byStatus).reduce((a, b) => a + b, 0),
          byStatus,
        },
        receipts: storage.receiptCount(),
        publishedItems: storage.publishedItemCount(),
      },
      // Facilitator health as /health reports it: hosts and statuses only, never keys.
      facilitator,
      facilitators: pool,
      ...(receipts
        ? { receipts: { signer: receipts.signer, chainHeight: receipts.head()?.body.seq ?? 0 } }
        : {}),
    });
  });
}
