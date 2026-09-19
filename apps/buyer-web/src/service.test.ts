/**
 * The service layer against a real in-process store: mandate round-trip, proposal lifecycle,
 * storage persistence, and the honesty rules (no secret ever stored, no payment ever faked).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createLogger, isAgentPOSError } from "@agentpos/core";
import type { Logger } from "@agentpos/core";
import { BuyerWebService, parseAttributePairs } from "./service.js";
import type { SaveProfileInput, ShippingInput } from "./service.js";
import { BuyerWebStorage } from "./storage.js";
import { buyerWebProfileSchema } from "./types.js";
import {
  MARKET_A,
  MARKET_B,
  MARKET_DOWN,
  MARKET_LEGACY,
  STORE_URL,
  inProcessMarket,
  inProcessStore,
} from "./test-utils.js";

function makeService(options: { file?: string; withStore?: boolean; logger?: Logger } = {}) {
  const storage = new BuyerWebStorage(options.file ?? ":memory:");
  const service = new BuyerWebService({
    storage,
    ...(options.withStore === false ? {} : { fetchImpl: inProcessStore().fetchImpl }),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  return { storage, service };
}

const baseProfile: SaveProfileInput = {
  maxPerTx: "25",
  maxTotal: "100",
  period: "week",
  stores: [STORE_URL],
};

/** A complete address, with the country in lowercase so normalization is exercised. */
const SHIPPING: ShippingInput = {
  name: "Ana Perez",
  line1: "Avenida Siempre Viva 742",
  line2: "Depto 31",
  city: "Santiago",
  region: "Region Metropolitana",
  postalCode: "8320000",
  country: "cl",
  phone: "+56911111111",
};

/** Mandate that allows physical goods and can actually receive a parcel. */
const physicalProfile: SaveProfileInput = {
  ...baseProfile,
  allowPhysicalGoods: true,
  email: "ana@example.com",
  shipping: SHIPPING,
};

interface ShapedError {
  code: string;
  message: string;
  hint: string;
}

function err(fn: () => unknown): ShapedError {
  try {
    fn();
  } catch (e) {
    if (isAgentPOSError(e)) return { code: e.code, message: e.message, hint: e.hint };
    throw e;
  }
  throw new Error("expected an AgentPOSError");
}

async function err2(fn: () => Promise<unknown>): Promise<ShapedError> {
  try {
    await fn();
  } catch (e) {
    if (isAgentPOSError(e)) return { code: e.code, message: e.message, hint: e.hint };
    throw e;
  }
  throw new Error("expected an AgentPOSError");
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (isAgentPOSError(err)) return err.code;
    throw err;
  }
  throw new Error("expected an AgentPOSError");
}

async function codeAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (isAgentPOSError(err)) return err.code;
    throw err;
  }
  throw new Error("expected an AgentPOSError");
}

describe("mandate and profile", () => {
  it("round-trips the mandate through validation and storage", () => {
    const { service } = makeService();
    const wallet = Keypair.random().publicKey();
    service.saveProfile({
      ...physicalProfile,
      email: "buyer@example.com",
      walletAddress: wallet,
    });
    const profile = service.getProfile();
    expect(profile?.mandate.maxPerTx).toBe("25");
    expect(profile?.mandate.maxTotal).toBe("100");
    expect(profile?.mandate.period).toBe("week");
    expect(profile?.mandate.allowedSellers).toEqual(["shop.test"]);
    expect(profile?.mandate.allowPhysicalGoods).toBe(true);
    expect(profile?.email).toBe("buyer@example.com");
    expect(profile?.walletAddress).toBe(wallet);
  });

  it("refuses a secret key where the public address goes, and stores nothing", () => {
    const { service, storage } = makeService();
    expect(
      code(() => service.saveProfile({ ...baseProfile, walletAddress: Keypair.random().secret() })),
    ).toBe("SECRET_IN_CONFIG");
    expect(storage.getProfile()).toBeUndefined();
  });

  it("rejects an invalid mandate with actionable issues", () => {
    const { service } = makeService();
    expect(code(() => service.saveProfile({ ...baseProfile, maxPerTx: "not-money" }))).toBe(
      "CONFIG_INVALID",
    );
  });

  it("persists the profile across a close and reopen", () => {
    const file = join(mkdtempSync(join(tmpdir(), "agentpos-buyer-web-")), "buyer.sqlite");
    const first = makeService({ file, withStore: false });
    first.service.saveProfile(baseProfile);
    first.storage.close();

    const second = makeService({ file, withStore: false });
    expect(second.service.getProfile()?.mandate.maxPerTx).toBe("25");
    second.storage.close();
  });
});

