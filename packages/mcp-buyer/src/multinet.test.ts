/**
 * The mandate across networks (M2, M3): the agent pays only on networks the human named, and
 * the period limit adds up what it spent on all of them. The store takes Stellar and Arc; the
 * pay-fetch stands in for the x402 client and pays on the first network it holds a scheme for.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, SupportedResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  FAMILY_ADDRESS_CHECKS,
  registerChainProfile,
  resetChainProfilesForTests,
  resolveConfig,
  usdc,
  usdcOnChain,
} from "@agentpos/core";
import type {
  BuyerLimits,
  BuyerNetworkExtension,
  CatalogItem,
  OrderConnector,
} from "@agentpos/core";
import { createAgentPOSApp, parseSiteConfig, SiteStorage } from "@agentpos/site";
import { BuyerService } from "./buyer.js";
import type { BuyerNetwork } from "./buyer.js";
import { mandateSchema } from "./mandate.js";
import type { MandateJson } from "./mandate.js";
import { approve, getApproval } from "./profile.js";
import type { Profile } from "./profile.js";
import { SpendingLog } from "./spending.js";

const STELLAR = "stellar:testnet";
const ARC = "eip155:5042002";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const core = resolveConfig({ network: "testnet" });

const ebook: CatalogItem = {
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
};

/** Settles on whichever network the payment names, except one whose screen declines it. */
function facilitator(declineOn: () => string | undefined = () => undefined): FacilitatorClient {
  let n = 0;
  return {
    verify: async () => ({ isValid: true, payer: "payer" }),
    settle: async (_p, r) => {
      if (r.network === declineOn()) {
        throw new Error('Facilitator settle failed (403): {"code":403,"message":"Forbidden"}');
      }
      return {
        success: true,
        transaction: `tx_${++n}_${r.network}`,
        network: r.network,
        payer: "payer",
        amount: r.amount,
      };
    },
    getSupported: async (): Promise<SupportedResponse> => ({
      kinds: [
        { x402Version: 2, scheme: "exact", network: STELLAR },
        { x402Version: 2, scheme: "exact", network: ARC, extra: { name: "USDC", version: "2" } },
      ],
      extensions: [],
      signers: {},
    }),
  } as FacilitatorClient;
}

/** The Arc rail as a buyer sees it, without a real signer: enough to choose and cap. */
const arcNetwork: BuyerNetwork = (max) => ({
  network: ARC,
  client: {} as BuyerNetworkExtension["client"],
  asset: ARC_USDC,
  maxPerPayment: usdcOnChain(max, ARC),
});

