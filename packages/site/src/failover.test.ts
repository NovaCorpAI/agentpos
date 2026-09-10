import { beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { resolveConfig, usdc } from "@agentpos/core";
import type { CatalogItem, OrderConnector, PaidOrderInput } from "@agentpos/core";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { createAgentPOSApp } from "./app.js";
import type { AlertEvent } from "./checkout.js";
import { parseSiteConfig } from "./config.js";
import {
  FailoverFacilitator,
  isInfrastructureFailure,
  isPreSubmissionFailure,
} from "./facilitators.js";
import type { FacilitatorEndpoint } from "./facilitators.js";
import { SiteStorage } from "./storage.js";
import { payLikeAnAgent } from "./test-utils.js";

const payTo = Keypair.random().publicKey();
const core = resolveConfig({ network: "testnet" });

/** A stub endpoint client whose failures are flipped per test. */
function endpointClient(name: string) {
  const state = {
    name,
    verifyCalls: 0,
    settleCalls: 0,
    supportedCalls: 0,
    failVerify: undefined as Error | undefined,
    failVerifyOnce: undefined as Error | undefined,
    failSettle: undefined as Error | undefined,
    failSettleOnce: undefined as Error | undefined,
    failSupported: undefined as Error | undefined,
    async verify(_p: PaymentPayload, _r: PaymentRequirements): Promise<VerifyResponse> {
      state.verifyCalls += 1;
      if (state.failVerifyOnce) {
        const err = state.failVerifyOnce;
        state.failVerifyOnce = undefined;
        throw err;
      }
      if (state.failVerify) throw state.failVerify;
      return { isValid: true, payer: "GPAYER" };
    },
    async settle(_p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
      state.settleCalls += 1;
      if (state.failSettleOnce) {
        const err = state.failSettleOnce;
        state.failSettleOnce = undefined;
        throw err;
      }
      if (state.failSettle) throw state.failSettle;
      return {
        success: true,
        transaction: `tx_${name}`,
        network: r.network,
        payer: "GPAYER",
        amount: r.amount,
      };
    },
    async getSupported(): Promise<SupportedResponse> {
      state.supportedCalls += 1;
      if (state.failSupported) throw state.failSupported;
      return {
        kinds: [
          { x402Version: 2, scheme: "exact", network: "stellar:testnet" as `${string}:${string}` },
        ],
        extensions: [],
        signers: {},
      };
    },
  };
  return state;
}

type StubClient = ReturnType<typeof endpointClient>;

/** The request never left this machine: DNS/connect failure. */
const connectError = () =>
  Object.assign(new Error("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
      code: "ECONNREFUSED",
    }),
  });
/** The request may have reached the facilitator: outcome unknown. */
const timeoutError = () => {
  const err = new Error("settle timed out after 30000ms");
  err.name = "FacilitatorTimeoutError";
  return err;
};
const httpError = (statusCode: number) =>
  Object.assign(new Error(`facilitator answered ${statusCode}`), { statusCode });

const ENDPOINTS: FacilitatorEndpoint[] = [
  { url: "https://primary.test", apiKeys: ["sekret-primary"] },
  { url: "https://fallback.test", apiKeys: ["sekret-fallback"] },
];

const payload = (id = "p1") =>
  ({ x402Version: 2, payload: { transaction: `xdr-${id}` } }) as unknown as PaymentPayload;
const requirements = {
  scheme: "exact",
  network: "stellar:testnet",
  amount: "99000000",
  payTo,
} as unknown as PaymentRequirements;

describe("failure classification", () => {
  it("treats only provable connect failures as pre-submission", () => {
    expect(isPreSubmissionFailure(connectError())).toBe(true);
    expect(isPreSubmissionFailure(timeoutError())).toBe(false);
    expect(isPreSubmissionFailure(httpError(502))).toBe(false);
    expect(isPreSubmissionFailure(new Error("weird"))).toBe(false);
  });

  it("separates infrastructure failures from deterministic 4xx rejections", () => {
    expect(isInfrastructureFailure(connectError())).toBe(true);
    expect(isInfrastructureFailure(timeoutError())).toBe(true);
    expect(isInfrastructureFailure(httpError(503))).toBe(true);
    expect(isInfrastructureFailure(httpError(400))).toBe(false);
  });
});

