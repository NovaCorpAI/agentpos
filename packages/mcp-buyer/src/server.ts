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
import { listProfiles, loadProfileWithWarnings } from "./profile.js";

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
      if (options.buyerFactory) {
        b = options.buyerFactory(key);
      } else {
        const loaded = loadProfileWithWarnings(key);
        // stderr, never stdout: stdout is the MCP transport. The human running the server sees
        // why their profile now refuses everything.
        for (const w of loaded.warnings)
          console.error(`[agentpos-buyer] ${w.code}: ${w.message} ${w.hint}`);
        b = new BuyerService({ profile: loaded.profile, ...(options.depsOverrides ?? {}) });
      }
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
    "market_call",
    {
      title: "Market call",
      description:
        "Ask EVERY store the buyer trusts for the same thing at once, and get comparable offers back. Use this for 'find me X with these characteristics across my stores': it takes free text plus exact attribute filters (`attributes: { Fondo: 'blanco' }`), price bounds and a quantity, and answers `offers` (normalized, cheapest total first, each marked payable or not with the mandate reason), `stores` (what each store did: ok, timeout, error, unsupported-filters, not-allowed, and how many offers it gave) and `facets` (the attribute values available across stores, to refine the next call). Nothing is bought: use create_cart and buy for that.",
      inputSchema: {
        what: z.string().describe("What the buyer is looking for, in their own words"),
        attributes: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Exact attribute filters, ANDed: { Fondo: 'blanco', Passepartout: 'con' }. Names and values are matched ignoring case and accents. Read `facets` to learn which ones a store understands.",
          ),
        maxPriceUsdc: z.string().optional().describe("Decimal USDC ceiling on the UNIT price"),
        minPriceUsdc: z.string().optional().describe("Decimal USDC floor on the UNIT price"),
        physical: z
          .boolean()
          .optional()
          .describe("true for goods shipped to an address, false for digital ones"),
        quantity: z
          .number()
          .int()
          .min(1)
          .max(999)
          .optional()
          .describe("Units wanted; totals are quoted for this quantity"),
        sites: z
          .array(z.url())
          .optional()
          .describe("Extra stores for this call; the mandate still decides which may be asked"),
        ...profileArg,
      },
    },
    async ({
      what,
      attributes,
      maxPriceUsdc,
      minPriceUsdc,
      physical,
      quantity,
      sites,
      profile,
    }) => {
      try {
        return ok(
          await buyer(profile).marketCall({
            what,
            ...(attributes ? { attributes } : {}),
            ...(maxPriceUsdc !== undefined ? { maxPriceUsdc } : {}),
            ...(minPriceUsdc !== undefined ? { minPriceUsdc } : {}),
            ...(physical !== undefined ? { physical } : {}),
            ...(quantity !== undefined ? { quantity } : {}),
            ...(sites ? { sites } : {}),
          }),
        );
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