describe("mandate across networks", () => {
  let home: string;
  let site: ReturnType<typeof createAgentPOSApp>;
  let spending: SpendingLog;
  let paidWith: { limits: BuyerLimits; extensions: ReadonlyArray<BuyerNetworkExtension> }[];
  let declineOn: string | undefined;

  const fetchImpl: typeof fetch = (input, init) =>
    site.fetch(
      new Request(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        init,
      ),
    );

  // Like the x402 client: a network is payable when it has a scheme and a ceiling above zero.
  const payFetchFactory = (
    _core: unknown,
    _signer: unknown,
    limits: BuyerLimits,
    extensions: ReadonlyArray<BuyerNetworkExtension>,
  ) => {
    paidWith.push({ limits, extensions });
    const payable = [
      ...(limits.maxPerPayment > 0n ? [STELLAR] : []),
      ...extensions.filter((e) => e.maxPerPayment.minor > 0n).map((e) => e.network),
    ];
    return async (input: string | URL | Request, init?: RequestInit) => {
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
      const accepted = required.accepts.find((a) => payable.includes(a.network));
      if (!accepted) return first;
      const payload = { x402Version: 2, accepted, payload: { stub: true } } as PaymentPayload;
      return fetchImpl(url, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string>),
          ...client.encodePaymentSignatureHeader(payload),
        },
      });
    };
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agentpos-buyer-multinet-"));
    process.env.AGENTPOS_HOME = home;
    registerChainProfile({
      caip2: ARC,
      family: "eip155",
      label: "Arc testnet",
      testnet: true,
      usdcDecimals: 6,
      isValidAddress: FAMILY_ADDRESS_CHECKS.eip155,
    });
    const connector: OrderConnector = {
      platform: "generic",
      getAvailability: async (lines) => lines.map((l) => ({ itemId: l.itemId, available: true })),
      createOrder: async () => ({ externalOrderId: "woo-1" }),
    };
    const storage = new SiteStorage(":memory:");
    storage.upsertItem(ebook);
    const fac = facilitator(() => declineOn);
    site = createAgentPOSApp({
      site: parseSiteConfig({
        siteUrl: "https://shop.test",
        displayName: "Test Shop",
        payTo: Keypair.random().publicKey(),
        platform: "generic",
      }),
      core,
      connector,
      storage,
      facilitator: fac,
      x402Networks: [
        {
          extension: { network: ARC, server: new ExactEvmScheme(), facilitator: fac },
          payTo: "0x75284c0856d11112321014Cd4405dEc5d84393f8",
          asset: ARC_USDC,
        },
      ],
    });
    spending = new SpendingLog(join(home, "spending.jsonl"));
    paidWith = [];
    declineOn = undefined;
  });
  afterEach(() => {
    resetChainProfilesForTests();
    rmSync(home, { recursive: true, force: true });
    delete process.env.AGENTPOS_HOME;
  });

  const buyer = (mandate: Partial<MandateJson>, networks: BuyerNetwork[] = [arcNetwork]) => {
    const address = Keypair.random().publicKey();
    const profile: Profile = {
      name: "test",
      network: "testnet",
      keyFile: "unused",
      address,
      mandate: mandateSchema.parse({ maxPerTx: "10", maxTotal: "15", ...mandate }),
      buyer: { email: "human@example.com", name: "Human" },
      sites: ["https://shop.test"],
      createdAt: new Date().toISOString(),
    };
    return new BuyerService({
      profile,
      fetchImpl,
      payFetchFactory,
      networks,
      spendingLog: spending,
      core,
      signer: { kind: "local-keypair", network: "testnet", address } as never,
    });
  };

  const buyEbook = async (b: BuyerService) => {
    const cart = await b.createCart("https://shop.test", [{ itemId: "ebook", quantity: 1 }]);
    return b.buy("https://shop.test", cart.cartId);
  };

  it("never pays on a network the human did not name, even with its rail installed (M3)", async () => {
    const result = await buyEbook(buyer({}));
    expect(result.receipt.network).toBe(STELLAR);
    expect(paidWith[0]?.extensions).toEqual([]);
  });

  it("pays on Arc when the mandate allows only Arc, with no ceiling left on Stellar", async () => {
    const result = await buyEbook(buyer({ allowedNetworks: [ARC] }));
    expect(result.receipt.network).toBe(ARC);
    expect(paidWith[0]?.limits.maxPerPayment).toBe(0n);
    expect(paidWith[0]?.extensions.map((e) => [e.network, e.maxPerPayment.minor])).toEqual([
      [ARC, 2_000_000n], // 2 USDC in Arc's 6 decimals
    ]);
    const [entry] = spending.entries();
    expect(entry).toMatchObject({ network: ARC, asset: ARC_USDC });
    expect(entry?.amountMinor).toBe(usdc("2").toString()); // the catalog's unit, 7 decimals
  });

  it("adds up spending on every network against one period limit (M2)", async () => {
    spending.append({
      ts: new Date().toISOString(),
      profile: "test",
      site: "https://other.test",
      cartId: "cart_x",
      orderId: "ord_x",
      txHash: "tx_stellar",
      network: STELLAR,
      asset: "USDC",
      amountMinor: usdc("14").toString(),
      summary: "earlier purchase on Stellar",
    });
    await expect(buyEbook(buyer({ allowedNetworks: [STELLAR, ARC] }))).rejects.toMatchObject({
      code: "MANDATE_EXCEEDED",
    });
    expect(paidWith).toEqual([]);
  });

  it("refuses with a clear code when no allowed network can be paid here", async () => {
    await expect(buyEbook(buyer({ allowedNetworks: [ARC] }, []))).rejects.toMatchObject({
      code: "NETWORK_NOT_ALLOWED",
    });
  });

  it("never moves a declined payment to another network without the human (F3)", async () => {
    declineOn = STELLAR;
    const b = buyer({ allowedNetworks: [STELLAR, ARC] });
    const cart = await b.createCart("https://shop.test", [{ itemId: "ebook", quantity: 1 }]);
    await expect(b.buy("https://shop.test", cart.cartId)).rejects.toMatchObject({
      code: "PAYMENT_DECLINED",
      retryable: false,
      details: { network: STELLAR },
    });
    expect(getApproval("test", cart.cartId)?.declinedOn).toEqual([STELLAR]);

    // The agent tries again on its own: nothing is signed, on any network.
    await expect(b.buy("https://shop.test", cart.cartId)).rejects.toMatchObject({
      code: "PAYMENT_DECLINED",
      details: { declinedOn: [STELLAR] },
    });
    expect(paidWith).toHaveLength(1);
    expect(spending.entries()).toEqual([]);

    // The human approves: it pays on Arc, and Stellar gets no ceiling at all.
    approve("test", cart.cartId);
    const result = await b.buy("https://shop.test", cart.cartId);
    expect(result.receipt.network).toBe(ARC);
    expect(paidWith[1]?.limits.maxPerPayment).toBe(0n);
    expect(getApproval("test", cart.cartId)).toBeUndefined();
  });
});
