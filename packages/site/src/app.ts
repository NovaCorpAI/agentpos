/**
 * The HTTP surface of a site (SPEC 01 + 09, hardened for gate G1): discovery, catalog, cart,
 * x402 checkout, orders. Built on Hono so the same app runs as a sidecar or mounted elsewhere.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { paymentMiddleware } from "@x402/hono";
import {
  PaymentRailRegistry,
  X402_STELLAR_RAIL_ID,
  createTransbankRail,
  railFailureToError,
} from "@agentpos/core";
import type {
  Cart,
  FiatAmount,
  Order,
  PaymentRail,
  RailQuote,
  RailQuoteInput,
  RailSettlement,
  TransbankTerms,
} from "@agentpos/core";
import type { SettledTerms } from "./checkout.js";
import type { HTTPTransportContext } from "@x402/core/server";
import {
  AgentPOSError,
  ADAPTER_VERSION,
  assetAddress,
  addressSchema,
  buildAcpFeed,
  buildStoreOpenApi,
  buildUcpProfile,
  buyerContactSchema,
  cartLineSchema,
  checkFacilitator,
  createResourceServer,
  formatUsdc,
  jsonStringify,
  newTraceId,
  silentLogger,
  toReceipt,
  usdcFromMinor,
} from "@agentpos/core";
import type {
  CatalogItem,
  CoreConfig,
  FacilitatorClient,
  FacilitatorHealth,
  Logger,
  OrderConnector,
  UsdcMinor,
} from "@agentpos/core";
import { z } from "zod";
import {
  ApprovalService,
  assertValidResolutionSignature,
  describeApproval,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from "@agentpos/approvals";
import { ReceiptChain, verifyChain, verifyReceipt } from "@agentpos/receipts";
import { IdentityService } from "@agentpos/identity";
import type { AgentIdentity } from "@agentpos/identity";
import { CatalogService, parseCatalogQuery } from "./catalog.js";
import { buildDashboardHtml } from "./dashboard.js";
import { CheckoutService } from "./checkout.js";
import type { AlertSink } from "./checkout.js";
import type { SiteConfig } from "./config.js";
import { FailoverFacilitator, resolveFacilitatorEndpoints } from "./facilitators.js";
import type { FacilitatorClientFactory, FacilitatorEndpoint } from "./facilitators.js";
import { createMcpHandler } from "./mcp.js";
import { buildRulesView, registerMerchantApi } from "./merchant-api.js";
import { TokenBucketLimiter, clientIp, rateLimit } from "./ratelimit.js";
import { loadOrCreateReceiptSigner } from "./receipt-key.js";
import { SiteStorage } from "./storage.js";

export interface AgentPOSDeps {
  site: SiteConfig;
  core: CoreConfig;
  connector: OrderConnector;
  storage?: SiteStorage;
  /** Tests only: stub facilitator. Takes precedence over `facilitators`. */
  facilitator?: FacilitatorClient;
  /**
   * Ordered facilitator endpoints (primary + fallbacks). Resolved from the site config's
   * `facilitators` array or from env (AGENTPOS_FACILITATOR_FALLBACK_URL/_API_KEY) when omitted.
   */
  facilitators?: FacilitatorEndpoint[];
  /** Tests only: builds the per-endpoint client for the failover pool. */
  facilitatorClientFactory?: FacilitatorClientFactory;
  /**
   * Card rails the store accepts besides x402. Built from `site.transbank` + the merchant's
   * credentials when omitted; tests inject a rail with a fake transport here.
   */
  rails?: PaymentRail[];
  /** The merchant's own Transbank credentials (from TRANSBANK_* in the sidecar's env). */
  transbankCommerceCode?: string | undefined;
  transbankApiKey?: string | undefined;
  logger?: Logger;
  alert?: AlertSink;
  /** Human approval queue (M2). Built from storage when the site enables approvals. */
  approvals?: ApprovalService;
  /** Know Your Agent (M3). Built from storage and site.identity when omitted. */
  identity?: IdentityService;
  /** Signed audit chain (M4). Built from storage and the store's receipt key when omitted. */
  receipts?: ReceiptChain;
  /** Overrides the receipt signing secret (tests, or a merchant managing their own key). */
  receiptSecret?: string | undefined;
  /** Shared secret the merchant signs approval resolutions with. Without it, resolve answers 401. */
  approvalSecret?: string | undefined;
  /**
   * The STORE OWNER's bearer token for the read-only merchant API (`{base}/api/merchant/*`),
   * the surface AgentPOS Cloud and the merchant's own tooling read. Min 24 chars (enforced).
   * When absent the routes are not mounted at all (same pattern as the buyer-web signer bridge).
   */
  merchantApiToken?: string | undefined;
  /** Tests only: fetch used for facilitator health checks. */
  healthFetch?: typeof globalThis.fetch;
}

export interface SiteRoutes {
  manifest: string;
  catalog: string;
  feed: string;
  mcp: string;
  cart: string;
  checkout: string;
  /** Card checkout (a rail that hands the payment step to the human, or charges an enrolment). */
  checkoutCard: string;
  orders: string;
  approvals: string;
  receipts: string;
  metrics: string;
  dashboard: string;
  health: string;
}

export interface AgentPOSSite {
  app: Hono;
  fetch: (request: Request) => Promise<Response>;
  storage: SiteStorage;
  catalog: CatalogService;
  checkout: CheckoutService;
  logger: Logger;
  /** Approval queue, when the site enables it (M2). */
  approvals: ApprovalService | undefined;
  /** Agent registry and request authentication (M3). */
  identity: IdentityService;
  /** Signed audit chain, when the site keeps receipts (M4). */
  receipts: ReceiptChain | undefined;
  /** Route table for docs and the CLI. */
  routes: SiteRoutes;
}

const MAX_BODY_BYTES = 64 * 1024;

const createCartSchema = z.object({
  items: z.array(cartLineSchema).min(1).max(50),
  buyer: buyerContactSchema.optional(),
  shipping: addressSchema.optional(),
});

