/**
 * Per-site MCP server (SPEC 09): discovery + cart tools for any MCP agent. Payment itself goes
 * through the x402 HTTP checkout (the tool returns the exact URL and terms).
 * Stateless: one McpServer + transport per request.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  AgentGateError,
  addressSchema,
  buyerContactSchema,
  cartLineSchema,
  formatUsdc,
} from "@agentgate/core";
import type { CoreConfig } from "@agentgate/core";
import type { CatalogService } from "./catalog.js";
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
    err instanceof AgentGateError
      ? err.toJSON()
      : { code: "INTERNAL", message: String(err), hint: "Unexpected error", retryable: true };
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: body }) }],
    isError: true,
  };
}

export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: `agentgate:${deps.site.displayName}`, version: "0.1.0" });

  server.registerTool(
    "search_items",
    {
      title: "Search items",
      description: `Search ${deps.site.displayName}'s catalog. Returns ids, prices in ${deps.core.checkoutAsset} and attributes.`,
      inputSchema: {
        query: z.string().default(""),
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    async ({ query, limit }) => {
      const items = query
        ? deps.catalog.search(query, limit)
        : deps.catalog.published().slice(0, limit);
      return ok({
        items: items.map((i) => ({
          id: i.id,
          title: i.title,
          description: i.descriptionAgent,
          price: formatUsdc(priceOf(i)),
          asset: deps.core.checkoutAsset,
          physical: i.physical,
          attributes: i.attributes,
          url: i.url,
        })),
      });
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
