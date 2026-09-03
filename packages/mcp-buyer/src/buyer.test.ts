/**
 * Buyer against an in-process AgentPOS site with a stub facilitator. The x402 signing step is
 * replaced by a fake pay-fetch that behaves like the SDK (402 -> PAYMENT-SIGNATURE retry).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { AgentPOSError, resolveConfig, usdc } from "@agentpos/core";
import type { CatalogItem, OrderConnector } from "@agentpos/core";
import { createAgentPOSApp, parseSiteConfig, SiteStorage } from "@agentpos/site";
import { BuyerService } from "./buyer.js";
import { mandateSchema } from "./mandate.js";
import type { Profile } from "./profile.js";
import { approve } from "./profile.js";
import { SpendingLog } from "./spending.js";
import { buildBuyerServer } from "./server.js";

function stubFacilitator(): FacilitatorClient & { settleCalls: number } {
  const s = {
    settleCalls: 0,
    async verify(_p: PaymentPayload, _r: PaymentRequirements): Promise<VerifyResponse> {
      return { isValid: true, payer: "GPAYER" };
    },
    async settle(_p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
      s.settleCalls += 1;
      return {
        success: true,
        transaction: `tx_${s.settleCalls}`,
        network: r.network,
        payer: "GPAYER",
        amount: r.amount,
      };
    },
    async getSupported(): Promise<SupportedResponse> {
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet" }],
        extensions: [],
        signers: {},
      };
    },
  };
  return s as FacilitatorClient & { settleCalls: number };
}

const payTo = Keypair.random().publicKey();
const core = resolveConfig({ network: "testnet" });
const items: CatalogItem[] = [
  {
    id: "mug",
    externalId: "1",
    type: "product",
    title: "Ceramic Mug",
    descriptionAgent: "350 ml",
    url: "https://shop.test/mug",
    attributes: {},
    priceUsdc: usdc("9.9"),
    stockMode: "untracked",
    physical: true,
    status: "published",
    sourceEvidence: [],
  },
  {
    id: "ebook",
    externalId: "2",
    type: "product",
    title: "E-book",
    descriptionAgent: "PDF",
    url: "https://shop.test/ebook",
    attributes: {},
    priceUsdc: usdc("2"),
    stockMode: "untracked",
    physical: false,
    status: "published",
    sourceEvidence: [],
  },
];

describe("BuyerService", () => {
  let home: string;
  let created: number;
  let site: ReturnType<typeof createAgentPOSApp>;
  let profile: Profile;
  let spending: SpendingLog;

  // Routes https://shop.test/* to the in-process app.
  const fetchImpl: typeof fetch = (input, init) =>
    site.fetch(
      new Request(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        init,
      ),
    );

  // Fake x402 client: first call 402 -> retry with a PAYMENT-SIGNATURE (stub facilitator accepts it).
  const payFetchFactory = () => async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const first = await fetchImpl(url, init);
    if (first.status !== 402) return first;
    const client = new x402HTTPClient(new x402Client());
    const required = client.getPaymentRequiredResponse(
      (n) => first.headers.get(n),
      await first
        .clone()
        .json()
        .catch(() => undefined),
    );
    const payload = {
      x402Version: 2,
      accepted: required.accepts[0]!,
      payload: { transaction: "stub" },
    } as PaymentPayload;
    return fetchImpl(url, {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string>),
        ...client.encodePaymentSignatureHeader(payload),
      },
    });
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agentpos-buyer-"));
    process.env.AGENTPOS_HOME = home;
    created = 0;
    const connector: OrderConnector = {
      platform: "generic",
      getAvailability: async (lines) => lines.map((l) => ({ itemId: l.itemId, available: true })),
      createOrder: async () => ({ externalOrderId: `woo-${++created}` }),
    };
    const storage = new SiteStorage(":memory:");
    for (const i of items) storage.upsertItem(i);
    site = createAgentPOSApp({
      site: parseSiteConfig({
        siteUrl: "https://shop.test",
        displayName: "Test Shop",
        payTo,
        platform: "generic",
      }),
      core,
      connector,
      storage,
      facilitator: stubFacilitator(),
      healthFetch: async () =>
        new Response(
          JSON.stringify({
            kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet" }],
            extensions: [],
            signers: {},
          }),
          { status: 200 },
        ),
    });
    profile = {
      name: "test",
      network: "testnet",
      keyFile: "unused",
      address: Keypair.random().publicKey(),
      mandate: mandateSchema.parse({
        maxPerTx: "10",
        maxTotal: "15",
        allowPhysicalGoods: true,
        requireConfirmAboveUsdc: "5",
      }),
      buyer: { email: "human@example.com", name: "Human" },
      shipping: {
        name: "Human",
        line1: "1 Main St",
        city: "Springfield",
        postalCode: "12345",
        country: "US",
      },
      sites: ["https://shop.test"],
      createdAt: new Date().toISOString(),
    };
    spending = new SpendingLog(join(home, "spending.jsonl"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.AGENTPOS_HOME;
  });

  const buyer = () =>
    new BuyerService({
      profile,
      fetchImpl,
      payFetchFactory,
      spendingLog: spending,
      core,
      signer: {
        kind: "local-keypair",
        network: "testnet",
        address: profile.address,
        signAuthEntry: async () => ({ signedAuthEntry: "", signerAddress: profile.address }),
      } as never,
    });

  it("searches the profile's sites and buys a small digital item without confirmation", async () => {
    const b = buyer();
    const offers = await b.searchOffers("e-book");
    expect(offers.map((o) => o.id)).toEqual(["ebook"]);
    const cart = await b.createCart("https://shop.test", [{ itemId: "ebook", quantity: 1 }]);
    const result = await b.buy("https://shop.test", cart.cartId);
    expect(result.receipt.txHash).toBe("tx_1");
    expect(result.order.status).toBe("paid");
    expect(result.order.externalOrderId).toBe("woo-1");
    expect(spending.entries()).toHaveLength(1);
  });

  it("uses the locked shipping address and refuses an agent-supplied one", async () => {
    const b = buyer();
    await expect(
      b.createCart("https://shop.test", [{ itemId: "mug", quantity: 1 }], undefined, {
        ...profile.shipping!,
        line1: "elsewhere",
      }),
    ).rejects.toMatchObject({ code: "MANDATE_EXCEEDED" });
    const cart = await b.createCart("https://shop.test", [{ itemId: "mug", quantity: 1 }]);
    expect(cart.quote.requiresShipping).toBe(true);
  });

  it("requires human approval above the threshold, then pays once approved", async () => {
    const b = buyer();
    const cart = await b.createCart("https://shop.test", [{ itemId: "mug", quantity: 1 }]); // 9.9 > 5
    await expect(b.buy("https://shop.test", cart.cartId)).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED",
    });
    expect(created).toBe(0);
    approve("test", cart.cartId);
    const result = await b.buy("https://shop.test", cart.cartId);
    expect(result.order.externalOrderId).toBe("woo-1");
  });

  it("enforces per-tx and period limits from the spending log", async () => {
    const b = buyer();
    const big = await b.createCart("https://shop.test", [{ itemId: "mug", quantity: 2 }]); // 19.8 > 10
    await expect(b.buy("https://shop.test", big.cartId)).rejects.toMatchObject({
      code: "MANDATE_EXCEEDED",
    });
    for (let i = 0; i < 7; i += 1) {
      const c = await b.createCart("https://shop.test", [{ itemId: "ebook", quantity: 1 }]);
      await b.buy("https://shop.test", c.cartId); // 7 x 2 = 14 <= 15
    }
    const eighth = await b.createCart("https://shop.test", [{ itemId: "ebook", quantity: 1 }]);
    await expect(b.buy("https://shop.test", eighth.cartId)).rejects.toMatchObject({
      code: "MANDATE_EXCEEDED",
    });
    expect(created).toBe(7);
  });

  it("refuses sellers outside the allowlist without touching the wallet", async () => {
    profile = {
      ...profile,
      mandate: mandateSchema.parse({ ...profile.mandate, allowedSellers: ["other.test"] }),
    };
    const b = buyer();
    const cart = await b.createCart("https://shop.test", [{ itemId: "ebook", quantity: 1 }]);
    await expect(b.buy("https://shop.test", cart.cartId)).rejects.toMatchObject({
      code: "SELLER_UNVERIFIED",
    });
    expect(created).toBe(0);
  });

  it("exposes the flow through MCP tools", async () => {
    const shared = buyer();
    const { WebStandardStreamableHTTPServerTransport } =
      await import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
    // Stateless transport: one server + transport per request, same BuyerService underneath.
    const call = async (method: string, params: unknown, id = 1) => {
      const server = buildBuyerServer({ defaultProfile: "test", buyerFactory: () => shared });
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      const res = await transport.handleRequest(
        new Request("http://buyer/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        }),
      );
      const body = (await res.json()) as {
        result: { structuredContent: Record<string, unknown>; isError?: boolean };
      };
      await server.close();
      return body;
    };
    await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    const search = await call(
      "tools/call",
      { name: "search_offers", arguments: { query: "mug" } },
      2,
    );
    expect((search.result.structuredContent.offers as Array<{ id: string }>)[0]?.id).toBe("mug");
    const cart = await call(
      "tools/call",
      {
        name: "create_cart",
        arguments: { site: "https://shop.test", items: [{ itemId: "ebook", quantity: 1 }] },
      },
      3,
    );
    const cartId = cart.result.structuredContent.cartId as string;
    const bought = await call(
      "tools/call",
      { name: "buy", arguments: { site: "https://shop.test", cartId } },
      4,
    );
    expect(bought.result.structuredContent.txHash).toBe("tx_1");
    const log = await call("tools/call", { name: "get_spending_log", arguments: {} }, 5);
    expect((log.result.structuredContent.entries as unknown[]).length).toBe(1);
  });

  it("does not leak the wallet when locked", () => {
    const locked = new BuyerService({ profile, fetchImpl, spendingLog: spending, core });
    expect(() => (locked as unknown as { signer: () => unknown }).signer()).toThrowError(
      AgentPOSError,
    );
  });
});
