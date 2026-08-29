/**
 * M3 acceptance criteria at the HTTP surface: a signed request is honoured, a forged one is not,
 * `verified-only` refuses anonymous and unattested agents with an actionable message, the agent
 * that bought is recorded on the order, and a revocation lands before the cart can be paid.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { resolveConfig, usdc } from "@agentgate/core";
import type { CatalogItem, OrderConnector, PaidOrderInput } from "@agentgate/core";
import {
  AGENT_ATTESTATION_HEADER,
  ATTESTATION_VERSION,
  encodeAttestation,
  signAttestation,
  signHttpMessage,
  signRequest,
} from "@agentgate/identity";
import type { SignedAttestation } from "@agentgate/identity";
import { createAgentGateApp } from "./app.js";
import type { AgentGateSite } from "./app.js";
import { parseSiteConfig } from "./config.js";
import type { SiteConfigInput } from "./config.js";
import { SiteStorage } from "./storage.js";
import { payLikeAnAgent, stubFacilitator } from "./test-utils.js";

/** Runs the two-step x402 dance against a cart and returns the final response. */
async function pay(gate: AgentGateSite, cartId: string): Promise<Response> {
  const { first, paid } = await payLikeAnAgent(
    gate.fetch,
    `https://shop.test/agentgate/checkout?cart=${cartId}`,
    { method: "POST" },
  );
  return paid ?? first;
}

const payTo = Keypair.random().publicKey();
const core = resolveConfig({ network: "testnet" });

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
      return { externalOrderId: `woo-${created.length}` };
    },
  };
}

function makeSite(identity?: SiteConfigInput["identity"]): AgentGateSite {
  const site = parseSiteConfig({
    siteUrl: "https://shop.test",
    displayName: "Test Shop",
    payTo,
    platform: "generic",
    ...(identity ? { identity } : {}),
  });
  const storage = new SiteStorage(":memory:");
  storage.upsertItem(ebook);
  return createAgentGateApp({
    site,
    core,
    storage,
    connector: connectorMock(),
    facilitator: stubFacilitator(),
  });
}

const CART_BODY = JSON.stringify({ items: [{ itemId: "ebook", quantity: 1 }] });

/** What an honest agent sends: the signature covers method, path, body, timestamp and nonce. */
function signedCartRequest(
  agentSecret: string,
  options: { attestation?: SignedAttestation; body?: string } = {},
): Request {
  const body = options.body ?? CART_BODY;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...signRequest(agentSecret, { method: "POST", path: "/agentgate/cart", body: CART_BODY }),
  };
  if (options.attestation)
    headers[AGENT_ATTESTATION_HEADER] = encodeAttestation(options.attestation);
  return new Request("https://shop.test/agentgate/cart", { method: "POST", headers, body });
}

function attestationFor(agent: Keypair, owner: Keypair): SignedAttestation {
  const year = 365 * 24 * 3600 * 1000;
  return signAttestation(owner.secret(), {
    v: ATTESTATION_VERSION,
    agent: agent.publicKey(),
    owner: owner.publicKey(),
    name: "Ada's shopping agent",
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + year).toISOString(),
    scope: { sites: ["shop.test"] },
  });
}