describe("shipping address (server side, authoritative)", () => {
  it("saves a complete address with physical goods on, and normalizes the country to ISO-2", () => {
    const { service } = makeService();
    service.saveProfile(physicalProfile);
    const profile = service.getProfile();
    expect(profile?.shipping).toEqual({
      name: "Ana Perez",
      line1: "Avenida Siempre Viva 742",
      line2: "Depto 31",
      city: "Santiago",
      region: "Region Metropolitana",
      postalCode: "8320000",
      country: "CL",
      phone: "+56911111111",
    });
    expect(service.status().shipping).toEqual({ city: "Santiago", country: "CL" });
    expect(service.status().physicalWithoutShipping).toBe(false);
  });

  const required: Array<{ field: keyof ShippingInput; says: string }> = [
    { field: "name", says: "el nombre de quien recibe" },
    { field: "line1", says: "la direccion (linea 1)" },
    { field: "city", says: "la ciudad" },
    { field: "postalCode", says: "el codigo postal" },
    { field: "country", says: "el pais" },
  ];
  for (const { field, says } of required) {
    it(`refuses physical goods without ${field}, naming that field and why`, () => {
      const { service, storage } = makeService();
      const problem = err(() =>
        service.saveProfile({
          ...physicalProfile,
          shipping: { ...SHIPPING, [field]: "" },
        }),
      );
      expect(problem.code).toBe("SHIPPING_REQUIRED");
      expect(problem.message).toContain(says);
      expect(problem.message).toContain("la tienda no puede despachar sin");
      expect(problem.hint).toContain("Permitir bienes fisicos");
      // Nothing half-saved: a mandate that could never ship is never stored.
      expect(storage.getProfile()).toBeUndefined();
    });
  }

  it("refuses physical goods with no address at all", () => {
    const { service } = makeService();
    const problem = err(() =>
      service.saveProfile({ ...baseProfile, allowPhysicalGoods: true, email: "ana@example.com" }),
    );
    expect(problem.code).toBe("SHIPPING_REQUIRED");
    expect(problem.message).toContain("Falta la direccion de despacho");
  });

  it("refuses physical goods without a contact email", () => {
    const { service } = makeService();
    const problem = err(() => service.saveProfile({ ...physicalProfile, email: "" }));
    expect(problem.code).toBe("SHIPPING_REQUIRED");
    expect(problem.message).toContain("correo de contacto");
    expect(problem.message).toContain("la tienda no puede despachar sin");
  });

  it("refuses a country that is not a two-letter code", () => {
    const { service } = makeService();
    const problem = err(() =>
      service.saveProfile({ ...physicalProfile, shipping: { ...SHIPPING, country: "Chile" } }),
    );
    expect(problem.code).toBe("SHIPPING_REQUIRED");
    expect(problem.message).toContain("codigo ISO de dos letras");
  });

  it("saves with physical goods off and no address at all", () => {
    const { service } = makeService();
    service.saveProfile(baseProfile);
    expect(service.getProfile()?.shipping).toBeUndefined();
    expect(service.status().shipping).toBeUndefined();
    expect(service.status().physicalWithoutShipping).toBe(false);
  });

  it("keeps an address already on file when the section comes back empty", () => {
    const { service } = makeService();
    service.saveProfile(physicalProfile);
    service.saveProfile({ ...baseProfile, email: "ana@example.com", allowPhysicalGoods: false });
    expect(service.getProfile()?.shipping?.city).toBe("Santiago");
  });

  it("names the missing field even with physical goods off, instead of dropping what was typed", () => {
    const { service } = makeService();
    const problem = err(() =>
      service.saveProfile({ ...baseProfile, shipping: { city: "Santiago" } }),
    );
    expect(problem.code).toBe("CONFIG_INVALID");
    expect(problem.message).toContain("el nombre de quien recibe");
    expect(problem.hint).toContain("vacia");
  });

  it("hands the address and the contact to the store, so a physical purchase is quotable", async () => {
    const { service } = makeService();
    service.saveProfile(physicalProfile);
    const proposal = await service.propose("poster", STORE_URL);
    expect(proposal.physical).toBe(true);
    expect(proposal.amount).toBe("12");
    expect(proposal.cartId).toBeTruthy();
  });

  it("refuses a physical proposal early when the saved mandate has no address", async () => {
    const { service, storage } = makeService();
    // The broken state this fix is about: an older profile with physical goods and nowhere
    // to ship. saveProfile cannot create it any more, so it is written directly.
    storage.saveProfile(
      buyerWebProfileSchema.parse({
        id: "default",
        network: "testnet",
        stores: [STORE_URL],
        email: "ana@example.com",
        mandate: {
          maxPerTx: "25",
          maxTotal: "100",
          period: "week",
          allowedSellers: ["shop.test"],
          allowPhysicalGoods: true,
          shippingAddressLocked: true,
        },
        updatedAt: new Date().toISOString(),
      }),
    );
    expect(service.status().physicalWithoutShipping).toBe(true);
    const problem = await err2(() => service.propose("poster", STORE_URL));
    expect(problem.code).toBe("SHIPPING_REQUIRED");
    expect(problem.message).toContain("No hay direccion de despacho guardada");
    expect(problem.hint).toContain("Permitir bienes fisicos");
    // Refused before the cart existed: nothing to approve, nothing to fail at payment time.
    expect(service.proposalHistory()).toHaveLength(0);
    // A digital item on the same broken profile still works.
    const ok = await service.propose("sticker", STORE_URL);
    expect(ok.physical).toBe(false);
  });

  it("never writes a full address to a log line or to the activity history", async () => {
    const lines: string[] = [];
    const { service, storage } = makeService({
      logger: createLogger({ sink: (line) => lines.push(line) }),
    });
    service.saveProfile(physicalProfile);
    await service.propose("poster", STORE_URL);
    const logged = lines.join("\n");
    expect(logged).toContain("buyer_web.profile_saved");
    expect(logged).toContain("Santiago");
    expect(logged).not.toContain("Avenida Siempre Viva");
    expect(logged).not.toContain("Depto 31");
    expect(logged).not.toContain("8320000");
    expect(logged).not.toContain("+56911111111");
    const history = JSON.stringify(storage.listActivity());
    expect(history).not.toContain("Avenida Siempre Viva");
    expect(history).not.toContain("8320000");
    expect(history).toContain("shippingOnFile");
  });
});

