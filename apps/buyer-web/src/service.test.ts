/**
 * The service layer against a real in-process store: mandate round-trip, proposal lifecycle,
 * storage persistence, and the honesty rules (no secret ever stored, no payment ever faked).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { isAgentPOSError } from "@agentpos/core";
import { BuyerWebService } from "./service.js";
import type { SaveProfileInput } from "./service.js";
import { BuyerWebStorage } from "./storage.js";
import { STORE_URL, inProcessStore } from "./test-utils.js";

function makeService(options: { file?: string; withStore?: boolean } = {}) {
  const storage = new BuyerWebStorage(options.file ?? ":memory:");
  const service = new BuyerWebService({
    storage,
    ...(options.withStore === false ? {} : { fetchImpl: inProcessStore().fetchImpl }),
  });
  return { storage, service };
}

const baseProfile: SaveProfileInput = {
  maxPerTx: "25",
  maxTotal: "100",
  period: "week",
  stores: [STORE_URL],
};

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
      ...baseProfile,
      allowPhysicalGoods: true,
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
