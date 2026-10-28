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

describe("when the Arc facilitator is down (F1)", () => {
  /** Stellar settles through the store's facilitator; Arc through its own, which can go down. */
  const build = (networkHealthTtlMs = 60_000) => {
    const storage = new SiteStorage(":memory:");
    storage.upsertItem(ebook);
    const connector = connectorMock();
    const arcFacilitator = stubFacilitator({ network: ARC, txHash: "0xarc_tx" });
    const arc = { up: false };
    arcFacilitator.getSupported = async (): Promise<SupportedResponse> => {
      if (!arc.up) throw new Error("503 Service Unavailable");
      return {
        kinds: [
          { x402Version: 2, scheme: "exact", network: ARC, extra: { name: "USDC", version: "2" } },
        ],
        extensions: [],
        signers: {},
      };
    };
    const gate = createAgentPOSApp({
      site,
      core,
      connector,
      storage,
      facilitator: stubFacilitator(),
      networkHealthTtlMs,
      x402Networks: [
        {
          extension: { network: ARC, server: new ExactEvmScheme(), facilitator: arcFacilitator },
          payTo: ARC_PAYTO,
          asset: ARC_USDC,
        },
      ],
    });
    return { gate, connector, arc };
  };

  const checkoutUrl = async (gate: ReturnType<typeof build>["gate"]): Promise<string> => {
    const res = await gate.fetch(
      new Request("https://shop.test/agentpos/cart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [{ itemId: "ebook", quantity: 1 }],
          buyer: { email: "ada@example.com" },
        }),
      }),
    );
    return ((await res.json()) as { checkout: string }).checkout;
  };

  const offered = async (gate: ReturnType<typeof build>["gate"], url: string) => {
    const res = await gate.fetch(new Request(url, { method: "POST" }));
    expect(res.status).toBe(402);
    const required = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse(
      (n) => res.headers.get(n),
      await res
        .clone()
        .json()
        .catch(() => undefined),
    );
    return required.accepts.map((a) => a.network);
  };

  it("leaves Arc out of the 402 and keeps the store payable on Stellar", async () => {
    const { gate } = build();
    expect(await offered(gate, await checkoutUrl(gate))).toEqual(["stellar:testnet"]);
  });

  it("offers Arc again once its facilitator is back", async () => {
    const { gate, arc } = build(0);
    const url = await checkoutUrl(gate);
    expect(await offered(gate, url)).toEqual(["stellar:testnet"]);
    arc.up = true;
    await offered(gate, url); // serves the stale result and refreshes in the background
    await new Promise((r) => setTimeout(r, 0));
    expect(await offered(gate, url)).toEqual(["stellar:testnet", ARC]);
  });

  it("reports the degraded network in /health without marking the store down", async () => {
    const { gate } = build();
    const res = await gate.fetch(new Request("https://shop.test/agentpos/health"));
    const body = (await res.json()) as { networks?: Array<{ network: string; status: string }> };
    expect(body.networks).toEqual([expect.objectContaining({ network: ARC, status: "degraded" })]);
  });
});

describe("reconciliation of Arc payments (D3)", () => {
  it("runs the network's watcher and reports it in /health", async () => {
    const facilitator = bothNetworks();
    const gate = createAgentPOSApp({
      site,
      core,
      connector: connectorMock(),
      storage: new SiteStorage(":memory:"),
      facilitator,
      x402Networks: [
        {
          extension: { network: ARC, server: new ExactEvmScheme(), facilitator },
          payTo: ARC_PAYTO,
          asset: ARC_USDC,
          watcher: {
            recentPayments: async () => [
              { txHash: "0xlost", amountMinor: usdc("2.5"), from: "0x42Db" },
            ],
          },
        },
      ],
    });
    expect(gate.reconciler).toBeDefined();
    await gate.reconciler!.run(Date.now() - 10 * 60_000);
    await gate.reconciler!.run();
    const res = await gate.fetch(new Request("https://shop.test/agentpos/health"));
    const body = (await res.json()) as {
      ok: boolean;
      networks?: Array<{ reconciliation?: { paymentsWithoutOrder: number } }>;
    };
    expect(body.networks?.[0]?.reconciliation?.paymentsWithoutOrder).toBe(1);
  });
});