const STATUS_BY_CODE: Record<string, number> = {
  ITEM_NOT_FOUND: 404,
  ORDER_NOT_FOUND: 404,
  CART_NOT_FOUND: 404,
  CART_EXPIRED: 410,
  OUT_OF_STOCK: 409,
  ITEM_NOT_PUBLISHED: 409,
  REQUOTE_REQUIRED: 409,
  SHIPPING_REQUIRED: 422,
  MIXED_PAYTO: 422,
  INVALID_AMOUNT: 422,
  CONFIG_INVALID: 400,
  RATE_LIMITED: 429,
  FACILITATOR_UNAVAILABLE: 502,
  // payment rails: the store declares no rail for this charge / the rail is waiting for a human.
  RAIL_UNSUPPORTED: 409,
  RAIL_NOT_FOUND: 404,
  RAIL_UNAVAILABLE: 502,
  PAYMENT_PENDING: 202,
  // merchant policy (M1): the merchant forbids this sale, or pauses it for a human.
  POLICY_SUSPENDED: 403,
  POLICY_ITEM_EXCLUDED: 403,
  POLICY_ITEM_QUANTITY: 403,
  POLICY_ORDER_QUANTITY: 403,
  POLICY_ORDER_LIMIT: 403,
  POLICY_PERIOD_LIMIT: 403,
  POLICY_SHIPPING_COUNTRY: 403,
  POLICY_APPROVAL_REQUIRED: 403,
  // human approvals (M2)
  APPROVAL_NOT_FOUND: 404,
  APPROVAL_UNAUTHORIZED: 401,
  APPROVAL_REJECTED: 403,
  APPROVAL_EXPIRED: 410,
  APPROVAL_SNAPSHOT_CHANGED: 409,
  // verifiable receipts (M4)
  RECEIPT_NOT_FOUND: 404,
  // merchant API (Cloud foundation): the owner token is missing or wrong.
  MERCHANT_UNAUTHORIZED: 401,
  // agent identity (M3): 401 when the caller failed to prove who it is, 403 when it proved it
  // and the answer is still no.
  AGENT_IDENTITY_REQUIRED: 401,
  AGENT_SIGNATURE_INVALID: 401,
  AGENT_TIMESTAMP_OUT_OF_WINDOW: 401,
  AGENT_NONCE_REUSED: 401,
  AGENT_ATTESTATION_INVALID: 403,
  AGENT_REVOKED: 403,
  AGENT_NOT_FOUND: 404,
};

function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof AgentPOSError) {
    // details may carry bigint money values: serialize through the bigint-safe encoder.
    return c.body(
      jsonStringify({ error: err.toJSON() }),
      (STATUS_BY_CODE[err.code] ?? 500) as 400,
      {
        "content-type": "application/json",
      },
    );
  }
  return c.json(
    {
      error: {
        code: "INTERNAL",
        message: String(err),
        hint: "Unexpected error; check server logs.",
        retryable: true,
      },
    },
    500,
  );
}

/** Published items always carry a confirmed price; anything else is a data bug, not a user error. */
export function priceOf(item: CatalogItem): UsdcMinor {
  if (item.priceUsdc === undefined) {
    throw new AgentPOSError("INTERNAL", `Item '${item.id}' has no confirmed price`, {
      hint: "Only confirmed items can be published.",
    });
  }
  return item.priceUsdc;
}

function publicItem(item: CatalogItem, asset: string) {
  const price = priceOf(item);
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    description: item.descriptionAgent,
    url: item.url,
    ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
    attributes: item.attributes,
    price: { amount: formatUsdc(price), asset, minor: price.toString() },
    physical: item.physical,
    stockMode: item.stockMode,
  };
}