describe("offers", () => {
  it("searches the mandated stores", async () => {
    const { service } = makeService();
    service.saveProfile(baseProfile);
    const offers = await service.searchOffers("mug");
    expect(offers).toHaveLength(1);
    expect(offers.at(0)?.id).toBe("mug");
    expect(offers.at(0)?.siteName).toBe("Faro Demo Store");
  });

  it("refuses to act before a mandate exists", async () => {
    const { service } = makeService();
    expect(await codeAsync(() => service.searchOffers("mug"))).toBe("CONFIG_INVALID");
  });
});

describe("market call", () => {
  function makeMarket(profile: Partial<SaveProfileInput> = {}) {
    const storage = new BuyerWebStorage(":memory:");
    const service = new BuyerWebService({ storage, fetchImpl: inProcessMarket().fetchImpl });
    service.saveProfile({
      maxPerTx: "25",
      maxTotal: "100",
      period: "week",
      stores: [MARKET_A, MARKET_B, MARKET_LEGACY, MARKET_DOWN],
      ...profile,
    });
    return { storage, service };
  }

  it("asks every store at once and returns comparable offers, cheapest total first", async () => {
    const { service } = makeMarket();
    const result = await service.marketCall({
      what: "lamina",
      attributes: { Fondo: "blanco", Passepartout: "con" },
      quantity: 2,
    });
    expect(result.offers.map((o) => o.itemId)).toEqual([
      "vieja-blanco",
      "dos-blanco",
      "uno-blanco",
    ]);
    expect(result.offers.map((o) => o.totalUsdc)).toEqual(["24", "36", "40"]);
    expect(result.offers.at(0)?.store.name).toBe("Galeria Vieja");
    expect(result.query.quantity).toBe(2);
  });

  it("names the stores that did not answer and the ones it had to filter itself", async () => {
    const { service } = makeMarket();
    const result = await service.marketCall({ what: "lamina", attributes: { Fondo: "blanco" } });
    const byHost = new Map(result.stores.map((s) => [s.host, s.state]));
    expect(byHost.get("uno.test")).toBe("ok");
    expect(byHost.get("dos.test")).toBe("ok");
    expect(byHost.get("vieja.test")).toBe("unsupported-filters");
    expect(byHost.get("rota.test")).toBe("error");
    expect(result.offers.length).toBe(3);
  });

  it("merges the facets of every store", async () => {
    const { service } = makeMarket();
    const result = await service.marketCall({ what: "lamina" });
    expect(result.facets.Fondo).toEqual([
      { value: "blanco", count: 3 },
      { value: "negro", count: 2 },
    ]);
  });

  it("judges payability against what this platform approved, not a log it cannot see", async () => {
    const { service } = makeMarket({ maxPerTx: "30", maxTotal: "30" });
    const before = await service.marketCall({ what: "lamina", attributes: { Fondo: "blanco" } });
    expect(before.offers.every((o) => o.mandate.payable)).toBe(true);
    // Approving one proposal commits 18 USDC of the 30 allowed this period.
    const proposal = await service.propose("dos-blanco", MARKET_B);
    service.approve(proposal.id);
    const after = await service.marketCall({ what: "lamina", attributes: { Fondo: "blanco" } });
    const expensive = after.offers.find((o) => o.itemId === "uno-blanco");
    expect(expensive?.mandate.payable).toBe(false);
    expect(expensive?.mandate.blocks.map((b) => b.reason)).toEqual(["period_budget"]);
    expect(expensive?.mandate.blocks[0]?.message).toContain("18 USDC already committed");
    // Still listed, never hidden: the human decides what to do about their own limit.
    expect(after.offers.map((o) => o.itemId)).toContain("uno-blanco");
  });

  it("records the call in the activity log", async () => {
    const { service, storage } = makeMarket();
    await service.marketCall({ what: "lamina" });
    const entry = storage.listActivity().at(0);
    expect(entry?.kind).toBe("search");
    expect(entry?.data.query).toBe("lamina");
    expect(entry?.data.stores).toBe(4);
    expect(entry?.data.answered).toBe(3);
  });

  it("refuses to act before a mandate exists", async () => {
    const { service } = makeService();
    expect(await codeAsync(() => service.marketCall({ what: "lamina" }))).toBe("CONFIG_INVALID");
  });

  it("reads clave=valor rows and refuses a row that is not one", () => {
    expect(parseAttributePairs([" Fondo=blanco ", "", "Passepartout = con "])).toEqual({
      Fondo: "blanco",
      Passepartout: "con",
    });
    expect(err(() => parseAttributePairs(["blanco"])).code).toBe("CONFIG_INVALID");
    expect(err(() => parseAttributePairs(["=blanco"])).hint).toContain("clave=valor");
  });
});

