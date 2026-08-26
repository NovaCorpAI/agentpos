/**
 * The HTTP surface of a site (SPEC 01 + 09, hardened for gate G1): discovery, catalog, cart,
 * x402 checkout, orders. Built on Hono so the same app runs as a sidecar or mounted elsewhere.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { paymentMiddleware } from "@x402/hono";
import type { HTTPTransportContext } from "@x402/core/server";
import {
  AgentGateError,
  ADAPTER_VERSION,
  assetAddress,
  addressSchema,
  buildAcpFeed,
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
} from "@agentgate/core";
import type {
  CatalogItem,
  CoreConfig,
  FacilitatorClient,
  FacilitatorHealth,
  Logger,
  OrderConnector,
  UsdcMinor,
} from "@agentgate/core";
import { z } from "zod";
import { CatalogService } from "./catalog.js";
import { CheckoutService } from "./checkout.js";
import type { AlertSink } from "./checkout.js";
import type { SiteConfig } from "./config.js";
import { createMcpHandler } from "./mcp.js";
import { TokenBucketLimiter, clientIp, rateLimit } from "./ratelimit.js";
import { SiteStorage } from "./storage.js";

export interface AgentGateDeps {
  site: SiteConfig;
  core: CoreConfig;
  connector: OrderConnector;
  storage?: SiteStorage;
  /** Tests only: stub facilitator. */
  facilitator?: FacilitatorClient;
  logger?: Logger;
  alert?: AlertSink;
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
  orders: string;
  health: string;
}

export interface AgentGateSite {
  app: Hono;
  fetch: (request: Request) => Promise<Response>;
  storage: SiteStorage;
  catalog: CatalogService;
  checkout: CheckoutService;
  logger: Logger;
  /** Route table for docs and the CLI. */
  routes: SiteRoutes;
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUERY_CHARS = 200;

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
};

function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof AgentGateError) {
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
    throw new AgentGateError("INTERNAL", `Item '${item.id}' has no confirmed price`, {
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

const TRACE_HEADER = "x-trace-id";
const traceOf = (c: Context): string =>
  c.req.header(TRACE_HEADER) ?? c.res.headers.get(TRACE_HEADER) ?? newTraceId();

export function createAgentGateApp(deps: AgentGateDeps): AgentGateSite {
  const { site, core } = deps;
  const logger = deps.logger ?? silentLogger;
  const storage = deps.storage ?? new SiteStorage(`${site.dataDir}/agentgate.sqlite`);
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
    logger,
    ...(deps.alert ? { alert: deps.alert } : {}),
  });
  const base = site.basePath;
  const siteUrl = site.siteUrl.replace(/\/+$/, "");
  const routes: SiteRoutes = {
    manifest: `${siteUrl}/.well-known/ucp`,
    catalog: `${siteUrl}${base}/catalog`,
    feed: `${siteUrl}${base}/feed`,
    mcp: `${siteUrl}${base}/mcp`,
    cart: `${siteUrl}${base}/cart`,
    checkout: `${siteUrl}${base}/checkout?cart=<cartId>`,
    orders: `${siteUrl}${base}/orders/<orderId>`,
    health: `${siteUrl}${base}/health`,
  };

  // --- x402 resource server with settlement hooks ---------------------------
  const resourceServer = createResourceServer(core, deps.facilitator);
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
  setInterval(() => {
    ipCartLimiter.sweep();
    ipCheckoutLimiter.sweep();
    cartAttemptLimiter.sweep();
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
      code: err instanceof AgentGateError ? err.code : undefined,
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
        ...(site.policies ? { policies: site.policies } : {}),
      }),
    ),
  );

  app.get(`${base}/health`, async (c) => {
    const facilitator = await facilitatorStatus();
    const stuck = checkout.stuckOrders().length;
    const ok = facilitator.ok && stuck === 0;
    return c.json(
      {
        ok,
        name: site.displayName,
        adapterVersion: ADAPTER_VERSION,
        network: core.caip2,
        asset: core.checkoutAsset,
        facilitator,
        orders: { stuck },
      },
      ok ? 200 : 503,
    );
  });

  app.get(`${base}/catalog`, (c) => {
    const q = (c.req.query("q") ?? "").slice(0, MAX_QUERY_CHARS);
    const items = q ? catalog.search(q) : catalog.published();
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
      items: items.map((i) => publicItem(i, core.checkoutAsset)),
    });
  });

  app.get(`${base}/items/:id`, (c) =>
    c.json(publicItem(catalog.getPublished(c.req.param("id").slice(0, 128)), core.checkoutAsset)),
  );

  // ACP feed: fiat prices (ISO 4217 minor units) as the schema requires; items without a fiat
  // source price are listed without price. USDC terms live in the UCP handler and /catalog.
  app.get(`${base}/feed`, (c) => {
    c.header("X-AgentGate-Adapter", ADAPTER_VERSION);
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
    const body = createCartSchema.safeParse(await c.req.json().catch(() => ({})));
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
    );
    return c.json(cartView(cart, core, routes), 201);
  });

  app.get(`${base}/cart/:id`, (c) =>
    c.json(cartView(checkout.getCart(c.req.param("id").slice(0, 64)), core, routes)),
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
      await checkout.revalidateCart(cartId);
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

  // --- orders ----------------------------------------------------------------
  app.get(`${base}/orders/:id`, (c) =>
    c.json(orderView(checkout.getOrder(c.req.param("id").slice(0, 64)))),
  );

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
    routes,
  };
}

export function cartView(
  cart: ReturnType<CheckoutService["getCart"]>,
  core: CoreConfig,
  routes: Pick<SiteRoutes, "checkout">,
) {
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
      },
      checkout: routes.checkout.replace("<cartId>", cart.id),
      protocol: "x402",
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
        lineTotal: formatUsdc(l.lineTotalUsdc),
      })),
      payment: order.payment,
      externalOrderId: order.externalOrderId,
      externalAdminUrl: order.externalAdminUrl,
      connectorError: order.connectorError,
      hold: order.hold,
      traceId: order.traceId,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    }),
  ) as Record<string, unknown>;
}
