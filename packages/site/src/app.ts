/**
 * The HTTP surface of a site (SPEC 01 + 09): discovery, catalog, cart, x402 checkout, orders.
 * Built on Hono so the same app runs as a sidecar (node-server) or mounted in Express/Next.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { paymentMiddleware } from "@x402/hono";
import type { HTTPTransportContext } from "@x402/core/server";
import {
  AgentGateError,
  ADAPTER_VERSION,
  assetAddress,
  addressSchema,
  buildAcpFeed,
  buildUcpManifest,
  buyerContactSchema,
  cartLineSchema,
  createResourceServer,
  formatUsdc,
  jsonStringify,
  toReceipt,
} from "@agentgate/core";
import type {
  CatalogItem,
  CoreConfig,
  FacilitatorClient,
  OrderConnector,
  UsdcMinor,
} from "@agentgate/core";
import { z } from "zod";
import { CatalogService } from "./catalog.js";
import { CheckoutService } from "./checkout.js";
import type { SiteConfig } from "./config.js";
import { createMcpHandler } from "./mcp.js";
import { SiteStorage } from "./storage.js";

export interface AgentGateDeps {
  site: SiteConfig;
  core: CoreConfig;
  connector: OrderConnector;
  storage?: SiteStorage;
  /** Tests only: stub facilitator. */
  facilitator?: FacilitatorClient;
  log?: (message: string) => void;
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
  /** Route table for docs and the CLI. */
  routes: SiteRoutes;
}

const createCartSchema = z.object({
  items: z.array(cartLineSchema).min(1),
  buyer: buyerContactSchema.optional(),
  shipping: addressSchema.optional(),
});

function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof AgentGateError) {
    const status =
      (
        {
          ITEM_NOT_FOUND: 404,
          ORDER_NOT_FOUND: 404,
          CART_NOT_FOUND: 404,
          CART_EXPIRED: 410,
          OUT_OF_STOCK: 409,
          ITEM_NOT_PUBLISHED: 409,
          SHIPPING_REQUIRED: 422,
          MIXED_PAYTO: 422,
          INVALID_AMOUNT: 422,
          CONFIG_INVALID: 400,
        } as Record<string, number>
      )[err.code] ?? 500;
    return c.json({ error: err.toJSON() }, status as 400);
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

export function createAgentGateApp(deps: AgentGateDeps): AgentGateSite {
  const { site, core } = deps;
  const log = deps.log ?? (() => {});
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
    log,
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
      log(`settled payment without cart id; tx=${ctx.result.transaction}`);
      return;
    }
    try {
      const receipt = toReceipt(ctx.result as never);
      const order = await checkout.markPaid(cartId, receipt);
      log(
        `cart ${cartId} paid tx=${receipt.txHash} order=${order.id} status=${order.status} external=${order.externalOrderId ?? "-"}`,
      );
    } catch (err) {
      log(
        `afterSettle failed for cart ${cartId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
  resourceServer.onSettleFailure(async (ctx) => {
    const cartId = cartIdFrom(ctx.transportContext);
    if (cartId) checkout.markSettlementFailed(cartId, ctx.error.message);
  });

  const app = new Hono();

  app.onError((err, c) => errorResponse(c, err));

  // --- discovery surfaces ----------------------------------------------------
  app.get("/.well-known/ucp", (c) =>
    c.json(
      buildUcpManifest({
        siteUrl,
        displayName: site.displayName,
        network: core.caip2,
        ...(site.policies ? { policies: site.policies } : {}),
      }),
    ),
  );

  app.get(`${base}/health`, (c) =>
    c.json({
      ok: true,
      adapterVersion: ADAPTER_VERSION,
      network: core.caip2,
      asset: core.checkoutAsset,
    }),
  );

  app.get(`${base}/catalog`, (c) => {
    const q = c.req.query("q");
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
    c.json(publicItem(catalog.getPublished(c.req.param("id")), core.checkoutAsset)),
  );

  app.get(`${base}/feed`, (c) =>
    c.json(
      buildAcpFeed(
        { name: site.displayName, url: siteUrl },
        catalog.published().map((i) => ({
          id: i.id,
          title: i.title,
          description: i.descriptionAgent,
          url: i.url,
          ...(i.imageUrl ? { imageUrl: i.imageUrl } : {}),
          priceUsdc: priceOf(i),
          availability: "in_stock" as const,
          attributes: i.attributes,
        })),
      ),
    ),
  );

  // --- cart ------------------------------------------------------------------
  app.post(`${base}/cart`, async (c) => {
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
    const cart = await checkout.createCart(body.data.items, body.data.buyer, body.data.shipping);
    return c.json(cartView(cart, core, routes), 201);
  });

  app.get(`${base}/cart/:id`, (c) =>
    c.json(cartView(checkout.getCart(c.req.param("id")), core, routes)),
  );

  // --- checkout (x402 protected) --------------------------------------------
  // 1. Validate the cart BEFORE the payment middleware so agents get precise errors, not a 402.
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
    const cartId = c.req.query("cart");
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
    try {
      checkout.getCart(cartId);
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
  app.get(`${base}/orders/:id`, (c) => c.json(orderView(checkout.getOrder(c.req.param("id")))));

  // --- MCP -------------------------------------------------------------------
  const mcp = createMcpHandler({ site, core, catalog, checkout, routes });
  app.all(`${base}/mcp`, (c) => mcp(c.req.raw));

  return {
    app,
    fetch: (request) => Promise.resolve(app.fetch(request)),
    storage,
    catalog,
    checkout,
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
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    }),
  ) as Record<string, unknown>;
}