describe("proposal lifecycle", () => {
  it("propose freezes a real quote from the store as a pending proposal", async () => {
    const { service } = makeService();
    service.saveProfile(baseProfile);
    const proposal = await service.propose("sticker", STORE_URL);
    expect(proposal.status).toBe("pending");
    expect(proposal.amount).toBe("1.5");
    expect(proposal.title).toBe("1 x Sticker");
    expect(proposal.cartId).toBeTruthy();
    expect(proposal.checkoutUrl).toContain("checkout");
    expect(service.pendingProposals()).toHaveLength(1);
    expect(service.status().pendingProposals).toBe(1);
  });

  it("approve marks the proposal approved and hands back instructions, never a fake payment", async () => {
    const { service } = makeService();
    service.saveProfile(baseProfile);
    const proposal = await service.propose("sticker", STORE_URL);
    const result = service.approve(proposal.id);
    expect(result.proposal.status).toBe("approved");
    expect(result.instructions.signer).toBe("local");
    expect(result.instructions.cli).toContain("agentpos-buyer");
    expect(result.instructions.note).toContain("awaiting signature");
    expect(result.instructions.checkoutUrl).toBe(proposal.checkoutUrl);
    // No payment fields exist anywhere: there was no payment.
    expect(JSON.stringify(result)).not.toContain("txHash");
    expect(service.status().approvedAwaitingSignature).toBe(1);
    // Idempotent: approving again returns the same decision.
    expect(service.approve(proposal.id).proposal.decidedAt).toBe(result.proposal.decidedAt);
  });

  it("reject ends the proposal, and it cannot be approved afterwards", async () => {
    const { service } = makeService();
    service.saveProfile(baseProfile);
    const proposal = await service.propose("mug", STORE_URL, 2);
    expect(proposal.amount).toBe("19.8");
    const rejected = service.reject(proposal.id);
    expect(rejected.status).toBe("rejected");
    expect(code(() => service.approve(proposal.id))).toBe("APPROVAL_REJECTED");
  });

  it("answers APPROVAL_NOT_FOUND for a proposal that never existed", () => {
    const { service } = makeService();
    expect(code(() => service.approve("nope"))).toBe("APPROVAL_NOT_FOUND");
    expect(code(() => service.reject("nope"))).toBe("APPROVAL_NOT_FOUND");
  });

  it("blocks a proposal over the per-purchase limit before bothering the human", async () => {
    const { service } = makeService();
    service.saveProfile({ ...baseProfile, maxPerTx: "5" });
    expect(await codeAsync(() => service.propose("mug", STORE_URL))).toBe("MANDATE_EXCEEDED");
    expect(service.proposalHistory()).toHaveLength(0);
  });

  it("blocks a store outside the seller allowlist", async () => {
    const { service } = makeService();
    service.saveProfile({ ...baseProfile, stores: ["https://allowed.example"] });
    expect(await codeAsync(() => service.propose("sticker", STORE_URL))).toBe("SELLER_UNVERIFIED");
  });

  it("counts approved proposals against the period ceiling", async () => {
    const { service } = makeService();
    service.saveProfile({ ...baseProfile, maxTotal: "2.5" });
    const first = await service.propose("sticker", STORE_URL);
    service.approve(first.id);
    expect(await codeAsync(() => service.propose("sticker", STORE_URL))).toBe("MANDATE_EXCEEDED");
  });
});

describe("activity log", () => {
  it("records every step, append-only, newest first", async () => {
    const { service, storage } = makeService();
    service.saveProfile(baseProfile);
    const proposal = await service.propose("sticker", STORE_URL);
    service.approve(proposal.id);
    const kinds = storage.listActivity().map((e) => e.kind);
    expect(kinds).toEqual(["proposal.approved", "proposal.created", "profile.saved"]);
    // The storage class exposes no way to rewrite or delete history.
    const mutators = Object.getOwnPropertyNames(Object.getPrototypeOf(storage)).filter((n) =>
      /update.*activity|delete.*activity/i.test(n),
    );
    expect(mutators).toEqual([]);
  });
});
