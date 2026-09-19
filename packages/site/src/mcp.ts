/**
 * Per-site MCP server (SPEC 09): discovery + cart tools for any MCP agent. Payment itself goes
 * through the x402 HTTP checkout (the tool returns the exact URL and terms).
 * Stateless: one McpServer + transport per request.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  AgentPOSError,
  addressSchema,
  buyerContactSchema,
  cartLineSchema,
  formatUsdc,
} from "@agentpos/core";
import type { CoreConfig } from "@agentpos/core";
import type { CatalogService } from "./catalog.js";
import { parsePriceBound } from "./catalog.js";
import type { CheckoutService } from "./checkout.js";
import { cartView, orderView, priceOf } from "./app.js";
import type { SiteRoutes } from "./app.js";
import type { SiteConfig } from "./config.js";

export interface McpDeps {
  site: SiteConfig;
  core: CoreConfig;
  catalog: CatalogService;
  checkout: CheckoutService;
  routes: SiteRoutes;
}

function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

function fail(err: unknown) {
  const body =
    err instanceof AgentPOSError
      ? err.toJSON()
      : { code: "INTERNAL", message: String(err), hint: "Unexpected error", retryable: true };
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: body }) }],
    isError: true,
  };
}

export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: `agentpos:${deps.site.displayName}`, version: "0.1.0" });

  server.registerTool(
    "search_items",
    {
      title: "Search items",
      description:
        `Search ${deps.site.displayName}'s catalog. Returns ids, prices in ${deps.core.checkoutAsset} and attributes. ` +
        "Variants are separate items carrying their options in `attributes`, so filter by them " +
        "instead of guessing from the title: `attributes` matches exactly, ignoring case and " +
        "Spanish accents. `facets` in the answer lists every value each attribute can take among " +
        "the items matching the rest of your request, so you can discover the options (for " +
        'example that "Passepartout" is "con" or "sin") and then narrow down.',
      inputSchema: {
        query: z.string().default("").describe("Free text over title, description and attributes."),
        attributes: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Exact attribute match, ANDed: { "Passepartout": "con", "Fondo": "blanco" }. Case- and accent-insensitive. An unknown attribute name matches nothing.',
          ),
        minPriceUsdc: z
          .string()
          .optional()
          .describe(
            `Lowest acceptable price, inclusive, as a decimal ${deps.core.checkoutAsset} string (e.g. "10.5").`,
          ),
        maxPriceUsdc: z
          .string()
          .optional()
          .describe(
            `Highest acceptable price, inclusive, as a decimal ${deps.core.checkoutAsset} string (e.g. "40").`,
          ),
        physical: z
          .boolean()
          .optional()
          .describe("true: goods that need a shipping address. false: digital items."),
        inStock: z
          .boolean()
          .optional()
          .describe(
            "Filter on stock as the catalog knows it; items with untracked stock count as in stock.",
          ),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
      },
    },
    async ({ query, attributes, minPriceUsdc, maxPriceUsdc, physical, inStock, limit, offset }) => {
      try {
        // Same contract as GET /catalog, including the typed CONFIG_INVALID on a bad price bound.
        const result = deps.catalog.query({
          ...(query ? { q: query } : {}),
          ...(attributes && Object.keys(attributes).length > 0 ? { attributes } : {}),
          ...(minPriceUsdc !== undefined
            ? { minPriceUsdc: parsePriceBound(minPriceUsdc, "minPriceUsdc") }
            : {}),
          ...(maxPriceUsdc !== undefined
            ? { maxPriceUsdc: parsePriceBound(maxPriceUsdc, "maxPriceUsdc") }
            : {}),
          ...(physical !== undefined ? { physical } : {}),
          ...(inStock !== undefined ? { inStock } : {}),
          limit,
          offset,
        });
        return ok({
          items: result.items.map((i) => ({
            id: i.id,
            title: i.title,
            description: i.descriptionAgent,
            price: formatUsdc(priceOf(i)),
            asset: deps.core.checkoutAsset,
            physical: i.physical,
            attributes: i.attributes,
            url: i.url,
          })),
          facets: result.facets,
          page: {
            limit: result.limit,
            offset: result.offset,
            returned: result.items.length,
            total: result.total,
          },
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_item",
    {
      title: "Get item",
      description: "Full details of one catalog item.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      try {
        const i = deps.catalog.getPublished(id);
        return ok({ ...i, priceUsdc: formatUsdc(priceOf(i)) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "create_cart",
    {
      title: "Create cart",
      description:
        "Create a cart and get a quote. Physical items require buyer.email and shipping. Returns the x402 checkout URL: POST it with an x402 client (PAYMENT-SIGNATURE) to pay.",
      inputSchema: {
        items: z.array(cartLineSchema).min(1),
        buyer: buyerContactSchema.optional(),
        shipping: addressSchema.optional(),
      },
    },
    async ({ items, buyer, shipping }) => {
      try {
        const cart = await deps.checkout.createCart(items, buyer, shipping);
        return ok(cartView(cart, deps.core, deps.routes));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: "Order status after payment (paid, external order id in the merchant platform).",
      inputSchema: { orderId: z.string() },
    },
    async ({ orderId }) => {
      try {
        return ok(orderView(deps.checkout.getOrder(orderId)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_payment_instructions",
    {
      title: "Payment instructions",
      description:
        "How to pay a cart: x402 exact scheme on Stellar. Use an x402-capable HTTP client against the checkout URL.",
      inputSchema: { cartId: z.string() },
    },
    async ({ cartId }) => {
      try {
        const cart = deps.checkout.getCart(cartId);
        return ok({
          protocol: "x402",
          scheme: "exact",
          network: deps.core.caip2,
          asset: deps.core.checkoutAsset,
          payTo: cart.quote.payTo,
          amountMinor: cart.quote.totalUsdc.toString(),
          amount: formatUsdc(cart.quote.totalUsdc),
          method: "POST",
          url: deps.routes.checkout.replace("<cartId>", cart.id),
          steps: [
            "POST the url without payment to receive 402 + PAYMENT-REQUIRED header",
            "Sign the Stellar auth entry with your wallet and retry with PAYMENT-SIGNATURE",
            "Read PAYMENT-RESPONSE for the tx hash, then poll get_order",
          ],
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}

export function createMcpHandler(deps: McpDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const server = buildMcpServer(deps);
    // No sessionIdGenerator => stateless mode (one server per request).
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      void server.close().catch(() => {});
    }
  };
}
