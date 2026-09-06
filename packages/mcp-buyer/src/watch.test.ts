/**
 * The signing bridge watcher against a stubbed buyer-web and a real in-process store (the
 * buyer.test.ts pattern: stub facilitator, fake x402 pay-fetch). What matters here: it pays
 * with the existing BuyerService so the mandate applies unchanged, it reports paid/failed
 * back with the txHash or the reason, and no queue item, however malformed, crashes it.
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
import { resolveConfig, usdc } from "@agentpos/core";
import type { CatalogItem, OrderConnector } from "@agentpos/core";
import { createAgentPOSApp, parseSiteConfig, SiteStorage } from "@agentpos/site";
import { BuyerService } from "./buyer.js";
import { mandateSchema } from "./mandate.js";
import type { Profile } from "./profile.js";
import { SpendingLog } from "./spending.js";
import { SignerWatcher } from "./watch.js";

const TOKEN = "signer-token-0123456789abcdef";
const BUYER_WEB = "https://buyer.test";

function stubFacilitator(): FacilitatorClient {
  let settles = 0;
  return {
    async verify(_p: PaymentPayload, _r: PaymentRequirements): Promise<VerifyResponse> {
      return { isValid: true, payer: "GPAYER" };
    },
    async settle(_p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
      settles += 1;
      return {
        success: true,
        transaction: `tx_${settles}`,
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
  } as FacilitatorClient;
}

const payTo = Keypair.random().publicKey();
const core = resolveConfig({ network: "testnet" });
const items: CatalogItem[] = [
  {
    id: "mug",
    type: "product",
    title: "Ceramic Mug",
    descriptionAgent: "350 ml",
    url: "https://shop.test/mug",
    attributes: {},
    priceUsdc: usdc("9.9"),
    stockMode: "untracked",
    physical: false,
    status: "published",
    sourceEvidence: [],
  },
  {
    id: "ebook",
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

/** A stubbed buyer-web: serves the queue, checks the bearer, records the reports. */
function stubBuyerWeb(queue: unknown[]) {
  const paid: Array<Record<string, unknown>> = [];
  const failed: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${TOKEN}`) {
      return Response.json({ error: { code: "APPROVAL_UNAUTHORIZED" } }, { status: 401 });
    }
    if (url === `${BUYER_WEB}/api/signer/queue`) {
      return Response.json({ proposals: queue });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (url === `${BUYER_WEB}/api/signer/paid`) {
      paid.push(body);
      return Response.json({ proposal: { id: body.proposalId, status: "paid" } });
    }
    if (url === `${BUYER_WEB}/api/signer/failed`) {
      failed.push(body);
      return Response.json({ proposal: { id: body.proposalId, status: "approved" } });
    }
    return Response.json({ error: { code: "INTERNAL" } }, { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetchImpl, paid, failed };
}

describe("SignerWatcher", () => {
  let home: string;
  let site: ReturnType<typeof createAgentPOSApp>;
  let profile: Profile;
  let lines: string[];

  const siteFetch: typeof fetch = (input, init) =>
    site.fetch(
      new Request(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        init,
      ),
    );

  // Fake x402 client: 402 -> retry with a PAYMENT-SIGNATURE the stub facilitator accepts.
  const payFetchFactory = () => async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const first = await siteFetch(url, init);
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
    return siteFetch(url, {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string>),
        ...client.encodePaymentSignatureHeader(payload),
      },
    });
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agentpos-watch-"));
    process.env.AGENTPOS_HOME = home;
    lines = [];
    const connector: OrderConnector = {
      platform: "generic",
      getAvailability: async (l) => l.map((x) => ({ itemId: x.itemId, available: true })),
      createOrder: async () => ({ externalOrderId: "woo-1" }),
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
      name: "watch-test",
      network: "testnet",
      keyFile: "unused",
      address: Keypair.random().publicKey(),
      mandate: mandateSchema.parse({ maxPerTx: "10", maxTotal: "50" }),
      sites: [],
      createdAt: new Date().toISOString(),
    };
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.AGENTPOS_HOME;
  });

  const buyerService = () =>
    new BuyerService({
      profile,
      fetchImpl: siteFetch,
      payFetchFactory,
      spendingLog: new SpendingLog(join(home, "spending.jsonl")),
      core,
      signer: {
        kind: "local-keypair",
        network: "testnet",
        address: profile.address,
        signAuthEntry: async () => ({ signedAuthEntry: "", signerAddress: profile.address }),
      } as never,
    });

  const watcher = (fetchImpl: typeof globalThis.fetch, token = TOKEN) =>
    new SignerWatcher({
      baseUrl: BUYER_WEB,
      token,
      buyerService: buyerService(),
      fetchImpl,
      onLine: (l) => lines.push(l),
    });

  const queueItem = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    proposalId: "p-1",
    storeUrl: "https://shop.test",
    itemId: "ebook",
    quantity: 1,
    title: "1 x E-book",
    amount: "2",
    amountMinor: "20000000",
    asset: "USDC",
    network: "stellar:testnet",
    approvedAt: new Date().toISOString(),
    ...over,
  });

  it("pays a queued proposal with the local wallet and reports the txHash back", async () => {
    const web = stubBuyerWeb([queueItem()]);
    const outcomes = await watcher(web.fetchImpl).runOnce();
    expect(outcomes).toEqual([
      { proposalId: "p-1", status: "paid", txHash: "tx_1", orderId: expect.any(String) },
    ]);
    expect(web.paid).toHaveLength(1);
    expect(web.paid[0]).toMatchObject({ proposalId: "p-1", txHash: "tx_1" });
    expect(web.failed).toHaveLength(0);
    expect(lines).toEqual([expect.stringContaining("paid p-1 tx tx_1")]);
  });

  it("reports a mandate refusal as failed with its code, and keeps processing the queue", async () => {
    // 2 x 9.9 = 19.8 > maxPerTx 10: the queue does not bypass the mandate.
    const web = stubBuyerWeb([
      queueItem({ proposalId: "p-big", itemId: "mug", quantity: 2, amountMinor: "198000000" }),
      queueItem({ proposalId: "p-ok" }),
    ]);
    const outcomes = await watcher(web.fetchImpl).runOnce();
    expect(outcomes.map((o) => [o.proposalId, o.status, o.code])).toEqual([
      ["p-big", "failed", "MANDATE_EXCEEDED"],
      ["p-ok", "paid", undefined],
    ]);
    expect(web.failed[0]).toMatchObject({ proposalId: "p-big", code: "MANDATE_EXCEEDED" });
    expect(web.paid).toHaveLength(1);
  });

  it("refuses to pay more than the human approved (REQUOTE_REQUIRED)", async () => {
    // The store quotes 2 USDC but the human approved 1 USDC.
    const web = stubBuyerWeb([queueItem({ amountMinor: "10000000", amount: "1" })]);
    const outcomes = await watcher(web.fetchImpl).runOnce();
    expect(outcomes[0]).toMatchObject({ status: "failed", code: "REQUOTE_REQUIRED" });
    expect(web.paid).toHaveLength(0);
    expect(web.failed[0]?.code).toBe("REQUOTE_REQUIRED");
  });

  it("skips a malformed queue item, reports it, and still pays the valid one", async () => {
    const web = stubBuyerWeb([
      queueItem({ proposalId: "p-bad", itemId: undefined }), // no item to buy
      { garbage: true }, // no proposalId at all
      queueItem({ proposalId: "p-ok" }),
    ]);
    const outcomes = await watcher(web.fetchImpl).runOnce();
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "skipped", "paid"]);
    expect(web.failed[0]).toMatchObject({ proposalId: "p-bad", code: "CONFIG_INVALID" });
    expect(web.paid[0]).toMatchObject({ proposalId: "p-ok" });
  });

  it("never retries an attempted proposal within the same process", async () => {
    const web = stubBuyerWeb([
      queueItem({ proposalId: "p-big", itemId: "mug", quantity: 2, amountMinor: "198000000" }),
    ]);
    const w = watcher(web.fetchImpl);
    await w.runOnce();
    const second = await w.runOnce();
    expect(second).toEqual([]);
    expect(web.failed).toHaveLength(1); // reported once, not looped
  });

  it("stops with a typed error when buyer-web rejects the token", async () => {
    const web = stubBuyerWeb([queueItem()]);
    await expect(watcher(web.fetchImpl, "wrong-token-0123456789abcdef").runOnce()).rejects.toMatchObject(
      { code: "APPROVAL_UNAUTHORIZED" },
    );
    expect(web.paid).toHaveLength(0);
  });
});
