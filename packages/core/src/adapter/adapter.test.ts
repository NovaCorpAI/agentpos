import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { resolveConfig } from "../config.js";
import { usdc } from "../money.js";
import { createLocalKeypairSigner, createSigner } from "../signer.js";
import { AgentGateError } from "../errors.js";
import { buildRouteConfig, createBuyerClient, createResourceServer, toReceipt } from "./x402.js";
import { buildUcpProfile } from "./ucp.js";
import { buildAcpFeed } from "./acp.js";
import { ADAPTER_VERSION, PROTOCOL_VERSIONS } from "./versions.js";

const cfg = resolveConfig();
const payTo = Keypair.random().publicKey();

describe("x402 adapter", () => {
  it("builds a resource server registered on the Stellar testnet exact scheme", () => {
    const server = createResourceServer(cfg);
    expect(server.hasRegisteredScheme(cfg.caip2, "exact")).toBe(true);
    expect(server.hasRegisteredScheme("stellar:pubnet", "exact")).toBe(false);
  });

  it("emits integer USDC asset amounts and the adapter version in route configs", () => {
    const route = buildRouteConfig(cfg, {
      payTo,
      amount: usdc("1.25"),
      description: "Test item",
      reference: "order_1",
    });
    const accepts = Array.isArray(route.accepts) ? route.accepts : [route.accepts];
    expect(accepts).toHaveLength(1);
    const accept = accepts[0]!;
    expect(accept.network).toBe("stellar:testnet");
    expect(accept.payTo).toBe(payTo);
    expect(accept.price).toEqual({ asset: USDC_TESTNET_ADDRESS, amount: "12500000" });
    expect(accept.extra).toMatchObject({ adapterVersion: ADAPTER_VERSION, reference: "order_1" });
  });

  it("creates a buyer client from a local keypair signer", () => {
    const signer = createLocalKeypairSigner(Keypair.random().secret(), "testnet");
    expect(signer.kind).toBe("local-keypair");
    expect(signer.address).toMatch(/^G[A-Z2-7]{55}$/);
    const client = createBuyerClient(cfg, signer, { maxPerPayment: usdc("5") });
    expect(client).toBeDefined();
  });

  it("converts settle responses into receipts and rejects failures", () => {
    const ok = toReceipt({
      success: true,
      transaction: "abc",
      network: "stellar:testnet",
      payer: "GXYZ",
      amount: "5",
    });
    expect(ok).toMatchObject({
      txHash: "abc",
      payer: "GXYZ",
      amount: 5n,
      adapterVersion: ADAPTER_VERSION,
    });
    expect(() =>
      toReceipt({ success: false, transaction: "", network: "stellar:testnet", errorReason: "x" }),
    ).toThrowError(AgentGateError);
  });
});

describe("signer factory", () => {
  it("rejects invalid seeds and unimplemented kinds with typed errors", () => {
    expect(() => createLocalKeypairSigner("nope", "testnet")).toThrowError(AgentGateError);
    try {
      createSigner({ kind: "wallets-kit", network: "testnet" });
      expect.unreachable();
    } catch (err) {
      expect((err as AgentGateError).code).toBe("SIGNER_NOT_IMPLEMENTED");
    }
  });
});

describe("UCP / ACP surfaces", () => {
  it("builds a UCP business profile with the x402 Stellar payment handler", () => {
    const profile = buildUcpProfile({
      siteUrl: "https://shop.example/",
      basePath: "/agentgate",
      network: "stellar:testnet",
      asset: "USDC",
      assetAddress: USDC_TESTNET_ADDRESS,
      payTo,
    });
    const handler =
      profile.ucp.payment_handlers[PROTOCOL_VERSIONS.agentgate.paymentHandlerName]?.[0];
    expect(handler?.id).toBe("x402-stellar");
    expect(handler?.config.payTo).toBe(payTo);
    expect(profile.ucp.services[PROTOCOL_VERSIONS.agentgate.serviceName]?.[0]?.endpoint).toBe(
      "https://shop.example/agentgate",
    );
    expect(profile.ucp["com.novacorplabs.agentgate"]?.adapterVersion).toBe(ADAPTER_VERSION);
    // Honesty: no UCP shopping capabilities are claimed until implemented.
    expect(profile.ucp.capabilities).toEqual({});
  });

  it("builds an ACP feed with fiat prices in ISO minor units", () => {
    const feed = buildAcpFeed([
      {
        id: "sku-1",
        title: "Mug",
        description: "Ceramic mug, 350 ml",
        url: "https://shop.example/mug",
        priceSrc: { amount: "9.90", currency: "USD" },
        available: true,
      },
    ]);
    expect(feed.products[0]?.variants[0]?.price).toEqual({ amount: 990, currency: "USD" });
  });
});