describe("when the store's own facilitator is down (F5)", () => {
  const down = async (): Promise<SupportedResponse> => {
    throw new Error("401 Unauthorized");
  };
  const build = (opts: { arcUp: boolean; withArc?: boolean }) => {
    const storage = new SiteStorage(":memory:");
    storage.upsertItem(ebook);
    const connector = connectorMock();
    const stellar = stubFacilitator();
    stellar.getSupported = down;
    const arc = stubFacilitator({ network: ARC, txHash: "0xarc_only" });
    if (opts.arcUp) {
      arc.getSupported = async () => ({
        kinds: [
          { x402Version: 2, scheme: "exact", network: ARC, extra: { name: "USDC", version: "2" } },
        ],
        extensions: [],
        signers: {},
      });
    } else arc.getSupported = down;
    const gate = createAgentPOSApp({
      site,
      core,
      connector,
      storage,
      facilitator: stellar,
      ...(opts.withArc === false
        ? {}
        : {
            x402Networks: [
              {
                extension: { network: ARC, server: new ExactEvmScheme(), facilitator: arc },
                payTo: ARC_PAYTO,
                asset: ARC_USDC,
              },
            ],
          }),
    });
    return { gate, connector };
  };
  const newCheckout = async (gate: ReturnType<typeof build>["gate"]) => {
    const res = await gate.fetch(
      new Request("https://shop.test/agentpos/cart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [{ itemId: "ebook", quantity: 1 }],
          buyer: { email: "ada@example.com" },
        }),
      }),
    );
    return ((await res.json()) as { checkout: string }).checkout;
  };

  it("offers Arc alone, and an Arc payment still creates the order", async () => {
    const { gate, connector } = build({ arcUp: true });
    const url = await newCheckout(gate);
    const first = await gate.fetch(new Request(url, { method: "POST" }));
    expect(first.status).toBe(402);
    const client = new x402HTTPClient(new x402Client());
    const required = client.getPaymentRequiredResponse(
      (n) => first.headers.get(n),
      await first
        .clone()
        .json()
        .catch(() => undefined),
    );
    expect(required.accepts.map((a) => a.network)).toEqual([ARC]);
    const payload = {
      x402Version: 2,
      accepted: required.accepts[0],
      payload: { signature: "0xstub", authorization: {} },
    } as unknown as PaymentPayload;
    const paid = await gate.fetch(
      new Request(url, { method: "POST", headers: client.encodePaymentSignatureHeader(payload) }),
    );
    expect(paid.status).toBe(200);
    expect(connector.created[0]?.payment.txHash).toBe("0xarc_only");
  });

  it("answers a typed, retryable error instead of a 500 when no network can settle", async () => {
    for (const opts of [{ arcUp: false }, { arcUp: false, withArc: false }]) {
      const { gate } = build(opts);
      const res = await gate.fetch(new Request(await newCheckout(gate), { method: "POST" }));
      expect(res.status).toBe(502);
      expect(res.headers.get("retry-after")).toBe("60");
      const body = (await res.json()) as { error: { code: string; retryable: boolean } };
      expect(body.error).toMatchObject({ code: "FACILITATOR_UNAVAILABLE", retryable: true });
    }
  });
});

describe("when a facilitator refuses a signed payment (F3)", () => {
  type Refusal = {
    verify?: () => Promise<{ isValid: false; invalidReason: string; payer: string }>;
    settle?: () => Promise<never>;
  };
  const build = (refuse: Refusal) => {
    const storage = new SiteStorage(":memory:");
    storage.upsertItem(ebook);
    const connector = connectorMock();
    const facilitator = bothNetworks();
    if (refuse.verify) facilitator.verify = refuse.verify;
    if (refuse.settle) facilitator.settle = refuse.settle;
    const alerts: Array<{ code: string; details: Record<string, unknown> }> = [];
    const gate = createAgentPOSApp({
      site,
      core,
      connector,
      storage,
      facilitator,
      alert: (e) => {
        alerts.push(e);
      },
      x402Networks: [
        {
          extension: { network: ARC, server: new ExactEvmScheme(), facilitator },
          payTo: ARC_PAYTO,
          asset: ARC_USDC,
        },
      ],
    });
    return { gate, connector, alerts };
  };

  const payOnArc = async (gate: ReturnType<typeof createAgentPOSApp>) => {
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
    const payload = {
      x402Version: 2,
      accepted: required.accepts.find((a) => a.network === ARC),
      payload: { signature: "0xstub", authorization: {} },
    } as unknown as PaymentPayload;
    const res = await gate.fetch(
      new Request(cart.checkout, {
        method: "POST",
        headers: client.encodePaymentSignatureHeader(payload),
      }),
    );
    const body = (await res.json()) as {
      error: { code: string; retryable: boolean; hint: string; details: { network?: string } };
    };
    return { res, body };
  };

  // Circle screens the buyer and the merchant and documents no reason code for a failed screen;
  // its refusals outside the documented reasons come back as a 403.
  const screened = async (): Promise<never> => {
    throw new Error('Facilitator settle failed (403): {"code":403,"message":"Forbidden"}');
  };

  it("answers PAYMENT_DECLINED on the network that declined, with no order", async () => {
    const { gate, connector } = build({ settle: screened });
    const { res, body } = await payOnArc(gate);
    expect(res.status).toBe(402);
    expect(body.error.code).toBe("PAYMENT_DECLINED");
    expect(body.error.retryable).toBe(false);
    expect(body.error.details.network).toBe(ARC);
    expect(body.error.hint).toMatch(/do not pay on another network on your own/);
    expect(connector.created).toHaveLength(0);
  });

  it("alerts the merchant once per network, not once per buyer", async () => {
    const { gate, alerts } = build({ settle: screened });
    await payOnArc(gate);
    await payOnArc(gate);
    expect(alerts.filter((a) => a.code === "PAYMENT_DECLINED")).toEqual([
      expect.objectContaining({ details: expect.objectContaining({ network: ARC }) }),
    ]);
  });

  it("tells an empty wallet apart from a decline", async () => {
    const { gate, alerts } = build({
      verify: async () => ({ isValid: false, invalidReason: "insufficient_funds", payer: "0xb" }),
    });
    const { res, body } = await payOnArc(gate);
    expect(res.status).toBe(402);
    expect(body.error.code).toBe("INSUFFICIENT_FUNDS");
    expect(body.error.details.network).toBe(ARC);
    expect(alerts).toEqual([]);
  });
});