/** Path + query exactly as sent, which is what the agent signed. */
function pathWithQuery(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

const TRACE_HEADER = "x-trace-id";
const traceOf = (c: Context): string =>
  c.req.header(TRACE_HEADER) ?? c.res.headers.get(TRACE_HEADER) ?? newTraceId();

export function createAgentPOSApp(deps: AgentPOSDeps): AgentPOSSite {
  const { site, core } = deps;
  const logger = deps.logger ?? silentLogger;
  const storage = deps.storage ?? new SiteStorage(`${site.dataDir}/agentpos.sqlite`);
  const catalog = new CatalogService(storage);
  const checkout = new CheckoutService({
    storage,
    catalog,
    connector: deps.connector,
    defaultPayTo: site.payTo,
    cartTtlMinutes: site.cartTtlMinutes,
    network: core.caip2,
    asset: core.checkoutAsset,
    assetAddress: assetAddress(core),
    fiatCurrency: site.fiatCurrency,
    policy: site.policy,
    logger,
    ...(deps.alert ? { alert: deps.alert } : {}),
  });

  // --- card rails (plan/RIELES.md) ----------------------------------------------
  // The merchant's own acquirer, with the merchant's own credentials. Absent config means the
  // store takes x402 only; nothing else changes.
  const rails = new PaymentRailRegistry(deps.rails ?? buildCardRails(site, deps));
  const cardRail = rails.list().find((r) => r.id !== X402_STELLAR_RAIL_ID);
  const base = site.basePath;
  const siteUrl = site.siteUrl.replace(/\/+$/, "");
  // Signed audit chain (M4). Declared before the approval queue so the queue can record its
  // decisions into it; assigned just below, before any request can arrive.
  let receipts: ReceiptChain | undefined;
  // Approval queue (M2). Enabled by default; a site can turn it off to refuse flagged orders
  // outright instead of parking them for a human.
  const approvals =
    deps.approvals ??
    (site.approvals.enabled
      ? new ApprovalService({
          store: storage.approvalStore(),
          ttlMinutes: site.approvals.ttlMinutes,
          links: (r) => ({
            poll: `${siteUrl}${base}/approvals/${r.id}`,
            resolve: `${siteUrl}${base}/approvals/${r.id}/resolve`,
          }),
          // Every decision enters the audit chain, including the expiry nobody made: silence is
          // a decision too, and the merchant may have to account for it.
          onEvent: (event, request) => {
            receipts?.append({
              event: event === "requested" ? "approval.requested" : "approval.resolved",
              at: new Date().toISOString(),
              cart: { id: request.cartId },
              terms: {
                lines: request.snapshot.lines,
                totalMinor: request.snapshot.totalMinor,
                payTo: request.snapshot.payTo,
                network: core.caip2,
                asset: core.checkoutAsset,
                assetAddress: assetAddress(core),
              },
              policy: {
                decision: "requires_approval",
                code: request.snapshot.policy.code,
                message: request.snapshot.policy.message,
                evaluatedAt: request.createdAt,
              },
              approval: {
                id: request.id,
                status: request.status,
                snapshotHash: request.snapshotHash,
                ...(request.resolvedAt ? { resolvedAt: request.resolvedAt } : {}),
                ...(request.reason ? { reason: request.reason } : {}),
              },
              adapterVersion: ADAPTER_VERSION,
            });
          },
          logger,
        })
      : undefined);
  checkout.setApprovals(approvals);

  if (site.receipts.enabled) {
    const signer = deps.receiptSecret
      ? { secret: deps.receiptSecret }
      : loadOrCreateReceiptSigner(site.dataDir);
    receipts =
      deps.receipts ??
      new ReceiptChain({
        store: storage.receiptStore(),
        signerSecret: signer.secret,
        storeName: site.displayName,
        storeUrl: siteUrl,
        logger,
      });
  } else {
    receipts = deps.receipts;
  }
  checkout.setReceipts(receipts);
  // Know Your Agent (M3). The registry lives in the merchant's own database: no directory to
  // sign up with, and a revocation takes effect on the next request.
  const identity =
    deps.identity ??
    new IdentityService({
      mode: site.identity.mode,
      agents: storage.agentStore(),
      siteHost: new URL(siteUrl).host,
      autoRegister: site.identity.autoRegister,
      logger,
    });
  setInterval(() => identity.sweepNonces(), 60_000).unref();
  const routes: SiteRoutes = {
    manifest: `${siteUrl}/.well-known/ucp`,
    catalog: `${siteUrl}${base}/catalog`,
    feed: `${siteUrl}${base}/feed`,
    mcp: `${siteUrl}${base}/mcp`,
    cart: `${siteUrl}${base}/cart`,
    checkout: `${siteUrl}${base}/checkout?cart=<cartId>`,
    checkoutCard: `${siteUrl}${base}/checkout/card?cart=<cartId>`,
    orders: `${siteUrl}${base}/orders/<orderId>`,
    approvals: `${siteUrl}${base}/approvals/<approvalId>`,
    receipts: `${siteUrl}${base}/orders/<orderId>/receipt`,
    metrics: `${siteUrl}${base}/metrics`,
    dashboard: `${siteUrl}${base}/dashboard`,
    health: `${siteUrl}${base}/health`,
  };

  // --- x402 resource server with settlement hooks ---------------------------
  // Facilitator failover (operational continuity): with the default single facilitator this is
  // exactly the pre-failover path (core builds the one HTTP client, no probes, no retries).
  // Only an explicit pool (config `facilitators`, fallback env vars, or injected endpoints)
  // routes through the FailoverFacilitator.
  const facilitatorEndpoints = deps.facilitators ?? resolveFacilitatorEndpoints(site, core);
  const primaryEndpoint = facilitatorEndpoints[0] as FacilitatorEndpoint;
  const primaryIsCoreDefault =
    facilitatorEndpoints.length === 1 &&
    primaryEndpoint.url === core.facilitatorUrl &&
    primaryEndpoint.apiKeys.join(",") === core.facilitatorApiKeys.join(",");
  const failover =
    deps.facilitator || primaryIsCoreDefault
      ? undefined
      : new FailoverFacilitator({
          endpoints: facilitatorEndpoints,
          network: core.caip2,
          logger,
          ...(deps.facilitatorClientFactory ? { createClient: deps.facilitatorClientFactory } : {}),
        });
  const resourceServer = createResourceServer(core, deps.facilitator ?? failover);
  const cartIdFrom = (transport: unknown): string | undefined => {
    const t = transport as HTTPTransportContext | undefined;
    const value = t?.request?.adapter?.getQueryParam?.("cart");
    return typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
  };
  resourceServer.onAfterSettle(async (ctx) => {
    const cartId = cartIdFrom(ctx.transportContext);
    if (!cartId) {
      logger.error("settle.without_cart", { txHash: ctx.result.transaction });
      return;
    }
    try {
      const receipt = toReceipt(ctx.result as never);
      const req = ctx.requirements;
      const order = await checkout.markPaid(cartId, receipt, {
        payTo: req.payTo,
        asset: req.asset,
        amountMinor: usdcFromMinor(req.amount),
        network: req.network,
      });
      logger.info("settle.processed", {
        traceId: order.traceId,
        cartId,
        orderId: order.id,
        txHash: receipt.txHash,
        status: order.status,
        hold: order.hold?.reason,
        externalOrderId: order.externalOrderId,
      });
    } catch (err) {
      logger.error("settle.after_hook_failed", {
        cartId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  resourceServer.onSettleFailure(async (ctx) => {
    const cartId = cartIdFrom(ctx.transportContext);
    if (cartId) await checkout.markSettlementFailed(cartId, ctx.error.message);
  });

  // --- rate limits (G1) --------------------------------------------------------
  const rl = site.rateLimit;
  const ipCartLimiter = new TokenBucketLimiter({
    perMinute: rl.cartPerMinutePerIp,
    burst: rl.burst,
  });
  const ipCheckoutLimiter = new TokenBucketLimiter({
    perMinute: rl.checkoutPerMinutePerIp,
    burst: rl.burst,
  });
  const cartAttemptLimiter = new TokenBucketLimiter({
    perMinute: rl.checkoutAttemptsPerCart,
    burst: 0,
  });
  const merchantApiLimiter = new TokenBucketLimiter({
    perMinute: rl.merchantApiPerMinute,
    burst: rl.burst,
  });
  setInterval(() => {
    ipCartLimiter.sweep();
    ipCheckoutLimiter.sweep();
    cartAttemptLimiter.sweep();
    merchantApiLimiter.sweep();
  }, 60_000).unref();

  // --- facilitator health (cached) ------------------------------------------------
  let facilitatorHealth: FacilitatorHealth | undefined;
  let healthCheckedAt = 0;
  const healthFetch = deps.healthFetch ?? globalThis.fetch;
  const facilitatorStatus = async (): Promise<FacilitatorHealth> => {
    if (!facilitatorHealth || Date.now() - healthCheckedAt > 60_000) {
      facilitatorHealth = await checkFacilitator(core, healthFetch);
      healthCheckedAt = Date.now();
    }
    return facilitatorHealth;
  };

  const app = new Hono();

  app.onError((err, c) => {
    logger.error("http.error", {
      traceId: c.res.headers.get(TRACE_HEADER),
      path: c.req.path,
      error: err.message,
      code: err instanceof AgentPOSError ? err.code : undefined,
    });
    return errorResponse(c, err);
  });

  // trace id on every request/response
  app.use("*", async (c, next) => {
    const id = c.req.header(TRACE_HEADER)?.slice(0, 64) ?? newTraceId();
    c.header(TRACE_HEADER, id);
    await next();
  });
  app.use(
    `${base}/*`,
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json(
          {
            error: {
              code: "CONFIG_INVALID",
              message: "Body too large",
              hint: `Max ${MAX_BODY_BYTES} bytes`,
              retryable: false,
            },
          },
          413,
        ),
    }),
  );

  // --- discovery surfaces ----------------------------------------------------
  app.get("/.well-known/ucp", (c) =>
    c.json(
      buildUcpProfile({
        siteUrl,
        basePath: base,
        network: core.caip2,
        asset: core.checkoutAsset,
        assetAddress: assetAddress(core),
        payTo: site.payTo,
        ...(cardRail ? { rails: [cardRail.describe()] } : {}),
        ...(site.policies ? { policies: site.policies } : {}),
      }),
    ),
  );

  // Discovery document (G3). The ecosystem's crawlers look for `{origin}/openapi.json` first and
  // fall back to the runtime 402, so it is served at the site root as well as under the base path.
  const openApiDocument = () => {
    const items = catalog.published();
    const prices = items
      .map((i) => i.priceUsdc)
      .filter((p): p is UsdcMinor => p !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return buildStoreOpenApi({
      siteUrl,
      basePath: base,
      displayName: site.displayName,
      network: core.caip2,
      asset: core.checkoutAsset,
      assetAddress: assetAddress(core),
      publishedItems: items.length,
      receipts: receipts !== undefined && site.receipts.publicOrderReceipts,
      approvals: approvals !== undefined,
      ...(site.policies?.contact?.includes("@") ? { contactEmail: site.policies.contact } : {}),
      ...(prices.length > 0
        ? {
            priceRangeUsd: {
              min: formatUsdc(prices[0] as UsdcMinor),
              max: formatUsdc(prices[prices.length - 1] as UsdcMinor),
            },
          }
        : {}),
    });
  };
  app.get("/openapi.json", (c) => c.json(openApiDocument()));
  app.get(`${base}/openapi.json`, (c) => c.json(openApiDocument()));

  // llms.txt: the plain-text convention the x402 directories read. Same facts as the OpenAPI
  // document, in the form an agent can act on without parsing a schema.
  app.get("/llms.txt", (c) => {
    const items = catalog.published();
    const lines = [
      `# ${site.displayName}`,
      "",
      `> An agent-buyable storefront. Pay with x402 on ${core.caip2}, settled in ${core.checkoutAsset}. No accounts, no API keys. The merchant is the merchant of record.`,
      "",
      "## Buy something",
      "",
      `1. GET ${siteUrl}${base}/catalog          what is for sale, with prices`,
      `2. POST ${siteUrl}${base}/cart            {"items":[{"itemId":"...","quantity":1}]} -> a quote`,
      `3. POST ${siteUrl}${base}/checkout?cart=<cartId>   answers 402; pay and repeat`,
      `4. GET ${siteUrl}${base}/orders/<orderId>  status, tx hash and the merchant's order id`,
      "",
      "The price is per cart, not per call. Physical items need a shipping address and a buyer email at step 2.",
      "",
      "## Machine-readable",
      "",
      `- OpenAPI: ${siteUrl}/openapi.json`,
      `- UCP business profile: ${siteUrl}/.well-known/ucp`,
      `- ACP product feed: ${siteUrl}${base}/feed`,
      `- MCP endpoint: ${siteUrl}${base}/mcp`,
      `- Health: ${siteUrl}${base}/health`,
      ...(receipts && site.receipts.publicOrderReceipts
        ? [`- Signed receipt per order: ${siteUrl}${base}/orders/<orderId>/receipt`]
        : []),
      "",
      "## Notes",
      "",
      `- Items published: ${items.length}`,
      ...(approvals
        ? [
            "- Large orders may answer 202 and wait for a human. Nothing is charged while you wait; poll the approval URL.",
          ]
        : []),
      "- Every refusal carries a machine-readable code and an actionable hint. Read it before retrying.",
      `- Powered by AgentPOS (Apache-2.0), adapter ${ADAPTER_VERSION}.`,
      "",
    ];
    return c.text(`${lines.join("\n")}`);
  });

  // Aggregated public metrics (G2). Counts and totals only: publishable without publishing
  // anyone's customers. `?days=` bounds the window; the default is 30. CORS is open on purpose:
  // the payload is aggregates by construction, and a browser page (the store's own dashboard,
  // or anyone verifying our traction claims) must be able to read it cross-origin.
  app.get(`${base}/metrics`, (c) => {
    c.header("access-control-allow-origin", "*");
    const days = Math.min(365, Math.max(1, Number(c.req.query("days") ?? 30) || 30));
    const now = new Date();
    const metrics = storage.publicMetrics(new Date(now.getTime() - days * 86_400_000), now);
    return c.json({
      store: { name: site.displayName, url: siteUrl },
      network: core.caip2,
      asset: core.checkoutAsset,
      windowDays: days,
      ...metrics,
      total: formatUsdc(usdcFromMinor(metrics.totalMinor)),
      byDay: metrics.byDay.map((d) => ({
        ...d,
        total: formatUsdc(usdcFromMinor(d.totalMinor)),
      })),
      note: "Aggregates only. No buyer data, no addresses, no order ids. Latency is checkout to platform order.",
    });
  });

  // The store's own dashboard: a self-contained page rendering /metrics, served from the
  // store's domain. The traction artifact is "my store sells to agents" on THEIR url, not a
  // central page of ours (guardrail 7).
  const dashboardHtml = buildDashboardHtml({
    displayName: site.displayName,
    basePath: base,
    siteUrl,
    locale: site.locale,
    network: core.caip2,
    asset: core.checkoutAsset,
  });
  app.get(`${base}/dashboard`, (c) => c.html(dashboardHtml));

  // The rules the store enforces on agents, for the Rules tab of the dashboard. Shared with the
  // merchant API (`/api/merchant/rules`), so the two views can never drift; see buildRulesView
  // for why exposing this adds no attack surface.
  app.get(`${base}/dashboard/rules`, (c) => c.json(buildRulesView(site, core)));

  // The reconciliation export (buyer emails, order ids, transaction hashes) is NOT served from
  // this path. It is private merchant data and lives behind the owner token, at
  // `{base}/api/merchant/export.csv`; see merchant-api.ts. Everything else under /dashboard is
  // deliberately public (aggregates, the published catalog, the rules agents are held to).

  // Per-facilitator report: host only, never URLs beyond the host and never API keys.
  // With a pool the store is healthy while ANY facilitator can take payments (that is the
  // point of failover); the entries say which one is degraded and which one is active.
  // Shared by /health and the merchant API summary, so both report the same picture.
  const facilitatorReport = async (): Promise<{
    facilitator: FacilitatorHealth;
    pool: Array<Record<string, unknown>>;
  }> => {
    if (failover) {
      const health = await failover.health();
      const active = health.endpoints[health.active];
      return {
        facilitator: {
          ok: health.endpoints.some((e) => e.status === "ok"),
          status: undefined,
          supportsNetwork: active?.status === "ok",
          checkedAt: active?.checkedAt ?? new Date().toISOString(),
        },
        pool: health.endpoints.map((e) => ({ ...e })),
      };
    }
    const facilitator = await facilitatorStatus();
    return {
      facilitator,
      pool: [
        {
          host: new URL(primaryEndpoint.url).host,
          status: facilitator.ok ? "ok" : "degraded",
          active: true,
          checkedAt: facilitator.checkedAt,
        },
      ],
    };
  };

  app.get(`${base}/health`, async (c) => {
    const stuck = checkout.stuckOrders().length;
    const { facilitator, pool } = await facilitatorReport();
    const ok = facilitator.ok && stuck === 0;
    return c.json(
      {
        ok,
        name: site.displayName,
        adapterVersion: ADAPTER_VERSION,
        network: core.caip2,
        asset: core.checkoutAsset,
        facilitator,
        facilitators: pool,
        orders: { stuck },
        // The key third parties check this store's receipts against (M4).
        ...(receipts
          ? { receipts: { signer: receipts.signer, chainHeight: receipts.head()?.body.seq ?? 0 } }
          : {}),
      },
      ok ? 200 : 503,
    );
  });

  // Structured, attribute-aware search. `q` still works on its own; `attr.<name>=<value>`,
  // price bounds, `physical`, `inStock`, `limit` and `offset` combine with it and with each
  // other. `facets` reports the options of everything matching the request EXCEPT its attribute
  // filters, so an agent discovers that "Passepartout" can be "con" or "sin" without being told.
  app.get(`${base}/catalog`, (c) => {
    const result = catalog.query(parseCatalogQuery(new URL(c.req.url).searchParams));
    return c.json({
      adapterVersion: ADAPTER_VERSION,
      site: { name: site.displayName, url: siteUrl },
      payment: {
        protocol: "x402",
        network: core.caip2,
        asset: core.checkoutAsset,
        assetAddress: assetAddress(core),
        checkout: routes.checkout,
      },
      items: result.items.map((i) => publicItem(i, core.checkoutAsset)),
      facets: result.facets,
      page: {
        limit: result.limit,
        offset: result.offset,
        returned: result.items.length,
        total: result.total,
      },
    });
  });

  app.get(`${base}/items/:id`, (c) =>
    c.json(publicItem(catalog.getPublished(c.req.param("id").slice(0, 128)), core.checkoutAsset)),
  );

  // ACP feed: fiat prices (ISO 4217 minor units) as the schema requires; items without a fiat
  // source price are listed without price. USDC terms live in the UCP handler and /catalog.
  app.get(`${base}/feed`, (c) => {
    c.header("X-AgentPOS-Adapter", ADAPTER_VERSION);
    return c.json(
      buildAcpFeed(
        catalog.published().map((i) => ({
          id: i.id,
          title: i.title,
          description: i.descriptionAgent,
          url: i.url,
          ...(i.imageUrl ? { imageUrl: i.imageUrl } : {}),
          ...(i.priceSrc && /^[A-Za-z]{3}$/.test(i.priceSrc.currency)
            ? { priceSrc: i.priceSrc }
            : {}),
          available: true,
        })),
      ),
    );
  });

  // --- cart ------------------------------------------------------------------
  app.post(`${base}/cart`, rateLimit(ipCartLimiter, clientIp, "cart"), async (c) => {
    // Raw body, exactly as received: the agent signed its hash, so parsing must not come first.
    const raw = await c.req.text().catch(() => "");
    let agent: AgentIdentity;
    try {
      agent = identity.authenticate((name) => c.req.header(name), {
        method: "POST",
        path: pathWithQuery(c.req.url),
        url: c.req.url,
        body: raw,
      });
    } catch (err) {
      return errorResponse(c, err);
    }
    const body = createCartSchema.safeParse(safeJson(raw));
    if (!body.success) {
      return c.json(
        {
          error: {
            code: "CONFIG_INVALID",
            message: "Invalid cart body",
            hint: "Send { items: [{ itemId, quantity }], buyer?, shipping? }",
            retryable: false,
            details: { issues: body.error.issues },
          },
        },
        400,
      );
    }
    const cart = await checkout.createCart(
      body.data.items,
      body.data.buyer,
      body.data.shipping,
      traceOf(c),
      agent,
    );
    return c.json(cartView(cart, core, routes, cardRail), 201);
  });

  app.get(`${base}/cart/:id`, (c) =>
    c.json(cartView(checkout.getCart(c.req.param("id").slice(0, 64)), core, routes, cardRail)),
  );

  // --- checkout (x402 protected) --------------------------------------------
  // 1. Rate limits, then validate and RE-QUOTE the cart before the payment middleware, so agents
  //    get precise errors (404/410/409) instead of a 402, and no stale terms ever reach settle.
  app.use(`${base}/checkout`, rateLimit(ipCheckoutLimiter, clientIp, "checkout"));
  app.use(`${base}/checkout`, async (c, next) => {
    if (c.req.method !== "POST")
      return c.json(
        {
          error: {
            code: "CONFIG_INVALID",
            message: "Use POST",
            hint: routes.checkout,
            retryable: false,
          },
        },
        405,
      );
    const cartId = c.req.query("cart")?.slice(0, 64);
    if (!cartId)
      return c.json(
        {
          error: {
            code: "CART_NOT_FOUND",
            message: "Missing ?cart=<cartId>",
            hint: routes.checkout,
            retryable: false,
          },
        },
        400,
      );
    const wait = cartAttemptLimiter.take(cartId);
    if (wait > 0) {
      c.header("Retry-After", String(wait));
      return c.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Too many checkout attempts for this cart",
            hint: `Wait ${wait}s; if payment keeps failing create a new cart.`,
            retryable: true,
          },
        },
        429,
      );
    }
    try {
      // Identity was established when the cart was quoted; here we only re-read the registry, so
      // a key revoked in between cannot pay (M3).
      identity.recheck(checkout.getCart(cartId).agent);
      const gate = await checkout.gateForPayment(cartId);
      if (gate.status === "pending_approval") {
        // 202: accepted, waiting on a human. No 402 is issued, so the agent is never charged
        // for an order the merchant has not approved.
        return c.json(
          {
            status: "pending_approval",
            approvalId: gate.approval.id,
            summary: describeApproval(gate.approval),
            expiresAt: gate.approval.expiresAt,
            poll: `${siteUrl}${base}/approvals/${gate.approval.id}`,
            message: gate.approval.snapshot.policy.message,
            hint: "Nothing was charged. Poll the approval; if it is approved, POST this checkout again to pay.",
          },
          202,
        );
      }
    } catch (err) {
      return errorResponse(c, err);
    }
    await next();
  });

  // 2. x402: price and payTo come from the cart (dynamic), asset from config, amounts stay integers.
  app.use(
    `${base}/checkout`,
    paymentMiddleware(
      {
        [`POST ${base}/checkout`]: {
          accepts: [
            {
              scheme: "exact",
              network: core.caip2,
              payTo: (ctx) =>
                checkout.getCart(String(ctx.adapter.getQueryParam?.("cart"))).quote.payTo,
              price: (ctx) => ({
                asset: assetAddress(core),
                amount: checkout
                  .getCart(String(ctx.adapter.getQueryParam?.("cart")))
                  .quote.totalUsdc.toString(),
              }),
              maxTimeoutSeconds: 300,
              extra: { adapterVersion: ADAPTER_VERSION },
            },
          ],
          description: `${site.displayName}: pay for a cart. Create one at ${routes.cart}.`,
          mimeType: "application/json",
        },
      },
      resourceServer,
      undefined,
      undefined,
      true,
    ),
  );

  // 3. Handler runs after verify and before settle: register the pending order only.
  app.post(`${base}/checkout`, (c) => {
    const cartId = String(c.req.query("cart"));
    const order = checkout.beginOrder(cartId);
    return c.json({
      orderId: order.id,
      status: "pending_settlement",
      hint: "Settlement runs right after this response; read PAYMENT-RESPONSE for the tx hash and poll the order.",
      order: `${siteUrl}${base}/orders/${order.id}`,
    });
  });

  // --- card checkout: the same cart, paid on the merchant's own acquirer -----------------
  // Mounted only when the store declares a card rail. Two shapes:
  //  - no body: Webpay Plus. The rail creates the transaction and the response carries the page
  //    the HUMAN must visit; the agent cannot fill a card form. The store settles on return.
  //  - { enrolment }: Oneclick. The buyer enrolled a card once; the store charges it now, with no
  //    human step. This is the mode in which the agent buys on its own.
  if (cardRail) {
    const cardTerms = (order: Order) => order.rail?.terms as TransbankTerms | undefined;
    const settledTermsOf = (cart: Cart, network: string): SettledTerms => {
      const fiat = cart.quote.totalFiat as FiatAmount;
      return {
        payTo: cart.quote.payTo,
        asset: fiat.currency,
        amountMinor: usdcFromMinor(fiat.minor),
        network,
        rail: cardRail.id,
        decimals: fiat.decimals,
      };
    };
    // Turns a rail settlement into the order lifecycle: paid (and pushed to the platform), or
    // failed. Exactly the two outcomes the x402 hooks produce (guardrail 6).
    const applySettlement = async (cart: Cart, settlement: RailSettlement) => {
      if (!settlement.settled) {
        await checkout.markSettlementFailed(cart.id, settlement.failure?.message ?? "not settled");
        throw railFailureToError(
          settlement.failure ?? {
            kind: "rejected",
            code: "SETTLEMENT_FAILED",
            message: "The card rail did not settle",
            hint: "Nothing was charged. Retry the card step or pay with x402.",
            retryable: false,
          },
          cardRail.id,
        );
      }
      const amount = settlement.amount?.minor;
      return checkout.markPaid(
        cart.id,
        {
          txHash: settlement.reference,
          network: (settlement.raw as { environment?: string } | undefined)?.environment
            ? `transbank:${(settlement.raw as { environment: string }).environment}`
            : (cardRail.describe().capabilities.networks[0] as string),
          payer: settlement.payer,
          amount: amount === undefined ? undefined : usdcFromMinor(amount),
          adapterVersion: ADAPTER_VERSION,
        },
        settledTermsOf(cart, cardRail.describe().capabilities.networks[0] as string),
      );
    };

    app.post(
      `${base}/checkout/card`,
      rateLimit(ipCheckoutLimiter, clientIp, "checkout"),
      async (c) => {
        try {
          const cartId = String(c.req.query("cart"));
          const cart = checkout.getCart(cartId);
          const fiat = cart.quote.totalFiat;
          if (!fiat) {
            throw new AgentPOSError("RAIL_UNSUPPORTED", "This cart has no fiat quote", {
              hint: "Every item must carry a source price in the store's currency to be paid by card. Pay with x402 instead.",
              details: { cartId, rail: cardRail.id },
            });
          }
          const body = (await c.req.json().catch(() => ({}))) as {
            enrolment?: { username?: string; tbkUser?: string };
          };
          const amount = { minor: fiat.minor, currency: fiat.currency, decimals: fiat.decimals };
          const network = cardRail.describe().capabilities.networks[0] as string;

          if (body.enrolment?.username && body.enrolment.tbkUser) {
            // Oneclick: quote is pure, settle charges the enrolled card. No human in the loop.
            const rail = cardRail as unknown as {
              quoteOneclick: (i: RailQuoteInput) => RailQuote<TransbankTerms>;
            };
            const quote = rail.quoteOneclick({
              payTo: cart.quote.payTo,
              amount,
              reference: cart.id,
            });
            checkout.beginOrderOnRail(cart.id, { id: cardRail.id, terms: quote.terms });
            const settlement = await cardRail.settle(
              {
                mode: "oneclick",
                username: body.enrolment.username,
                tbkUser: body.enrolment.tbkUser,
              },
              quote.terms,
            );
            const order = await applySettlement(cart, settlement);
            return c.json({ ...orderView(order), order: `${siteUrl}${base}/orders/${order.id}` });
          }

          // Webpay Plus: create the transaction; the human pays on the rail's page and returns.
          const returnUrl = `${siteUrl}${base}/checkout/card/return?cart=${encodeURIComponent(cart.id)}`;
          const quote = await cardRail.quote({ payTo: returnUrl, amount, reference: cart.id });
          const order = checkout.beginOrderOnRail(cart.id, { id: cardRail.id, terms: quote.terms });
          const terms = quote.terms as TransbankTerms;
          if (terms.mode !== "webpay-plus") {
            throw new AgentPOSError("INTERNAL", "Card rail quoted unexpected terms", {
              hint: "Report this; the store's card rail is misconfigured.",
            });
          }
          return c.json(
            {
              orderId: order.id,
              status: "pending_payment",
              rail: cardRail.id,
              currency: fiat.currency,
              totalMinor: fiat.minor.toString(),
              network,
              pay: {
                // The human is sent here, POSTing the token as `token_ws` (Transbank's contract).
                url: terms.url,
                method: "POST",
                form: { token_ws: terms.token },
                expiresInSeconds: quote.expiresInSeconds,
              },
              hint: "Hand `pay` to the person. When they finish, the store settles and creates the order; poll `order` until status is paid.",
              order: `${siteUrl}${base}/orders/${order.id}`,
            },
            202,
          );
        } catch (err) {
          return errorResponse(c, err);
        }
      },
    );

    // The human comes back from the acquirer's page. Verify the token belongs to this order,
    // settle exactly once, and answer in the shape the visitor is: a browser gets a page, an
    // agent (Accept: application/json) gets the order.
    const cardReturn = async (c: Context) => {
      const cartId = String(c.req.query("cart"));
      let token = c.req.query("token_ws");
      let aborted = c.req.query("TBK_TOKEN") !== undefined;
      if (c.req.method === "POST") {
        const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
        token = (form as Record<string, string>).token_ws ?? token;
        aborted = aborted || (form as Record<string, string>).TBK_TOKEN !== undefined;
      }
      const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
      try {
        const cart = checkout.getCart(cartId);
        const order = checkout.beginOrder(cart.id);
        const terms = cardTerms(order);
        if (!terms || terms.mode !== "webpay-plus") {
          throw new AgentPOSError("ORDER_NOT_FOUND", "No card payment was started for this cart", {
            hint: "Start with POST checkout/card?cart=<cartId>.",
          });
        }
        if (aborted || !token) {
          await checkout.markSettlementFailed(cart.id, "buyer aborted the card payment");
          throw new AgentPOSError(
            "SETTLEMENT_FAILED",
            "The buyer did not complete the card payment",
            {
              hint: "Nothing was charged. Start a new card checkout or pay with x402.",
            },
          );
        }
        if (order.status === "paid" || order.payment) {
          const done = checkout.getOrder(order.id);
          return wantsJson
            ? c.json(orderView(done))
            : c.html(cardResultPage(done, site.displayName));
        }
        const verification = await cardRail.verify({ mode: "webpay-plus", token }, terms);
        if (!verification.ok) throw railFailureToError(verification.failure, cardRail.id);
        const settlement = await cardRail.settle({ mode: "webpay-plus", token }, terms);
        const paid = await applySettlement(cart, settlement);
        return wantsJson ? c.json(orderView(paid)) : c.html(cardResultPage(paid, site.displayName));
      } catch (err) {
        if (wantsJson) return errorResponse(c, err);
        const e = err as { code?: string; message?: string; hint?: string };
        return c.html(
          cardErrorPage(e.code ?? "INTERNAL", e.message ?? "", e.hint ?? "", site.displayName),
          400,
        );
      }
    };
    app.get(`${base}/checkout/card/return`, cardReturn);
    app.post(`${base}/checkout/card/return`, cardReturn);
  }

  // --- approvals (M2) --------------------------------------------------------
  if (approvals) {
    // Polling endpoint for the agent: status only, no buyer data.
    app.get(`${base}/approvals/:id`, (c) => {
      const request = approvals.get(c.req.param("id").slice(0, 64));
      return c.json({
        approvalId: request.id,
        cartId: request.cartId,
        status: request.status,
        summary: describeApproval(request),
        snapshotHash: request.snapshotHash,
        expiresAt: request.expiresAt,
        resolvedAt: request.resolvedAt,
        reason: request.reason,
        ...(request.status === "approved"
          ? { next: `${siteUrl}${base}/checkout?cart=${request.cartId}` }
          : {}),
      });
    });

    // The merchant decides. Signed with the shared secret: an approval is their word, and
    // nothing else may speak it.
    app.post(`${base}/approvals/:id/resolve`, async (c) => {
      const id = c.req.param("id").slice(0, 64);
      const body = z
        .object({ decision: z.enum(["approve", "reject"]), reason: z.string().max(500).optional() })
        .safeParse(await c.req.json().catch(() => ({})));
      if (!body.success) {
        return c.json(
          {
            error: {
              code: "CONFIG_INVALID",
              message: "Invalid resolution body",
              hint: 'Send { "decision": "approve" | "reject", "reason"?: string }',
              retryable: false,
            },
          },
          400,
        );
      }
      if (!deps.approvalSecret) {
        return c.json(
          {
            error: {
              code: "APPROVAL_UNAUTHORIZED",
              message: "This store cannot verify resolutions",
              hint: "Set AGENTPOS_APPROVAL_SECRET on the sidecar and sign with it.",
              retryable: false,
            },
          },
          401,
        );
      }
      try {
        assertValidResolutionSignature({
          secret: deps.approvalSecret,
          timestamp: c.req.header(TIMESTAMP_HEADER),
          signature: c.req.header(SIGNATURE_HEADER),
          approvalId: id,
          decision: body.data.decision,
        });
      } catch (err) {
        return errorResponse(c, err);
      }
      const resolved = approvals.resolve(id, body.data.decision, body.data.reason);
      return c.json({
        approvalId: resolved.id,
        status: resolved.status,
        resolvedAt: resolved.resolvedAt,
        reason: resolved.reason,
      });
    });
  }

  // --- orders ----------------------------------------------------------------
  app.get(`${base}/orders/:id`, (c) =>
    c.json(orderView(checkout.getOrder(c.req.param("id").slice(0, 64)))),
  );

  // --- receipts (M4) ---------------------------------------------------------
  if (receipts && site.receipts.publicOrderReceipts) {
    const chain = receipts;
    // The buyer's copy. Handed out whole, signature included, so the agent (or the human behind
    // it) can verify it later without asking us anything.
    app.get(`${base}/orders/:id/receipt`, (c) => {
      const orderId = c.req.param("id").slice(0, 64);
      // 404 on an unknown order comes from getOrder, so an existing order with no receipt is
      // distinguishable from an order that never existed.
      checkout.getOrder(orderId);
      const found = chain.forOrder(orderId);
      if (found.length === 0) {
        return errorResponse(
          c,
          new AgentPOSError("RECEIPT_NOT_FOUND", `No receipt for order '${orderId}' yet`, {
            hint: "Receipts are written when a payment settles; poll the order until it is paid.",
            retryable: true,
          }),
        );
      }
      return c.json({
        receipts: found,
        verification: verifyChain(found),
        howToVerify:
          "Recompute sha256 over the canonical JSON of `body` and check `signature` against `body.store.signer` (Ed25519). See packages/receipts/SPEC.md.",
      });
    });

    app.get(`${base}/receipts/:hash`, (c) => {
      const hash = c.req.param("hash").slice(0, 64);
      const receipt = chain.get(hash);
      if (!receipt) {
        return errorResponse(
          c,
          new AgentPOSError("RECEIPT_NOT_FOUND", `No receipt with hash '${hash}'`, {
            hint: "Receipt hashes come from the order receipt or the store's audit export.",
          }),
        );
      }
      return c.json({ receipt, verification: verifyReceipt(receipt) });
    });
  }

  // --- merchant API (read-only; AgentPOS Cloud foundation) -------------------
  // Mounted only when the store owner's token is configured; see merchant-api.ts for why the
  // surface is read-only by design.
  if (deps.merchantApiToken !== undefined) {
    registerMerchantApi(app, {
      token: deps.merchantApiToken,
      base,
      siteUrl,
      site,
      core,
      storage,
      checkout,
      receipts,
      facilitatorReport,
      limiter: merchantApiLimiter,
      logger,
    });
  }

  // --- MCP -------------------------------------------------------------------
  const mcp = createMcpHandler({ site, core, catalog, checkout, routes });
  app.all(`${base}/mcp`, (c) => mcp(c.req.raw));

  return {
    app,
    fetch: (request) => Promise.resolve(app.fetch(request)),
    storage,
    catalog,
    checkout,
    logger,
    approvals,
    identity,
    receipts,
    routes,
  };
}

/**
 * Card rails from configuration: the merchant's Transbank affiliation, with the merchant's own
 * credentials from the environment. Nothing is built without both the config block and the
 * credentials, so a store that takes no cards runs exactly as before.
 */
export function buildCardRails(
  site: SiteConfig,
  creds: { transbankCommerceCode?: string | undefined; transbankApiKey?: string | undefined },
): PaymentRail[] {
  const tb = site.transbank;
  if (!tb || !creds.transbankCommerceCode || !creds.transbankApiKey) return [];
  return [
    createTransbankRail({
      environment: tb.environment,
      commerceCode: creds.transbankCommerceCode,
      apiKey: creds.transbankApiKey,
      oneclick: tb.oneclick,
      maxAmountClp: tb.maxAmountClp === undefined ? undefined : BigInt(tb.maxAmountClp),
    }),
  ];
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string,
  );
}

/** What the person sees after paying by card. Plain, no scripts, no tracking. */
function cardResultPage(order: Order, storeName: string): string {
  const paid = order.status === "paid" || order.status === "fulfilled";
  const title = paid ? "Pago recibido" : "Pago registrado";
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.4rem">${escapeHtml(title)}</h1>
<p>${escapeHtml(storeName)} recibió tu pago con tarjeta y ya creó la orden.</p>
<p>Número de orden: <code>${escapeHtml(order.id)}</code>${order.externalOrderId ? ` (en la tienda: <code>${escapeHtml(order.externalOrderId)}</code>)` : ""}</p>
<p style="color:#555">Puedes cerrar esta página. Tu agente ya tiene la orden.</p>
</body></html>`;
}

function cardErrorPage(code: string, message: string, hint: string, storeName: string): string {
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pago no completado</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.4rem">Pago no completado</h1>
<p>${escapeHtml(storeName)} no pudo confirmar el pago con tarjeta. No se cobró nada.</p>
<p><code>${escapeHtml(code)}</code> ${escapeHtml(message)}</p>
<p style="color:#555">${escapeHtml(hint)}</p>
</body></html>`;
}

/** The card rails a cart can be paid on, as the agent sees them: no secrets, integer amounts. */
export function paymentAlternatives(
  cart: ReturnType<CheckoutService["getCart"]>,
  cardRail: PaymentRail | undefined,
  routes: Pick<SiteRoutes, "checkoutCard">,
): unknown[] {
  const fiat = cart.quote.totalFiat;
  if (!cardRail || !fiat) return [];
  const d = cardRail.describe();
  const decision = cardRail.supports({
    currency: fiat.currency,
    amount: { minor: fiat.minor, currency: fiat.currency, decimals: fiat.decimals },
  });
  if (!decision.supported) return [];
  return [
    {
      rail: d.id,
      label: d.label,
      protocol: d.protocol,
      currency: fiat.currency,
      totalMinor: fiat.minor.toString(),
      total: formatFiat(fiat.minor, fiat.decimals),
      network: d.capabilities.networks[0],
      settlesOnLedger: d.capabilities.settlesOnLedger,
      method: "POST",
      url: routes.checkoutCard.replace("<cartId>", cart.id),
      steps: [
        "POST the url with no body: the response carries the page where the buyer pays by card",
        "Hand that page to the human; the store settles when they return and creates the order",
        "Or POST { enrolment: { username, tbkUser } } to charge a card the buyer enrolled before, with no human step",
        "Poll get_order / GET orders/:id until status is paid",
      ],
    },
  ];
}

function formatFiat(minor: bigint, decimals: number): string {
  const s = minor.toString().padStart(decimals + 1, "0");
  return decimals === 0 ? s : `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

export function cartView(
  cart: ReturnType<CheckoutService["getCart"]>,
  core: CoreConfig,
  routes: Pick<SiteRoutes, "checkout" | "checkoutCard">,
  cardRail?: PaymentRail,
) {
  const fiat = cart.quote.totalFiat;
  return JSON.parse(
    jsonStringify({
      cartId: cart.id,
      expiresAt: cart.expiresAt,
      quote: {
        lines: cart.quote.lines.map((l) => ({
          ...l,
          unitPrice: formatUsdc(l.unitPriceUsdc),
          lineTotal: formatUsdc(l.lineTotalUsdc),
        })),
        total: formatUsdc(cart.quote.totalUsdc),
        totalMinor: cart.quote.totalUsdc.toString(),
        asset: core.checkoutAsset,
        network: core.caip2,
        payTo: cart.quote.payTo,
        requiresShipping: cart.quote.requiresShipping,
        // The same cart in the store's currency, when every line has a source price in it.
        ...(fiat
          ? {
              totalFiat: {
                currency: fiat.currency,
                minor: fiat.minor.toString(),
                amount: formatFiat(fiat.minor, fiat.decimals),
              },
            }
          : {}),
      },
      checkout: routes.checkout.replace("<cartId>", cart.id),
      protocol: "x402",
      // Every way this cart can be paid, x402 first. A rail-neutral cart: same order either way.
      payments: [
        {
          rail: X402_STELLAR_RAIL_ID,
          protocol: "x402",
          currency: core.checkoutAsset,
          totalMinor: cart.quote.totalUsdc.toString(),
          total: formatUsdc(cart.quote.totalUsdc),
          network: core.caip2,
          settlesOnLedger: true,
          method: "POST",
          url: routes.checkout.replace("<cartId>", cart.id),
        },
        ...paymentAlternatives(cart, cardRail, routes),
      ],
      // Merchant policy outcome (M1): tells the agent up front whether this cart can be paid.
      policy: cart.policy,
      // What the store recorded about who is buying (M3), so the agent can see it took effect.
      agent: cart.agent,
      traceId: cart.traceId,
    }),
  ) as Record<string, unknown>;
}

export function orderView(order: ReturnType<CheckoutService["getOrder"]>) {
  return JSON.parse(
    jsonStringify({
      orderId: order.id,
      status: order.status,
      total: formatUsdc(order.quote.totalUsdc),
      lines: order.quote.lines.map((l) => ({
        itemId: l.itemId,
        title: l.title,
        quantity: l.quantity,
        ...(l.note !== undefined ? { note: l.note } : {}),
        lineTotal: formatUsdc(l.lineTotalUsdc),
      })),
      payment: order.payment,
      externalOrderId: order.externalOrderId,
      externalAdminUrl: order.externalAdminUrl,
      connectorError: order.connectorError,
      hold: order.hold,
      agent: order.agent,
      traceId: order.traceId,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    }),
  ) as Record<string, unknown>;
}