describe("FailoverFacilitator", () => {
  let primary: StubClient;
  let fallback: StubClient;
  let clock: { t: number };

  const pool = () =>
    new FailoverFacilitator({
      endpoints: ENDPOINTS,
      network: "stellar:testnet",
      createClient: (_e, i) => [primary, fallback][i] as StubClient,
      now: () => clock.t,
    });

  beforeEach(() => {
    primary = endpointClient("primary");
    fallback = endpointClient("fallback");
    clock = { t: 1_000_000 };
  });

  it("uses the fallback when the primary health probe fails, for verify AND settle", async () => {
    primary.failSupported = new Error("503 from primary");
    const p = pool();
    const verified = await p.verify(payload(), requirements);
    expect(verified.isValid).toBe(true);
    expect(primary.verifyCalls).toBe(0);
    expect(fallback.verifyCalls).toBe(1);
    const settled = await p.settle(payload(), requirements);
    expect(settled.success).toBe(true);
    expect(primary.settleCalls).toBe(0);
    expect(fallback.settleCalls).toBe(1);
  });

  it("pins settle to the facilitator that verified, even when a re-pick would choose another", async () => {
    const p = pool();
    await p.verify(payload(), requirements);
    expect(primary.verifyCalls).toBe(1);
    // Primary now looks unhealthy to any fresh probe, and its health is stale...
    primary.failSupported = new Error("down");
    clock.t += 61_000;
    // ...but the payment was verified by the primary, so it settles on the primary.
    const settled = await p.settle(payload(), requirements);
    expect(settled.success).toBe(true);
    expect((settled as { transaction: string }).transaction).toBe("tx_primary");
    expect(primary.settleCalls).toBe(1);
    expect(fallback.settleCalls).toBe(0);
  });

  it("retries verify once on the next endpoint after an infrastructure failure", async () => {
    primary.failVerify = connectError();
    const p = pool();
    const verified = await p.verify(payload(), requirements);
    expect(verified.isValid).toBe(true);
    expect(primary.verifyCalls).toBe(1);
    expect(fallback.verifyCalls).toBe(1);
    // The pin moved with the retry: settle goes to the endpoint that actually verified.
    await p.settle(payload(), requirements);
    expect(primary.settleCalls).toBe(0);
    expect(fallback.settleCalls).toBe(1);
  });

  it("NEVER retries settle on another facilitator after an ambiguous failure", async () => {
    const p = pool();
    await p.verify(payload(), requirements);
    primary.failSettle = timeoutError();
    await expect(p.settle(payload(), requirements)).rejects.toThrow(/timed out/);
    expect(primary.settleCalls).toBe(1);
    expect(fallback.settleCalls).toBe(0);

    // Same for a 5xx: the request reached something, the outcome is not provably void.
    primary.failSettle = httpError(503);
    await p.verify(payload("p2"), requirements); // primary is marked unhealthy -> fallback
    expect(fallback.verifyCalls).toBe(1);
  });

  it("retries settle only when the first attempt provably never connected", async () => {
    const p = pool();
    await p.verify(payload(), requirements);
    primary.failSettleOnce = connectError();
    const settled = await p.settle(payload(), requirements);
    expect(settled.success).toBe(true);
    expect((settled as { transaction: string }).transaction).toBe("tx_fallback");
    expect(primary.settleCalls).toBe(1);
    expect(fallback.settleCalls).toBe(1);
  });

  it("is a plain passthrough with a single endpoint: no probes, no retries", async () => {
    const single = new FailoverFacilitator({
      endpoints: [ENDPOINTS[0] as FacilitatorEndpoint],
      network: "stellar:testnet",
      createClient: () => primary,
      now: () => clock.t,
    });
    await single.verify(payload(), requirements);
    await single.settle(payload(), requirements);
    expect(primary.supportedCalls).toBe(0); // never probed
    expect(primary.verifyCalls).toBe(1);
    expect(primary.settleCalls).toBe(1);
    // A verify failure surfaces as-is instead of being retried anywhere.
    primary.failVerify = connectError();
    await expect(single.verify(payload("p2"), requirements)).rejects.toThrow(/fetch failed/);
    expect(fallback.verifyCalls).toBe(0);
  });
});

