/**
 * A store that also takes x402 payments on an extra network (Arc testnet here): the 402 offers
 * both, a payment settled on the extra network creates the order with the amount in the
 * catalog's unit, and every check runs against that network's own address and asset.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentPayload, SupportedResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  FAMILY_ADDRESS_CHECKS,
  registerChainProfile,
  resetChainProfilesForTests,
  resolveConfig,
  usdc,
} from "@agentpos/core";
import type { CatalogItem, OrderConnector, PaidOrderInput } from "@agentpos/core";
import { createAgentPOSApp } from "./app.js";
import { parseSiteConfig } from "./config.js";
import { SiteStorage } from "./storage.js";
import { stubFacilitator } from "./test-utils.js";

const ARC = "eip155:5042002";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const ARC_PAYTO = "0x75284c0856d11112321014Cd4405dEc5d84393f8";
const stellarPayTo = Keypair.random().publicKey();

const site = parseSiteConfig({
  siteUrl: "https://shop.test",
  displayName: "Test Shop",
  payTo: stellarPayTo,
  platform: "generic",
  cartTtlMinutes: 5,
});
const core = resolveConfig({ network: "testnet" });

const ebook: CatalogItem = {
  id: "ebook",
  externalId: "13",
  type: "product",
  title: "E-book",
  descriptionAgent: "PDF guide, 120 pages.",
  url: "https://shop.test/product/ebook/",
  attributes: {},
  priceUsdc: usdc("2.5"),
  stockMode: "untracked",
  physical: false,
  status: "published",
  sourceEvidence: [{ source: "test", locator: "fixture" }],
};

function connectorMock(): OrderConnector & { created: PaidOrderInput[] } {
  const created: PaidOrderInput[] = [];
  return {
    platform: "generic",
    created,
    getAvailability: async (items: Array<{ itemId: string; quantity: number }>) =>
      items.map((i) => ({ itemId: i.itemId, available: true })),
    async createOrder(input: PaidOrderInput) {
      created.push(input);
      return { externalOrderId: `woo-${created.length}` };
    },
  } as OrderConnector & { created: PaidOrderInput[] };
}

/** One stub facilitator that settles on both networks. */
function bothNetworks() {
  const fac = stubFacilitator({ txHash: "0xarc_tx" });
  fac.getSupported = async (): Promise<SupportedResponse> => ({
    kinds: [
      { x402Version: 2, scheme: "exact", network: "stellar:testnet" },
      { x402Version: 2, scheme: "exact", network: ARC, extra: { name: "USDC", version: "2" } },
    ],
    extensions: [],
    signers: {},
  });
  return fac;
}

beforeEach(() =>
  registerChainProfile({
    caip2: ARC,
    family: "eip155",
    label: "Arc testnet",
    testnet: true,
    usdcDecimals: 6,
    isValidAddress: FAMILY_ADDRESS_CHECKS.eip155,
  }),
);
afterEach(() => resetChainProfilesForTests());

describe("a store that also takes payments on Arc", () => {
  const build = () => {
    const storage = new SiteStorage(":memory:");
    storage.upsertItem(ebook);
    const connector = connectorMock();
    const facilitator = bothNetworks();
    const gate = createAgentPOSApp({
      site,
      core,
      connector,
      storage,
      facilitator,
      x402Networks: [
        {
          extension: { network: ARC, server: new ExactEvmScheme(), facilitator },
          payTo: ARC_PAYTO,
          asset: ARC_USDC,
        },
      ],
    });
    return { gate, connector, facilitator };
  };

  it("offers Stellar first and Arc second, each in its own unit and address", async () => {
    const { gate } = build();
    const cartRes = await gate.fetch(
      new Request("https://shop.test/agentpos/cart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [{ itemId: "ebook", quantity: 1 }],
          buyer: { email: "ada@example.com" },
        }),
      }),
    );
    const cart = (await cartRes.json()) as { checkout: string };
    if (!cart.checkout) throw new Error(`cart failed: ${cartRes.status} ${JSON.stringify(cart)}`);
    const first = await gate.fetch(new Request(cart.checkout, { method: "POST" }));
    expect(first.status).toBe(402);
    const client = new x402HTTPClient(new x402Client());
    const required = client.getPaymentRequiredResponse(
      (n) => first.headers.get(n),
      await first
        .clone()
        .json()
        .catch(() => undefined),
    );
    expect(required.accepts.map((a) => [a.network, a.amount, a.payTo])).toEqual([
      ["stellar:testnet", "25000000", stellarPayTo],
      [ARC, "2500000", ARC_PAYTO],
    ]);
  });

  it("creates the order from an Arc settlement, in the catalog's unit", async () => {
    const { gate, connector } = build();
    const cartRes = await gate.fetch(
      new Request("https://shop.test/agentpos/cart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [{ itemId: "ebook", quantity: 1 }],
          buyer: { email: "ada@example.com" },
        }),
      }),
    );
    const cart = (await cartRes.json()) as { checkout: string };
    const first = await gate.fetch(new Request(cart.checkout, { method: "POST" }));
    const client = new x402HTTPClient(new x402Client());
    const required = client.getPaymentRequiredResponse(
      (n) => first.headers.get(n),
      await first
        .clone()
        .json()
        .catch(() => undefined),
    );
    const arc = required.accepts.find((a) => a.network === ARC);
    expect(arc).toBeDefined();
    const payload = {
      x402Version: 2,
      accepted: arc,
      payload: { signature: "0xstub", authorization: {} },
    } as unknown as PaymentPayload;
    const paid = await gate.fetch(
      new Request(cart.checkout, {
        method: "POST",
        headers: client.encodePaymentSignatureHeader(payload),
      }),
    );
    expect(paid.status).toBe(200);
    expect(connector.created).toHaveLength(1);
    const order = connector.created[0]!;
    expect(order.payment.txHash).toBe("0xarc_tx");
    expect(order.payment.network).toBe(ARC);
    expect(order.payment.amountMinor).toBe(usdc("2.5")); // 25000000n, not 2500000n
  });

  it("refuses to start with a merchant address that does not belong to Arc", () => {
    const facilitator = bothNetworks();
    expect(() =>
      createAgentPOSApp({
        site,
        core,
        connector: connectorMock(),
        storage: new SiteStorage(":memory:"),
        facilitator,
        x402Networks: [
          {
            extension: { network: ARC, server: new ExactEvmScheme(), facilitator },
            payTo: stellarPayTo,
            asset: ARC_USDC,
          },
        ],
      }),
    ).toThrow(/not a valid Arc testnet address/);
  });
});