describe("agent identity at the HTTP surface (M3)", () => {
  it("open mode: an anonymous agent still buys, and the order says so", async () => {
    const gate = makeSite();
    const res = await gate.fetch(
      new Request("https://shop.test/agentgate/cart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: CART_BODY,
      }),
    );
    expect(res.status).toBe(201);
    const cart = (await res.json()) as { cartId: string; agent: { authenticated: boolean } };
    expect(cart.agent).toEqual({ authenticated: false, attested: false });

    const paid = await pay(gate, cart.cartId);
    expect(paid.status).toBe(200);
    const order = gate.storage.getOrderByCart(cart.cartId);
    expect(order?.agent?.authenticated).toBe(false);
  });

  it("identified mode: a valid signature is recorded on the cart and the order", async () => {
    const gate = makeSite({ mode: "identified" });
    const agent = Keypair.random();
    const res = await gate.fetch(signedCartRequest(agent.secret()));
    expect(res.status).toBe(201);
    const cart = (await res.json()) as {
      cartId: string;
      agent: { authenticated: boolean; agentKey: string };
    };
    expect(cart.agent.authenticated).toBe(true);
    expect(cart.agent.agentKey).toBe(agent.publicKey());

    await pay(gate, cart.cartId);
    const order = gate.storage.getOrderByCart(cart.cartId);
    expect(order?.agent?.agentKey).toBe(agent.publicKey());
  });

  it("rejects a signature that does not cover the body actually sent", async () => {
    const gate = makeSite({ mode: "identified" });
    const agent = Keypair.random();
    const tampered = JSON.stringify({ items: [{ itemId: "ebook", quantity: 9 }] });
    const res = await gate.fetch(signedCartRequest(agent.secret(), { body: tampered }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_SIGNATURE_INVALID");
  });

  it("rejects a replayed request", async () => {
    const gate = makeSite({ mode: "identified" });
    const agent = Keypair.random();
    const request = signedCartRequest(agent.secret());
    expect((await gate.fetch(request.clone())).status).toBe(201);
    const replay = await gate.fetch(request);
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe(
      "AGENT_NONCE_REUSED",
    );
  });

  it("verified-only: anonymous and unattested agents are refused with an actionable hint", async () => {
    const gate = makeSite({ mode: "verified-only" });

    const anonymous = await gate.fetch(
      new Request("https://shop.test/agentgate/cart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: CART_BODY,
      }),
    );
    expect(anonymous.status).toBe(401);
    const anonBody = (await anonymous.json()) as { error: { code: string; hint: string } };
    expect(anonBody.error.code).toBe("AGENT_IDENTITY_REQUIRED");
    expect(anonBody.error.hint).toContain("x-agent-signature");

    const unattested = await gate.fetch(signedCartRequest(Keypair.random().secret()));
    expect(unattested.status).toBe(403);
    expect(((await unattested.json()) as { error: { code: string } }).error.code).toBe(
      "AGENT_ATTESTATION_INVALID",
    );
  });

  it("verified-only: an attested agent buys and is registered on first contact", async () => {
    const gate = makeSite({ mode: "verified-only" });
    const agent = Keypair.random();
    const owner = Keypair.random();
    const res = await gate.fetch(
      signedCartRequest(agent.secret(), { attestation: attestationFor(agent, owner) }),
    );
    expect(res.status).toBe(201);
    const cart = (await res.json()) as { cartId: string; agent: { attested: boolean } };
    expect(cart.agent.attested).toBe(true);

    const registered = gate.identity.list();
    expect(registered).toHaveLength(1);
    expect(registered[0]?.owner).toBe(owner.publicKey());

    const paid = await pay(gate, cart.cartId);
    expect(paid.status).toBe(200);
  });

  it("a revocation between quote and payment stops the payment", async () => {
    const gate = makeSite({ mode: "verified-only" });
    const agent = Keypair.random();
    const owner = Keypair.random();
    const res = await gate.fetch(
      signedCartRequest(agent.secret(), { attestation: attestationFor(agent, owner) }),
    );
    const { cartId } = (await res.json()) as { cartId: string };

    gate.identity.revoke(agent.publicKey(), "owner reported the key as lost");

    const paid = await pay(gate, cartId);
    expect(paid.status).toBe(403);
    const body = (await paid.json()) as { error: { code: string; hint: string } };
    expect(body.error.code).toBe("AGENT_REVOKED");
    expect(body.error.hint).toBe("owner reported the key as lost");
    expect(gate.storage.getOrderByCart(cartId)).toBeUndefined();
  });
});

describe("RFC 9421 signatures at the HTTP surface", () => {
  /** What an agent following the x402 `http-message-signatures` extension sends. */
  function rfc9421CartRequest(
    agentSecret: string,
    options: { attestation?: SignedAttestation } = {},
  ): Request {
    const url = "https://shop.test/agentgate/cart";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...signHttpMessage(agentSecret, { method: "POST", url, body: CART_BODY }),
    };
    if (options.attestation)
      headers[AGENT_ATTESTATION_HEADER] = encodeAttestation(options.attestation);
    return new Request(url, { method: "POST", headers, body: CART_BODY });
  }

  it("accepts a standards-compliant agent without our own headers", async () => {
    const gate = makeSite({ mode: "identified" });
    const agent = Keypair.random();
    const res = await gate.fetch(rfc9421CartRequest(agent.secret()));
    expect(res.status).toBe(201);
    const cart = (await res.json()) as { agent: { authenticated: boolean; agentKey: string } };
    expect(cart.agent.authenticated).toBe(true);
    expect(cart.agent.agentKey).toBe(agent.publicKey());
  });

  it("refuses a replay, and a body swapped after signing", async () => {
    const gate = makeSite({ mode: "identified" });
    const agent = Keypair.random();
    const request = rfc9421CartRequest(agent.secret());
    expect((await gate.fetch(request.clone())).status).toBe(201);
    const replay = await gate.fetch(request);
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe(
      "AGENT_NONCE_REUSED",
    );

    const signed = rfc9421CartRequest(agent.secret());
    const tampered = new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: JSON.stringify({ items: [{ itemId: "ebook", quantity: 9 }] }),
    });
    const res = await gate.fetch(tampered);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; details: { profile: string } } };
    expect(body.error.code).toBe("AGENT_SIGNATURE_INVALID");
    expect(body.error.details.profile).toBe("rfc9421");
  });

  it("carries an owner attestation through to verified-only mode", async () => {
    const gate = makeSite({ mode: "verified-only" });
    const agent = Keypair.random();
    const owner = Keypair.random();
    const res = await gate.fetch(
      rfc9421CartRequest(agent.secret(), { attestation: attestationFor(agent, owner) }),
    );
    expect(res.status).toBe(201);
    const cart = (await res.json()) as { cartId: string; agent: { attested: boolean } };
    expect(cart.agent.attested).toBe(true);
    expect((await pay(gate, cart.cartId)).status).toBe(200);
  });

  it("honours a revocation regardless of which profile signed the request", async () => {
    const gate = makeSite({ mode: "verified-only" });
    const agent = Keypair.random();
    const owner = Keypair.random();
    await gate.fetch(rfc9421CartRequest(agent.secret(), { attestation: attestationFor(agent, owner) }));
    gate.identity.revoke(agent.publicKey(), "key rotated");

    const res = await gate.fetch(rfc9421CartRequest(agent.secret()));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AGENT_REVOKED");
  });
});
