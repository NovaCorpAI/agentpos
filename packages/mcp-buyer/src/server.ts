/**
 * MCP server (SPEC 02): tools any MCP agent can call. Every error is machine-readable.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  AgentPOSError,
  addressSchema,
  buyerContactSchema,
  cartLineSchema,
  formatUsdc,
  usdc,
} from "@agentpos/core";
import { BuyerService } from "./buyer.js";
import type { BuyerDeps } from "./buyer.js";
import { listProfiles, loadProfile } from "./profile.js";

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
    structuredContent: { error: body },
    isError: true,
  };
}

export interface BuyerServerOptions {
  defaultProfile: string;
  /** Overrides for tests; production loads profiles from disk. */
  buyerFactory?: (profileName: string) => BuyerService;
  depsOverrides?: Partial<BuyerDeps>;
}

export function buildBuyerServer(options: BuyerServerOptions): McpServer {
  const buyers = new Map<string, BuyerService>();
  const buyer = (name?: string): BuyerService => {
    const key = name ?? options.defaultProfile;
    let b = buyers.get(key);
    if (!b) {
      b = options.buyerFactory
        ? options.buyerFactory(key)
        : new BuyerService({ profile: loadProfile(key), ...(options.depsOverrides ?? {}) });
      buyers.set(key, b);
    }
    return b;
  };

  const server = new McpServer({ name: "agentpos-buyer", version: "0.1.0" });
  const profileArg = {
    profile: z.string().optional().describe("Buyer profile name; defaults to the server's profile"),
  };

  server.registerTool(
    "list_profiles",
    {
      title: "List profiles",
      description:
        "Buyer profiles available on this machine, with their mandate limits (read-only).",
      inputSchema: {},
    },
    async () => {
      try {
        const profiles = options.buyerFactory ? [buyer().profile] : listProfiles();
        return ok({
          profiles: profiles.map((p) => ({
            name: p.name,
            network: p.network,
            address: p.address,
            mandate: p.mandate,
            sites: p.sites,
            hasShipping: Boolean(p.shipping),
          })),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "search_offers",
    {
      title: "Search offers",
      description:
        "Search agent-buyable stores. Returns items with ids, prices and the site to buy from. Sites default to the profile's list.",
      inputSchema: {
        query: z.string().default(""),
        sites: z.array(z.url()).optional(),
        maxPriceUsdc: z.string().optional(),
        ...profileArg,
      },
    },
    async ({ query, sites, maxPriceUsdc, profile }) => {
      try {
        const offers = await buyer(profile).searchOffers(
          query,
          sites,
          maxPriceUsdc ? usdc(maxPriceUsdc) : undefined,
        );
        return ok({ offers });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_site",
    {
      title: "Get site",
      description: "Capabilities of a store: network, asset, manifest, verification.",
      inputSchema: { url: z.url(), ...profileArg },
    },
    async ({ url, profile }) => {
      try {
        return ok(await buyer(profile).site(url).info());
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
        "Create a cart at a store and get the quote. Physical goods use the profile's locked shipping address unless the mandate allows otherwise.",
      inputSchema: {
        site: z.url(),
        items: z.array(cartLineSchema).min(1),
        buyer: buyerContactSchema.optional(),
        shipping: addressSchema.optional(),
        ...profileArg,
      },
    },
    async ({ site, items, buyer: contact, shipping, profile }) => {
      try {
        return ok(await buyer(profile).createCart(site, items, contact, shipping));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "buy",
    {
      title: "Buy",
      description:
        "Pay a cart with x402 on Stellar within the human mandate. Returns the receipt (tx hash) and the order in the merchant platform. Never pays outside the mandate; CONFIRMATION_REQUIRED means a human must run `agentpos-buyer approve <cartId>` first.",
      inputSchema: { site: z.url(), cartId: z.string(), ...profileArg },
    },
    async ({ site, cartId, profile }) => {
      try {
        const result = await buyer(profile).buy(site, cartId);
        return ok({
          orderId: result.orderId,
          txHash: result.receipt.txHash,
          network: result.receipt.network,
          amount:
            result.receipt.amount !== undefined ? formatUsdc(result.receipt.amount) : undefined,
          explorer: `https://stellar.expert/explorer/${result.receipt.network === "stellar:pubnet" ? "public" : "testnet"}/tx/${result.receipt.txHash}`,
          order: result.order,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: "Order status at the store (paid, platform order id, connector errors).",
      inputSchema: { site: z.url(), orderId: z.string(), ...profileArg },
    },
    async ({ site, orderId, profile }) => {
      try {
        return ok(await buyer(profile).site(site).order(orderId));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_spending_log",
    {
      title: "Spending log",
      description: "Append-only record of every payment made with this profile.",
      inputSchema: { since: z.string().optional().describe("ISO date"), ...profileArg },
    },
    async ({ since, profile }) => {
      try {
        const entries = buyer(profile).spendingEntries(since ? new Date(since) : undefined);
        return ok({
          entries,
          total: formatUsdc(entries.reduce((acc, e) => acc + BigInt(e.amountMinor), 0n) as never),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