describe("site app with a facilitator pool", () => {
  const ebook: CatalogItem = {
    id: "ebook",
    externalId: "13",
    type: "product",
    title: "E-book",
    descriptionAgent: "PDF guide, 120 pages.",
    url: "https://shop.test/product/ebook/",
    attributes: {},
    priceUsdc: usdc("2"),
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
      getAvailability: async (items) => items.map((i) => ({ itemId: i.itemId, available: true })),
      createOrder: async (input) => {
        created.push(input);
        return { externalOrderId: `ext-${created.length}` };
      },
    };
  }

  /** `setup` runs before the app is created, i.e. before the resource server's first probe. */
  function build(setup?: (primary: StubClient, fallback: StubClient) => void) {
    const storage = new SiteStorage(":memory:");
    storage.upsertItem(ebook);
    const site = parseSiteConfig({
      siteUrl: "https://shop.test",
      displayName: "Failover Shop",
      payTo,
      platform: "generic",
    });
    const primary = endpointClient("primary");
    const fallback = endpointClient("fallback");
    setup?.(primary, fallback);
    const connector = connectorMock();
    const alerts: AlertEvent[] = [];
    const gate = createAgentPOSApp({
      site,
      core,
      connector,
      storage,
      facilitators: ENDPOINTS,
      facilitatorClientFactory: (_e, i) => [primary, fallback][i] as StubClient,
      alert: (e) => void alerts.push(e),
    });
    const req = (path: string, init?: RequestInit) =>
      gate.fetch(new Request(`https://shop.test${path}`, init));
    const newCart = async () => {
      const res = await req("/agentpos/cart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [{ itemId: "ebook", quantity: 1 }] }),
      });
      return (await res.json()) as { cartId: string };
    };
    const pay = (cartId: string) =>
      payLikeAnAgent(gate.fetch, `https://shop.test/agentpos/checkout?cart=${cartId}`, {
        method: "POST",
      });
    return { gate, storage, connector, alerts, primary, fallback, req, newCart, pay };
  }

  it("completes a payment through the fallback when the primary is down from the start", async () => {
    const t = build((primary) => {
      primary.failSupported = new Error("primary is down");
      primary.failVerify = connectError();
      primary.failSettle = connectError();
    });
    const cart = await t.newCart();
    const { paid } = await t.pay(cart.cartId);
    expect(paid!.status).toBe(200);
    // The failed startup probe marked the primary unhealthy; nothing was even attempted on it.
    expect(t.primary.verifyCalls).toBe(0);
    expect(t.primary.settleCalls).toBe(0);
    expect(t.fallback.verifyCalls).toBe(1);
    expect(t.fallback.settleCalls).toBe(1);
    const order = t.storage.listOrders()[0];
    expect(order?.status).toBe("paid");
    expect(order?.payment?.txHash).toBe("tx_fallback");
    expect(t.connector.created).toHaveLength(1);
  });

  it("fails over mid-flight when the primary dies after a healthy probe", async () => {
    const t = build();
    // The startup probe found the primary healthy; now it goes down before the payment.
    t.primary.failVerify = connectError();
    const cart = await t.newCart();
    const { paid } = await t.pay(cart.cartId);
    expect(paid!.status).toBe(200);
    // One failed verify attempt on the primary, then verify AND settle on the fallback: the
    // payment never splits across facilitators.
    expect(t.primary.verifyCalls).toBe(1);
    expect(t.primary.settleCalls).toBe(0);
    expect(t.fallback.verifyCalls).toBe(1);
    expect(t.fallback.settleCalls).toBe(1);
    expect(t.storage.listOrders()[0]?.payment?.txHash).toBe("tx_fallback");
  });

  it("takes the stuck path on an ambiguous settle failure instead of a second facilitator", async () => {
    const t = build();
    t.primary.failSettle = timeoutError();
    const cart = await t.newCart();
    const { paid } = await t.pay(cart.cartId);
    // The payment was not confirmed to the agent and no platform order exists.
    expect(paid!.status).not.toBe(200);
    expect(t.primary.settleCalls).toBe(1);
    expect(t.fallback.settleCalls).toBe(0);
    expect(t.connector.created).toHaveLength(0);
    const order = t.storage.listOrders()[0];
    expect(order?.status).toBe("pending_payment");
    expect(order?.payment).toBeUndefined();
  });

  it("reports every facilitator on /health, host only, without leaking keys", async () => {
    const t = build((primary) => {
      primary.failSupported = new Error("primary is down");
    });
    const res = await t.req("/agentpos/health");
    expect(res.status).toBe(200); // degraded primary, but the store can still take payments
    const body = (await res.json()) as {
      ok: boolean;
      facilitator: { ok: boolean };
      facilitators: Array<{ host: string; status: string; active: boolean }>;
    };
    expect(body.ok).toBe(true);
    expect(body.facilitator.ok).toBe(true);
    expect(body.facilitators).toEqual([
      expect.objectContaining({ host: "primary.test", status: "degraded", active: false }),
      expect.objectContaining({ host: "fallback.test", status: "ok", active: true }),
    ]);
    expect(JSON.stringify(body)).not.toContain("sekret");
  });

  it("answers 503 when no facilitator is healthy", async () => {
    const t = build((primary, fallback) => {
      primary.failSupported = new Error("down");
      fallback.failSupported = new Error("down too");
    });
    const res = await t.req("/agentpos/health");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { facilitators: Array<{ status: string }> };
    expect(body.facilitators.every((f) => f.status === "degraded")).toBe(true);
  });

  it("single-facilitator regression: one endpoint behaves exactly like today", async () => {
    const storage = new SiteStorage(":memory:");
    storage.upsertItem(ebook);
    const site = parseSiteConfig({
      siteUrl: "https://shop.test",
      displayName: "Single Shop",
      payTo,
      platform: "generic",
    });
    const only = endpointClient("only");
    const connector = connectorMock();
    const gate = createAgentPOSApp({
      site,
      core,
      connector,
      storage,
      facilitators: [{ url: "https://only.test", apiKeys: [] }],
      facilitatorClientFactory: () => only,
    });
    const res = await gate.fetch(
      new Request("https://shop.test/agentpos/cart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [{ itemId: "ebook", quantity: 1 }] }),
      }),
    );
    const cart = (await res.json()) as { cartId: string };
    const { paid } = await payLikeAnAgent(
      gate.fetch,
      `https://shop.test/agentpos/checkout?cart=${cart.cartId}`,
      { method: "POST" },
    );
    expect(paid!.status).toBe(200);
    expect(only.verifyCalls).toBe(1);
    expect(only.settleCalls).toBe(1);
    expect(connector.created).toHaveLength(1);
  });
});
