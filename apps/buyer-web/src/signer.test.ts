/**
 * The signing bridge, buyer-web side: the pending-signature queue and the paid/failed
 * reports. The auth model is deliberately blunt: no SIGNER_TOKEN, no routes at all; with a
 * token, every /api/signer request needs the exact bearer or gets 401.
 */
import { describe, expect, it } from "vitest";
import { createBuyerWebApp } from "./app.js";
import { configFromEnv } from "./config.js";
import { BuyerWebStorage } from "./storage.js";
import { STORE_URL, inProcessStore } from "./test-utils.js";
import type { Proposal, SignerQueueItem } from "./types.js";

const TOKEN = "signer-token-0123456789abcdef"; // 30 chars, >= 24

function makeApp(options: { signerToken?: string } = { signerToken: TOKEN }) {
  const storage = new BuyerWebStorage(":memory:");
  return createBuyerWebApp({
    storage,
    fetchImpl: inProcessStore().fetchImpl,
    ...(options.signerToken !== undefined ? { signerToken: options.signerToken } : {}),
  });
}

type App = ReturnType<typeof makeApp>["app"];

function auth(token = TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function saveProfile(app: App): Promise<void> {
  const res = await app.request("/profile", {
    method: "POST",
    body: new URLSearchParams({
      maxPerTx: "25",
      maxTotal: "100",
      period: "week",
      stores: STORE_URL,
    }),
  });
  expect(res.status).toBe(303);
}

async function propose(app: App, itemId = "sticker"): Promise<Proposal> {
  const res = await app.request("/api/proposals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ storeUrl: STORE_URL, itemId }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { proposal: Proposal }).proposal;
}

async function approvedProposal(app: App): Promise<Proposal> {
  await saveProfile(app);
  const proposal = await propose(app);
  const res = await app.request(`/api/proposals/${proposal.id}/approve`, { method: "POST" });
  expect(res.status).toBe(200);
  return ((await res.json()) as { proposal: Proposal }).proposal;
}

async function markPaid(app: App, proposalId: string, txHash = "tx_abc"): Promise<Response> {
  return app.request("/api/signer/paid", {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ proposalId, txHash, orderId: "order-1" }),
  });
}

describe("mounting and auth", () => {
  it("does not mount the signer routes at all without a token", async () => {
    const { app } = makeApp({});
    expect((await app.request("/api/signer/queue")).status).toBe(404);
    expect((await app.request("/api/signer/paid", { method: "POST" })).status).toBe(404);
    expect((await app.request("/api/signer/failed", { method: "POST" })).status).toBe(404);
  });

  it("refuses a token under 24 characters at construction", () => {
    expect(() => makeApp({ signerToken: "too-short" })).toThrowError(/too short/);
  });

  it("answers 401 with a typed error without a bearer, and with a wrong one", async () => {
    const { app } = makeApp();
    const bare = await app.request("/api/signer/queue");
    expect(bare.status).toBe(401);
    const body = (await bare.json()) as { error: { code: string } };
    expect(body.error.code).toBe("APPROVAL_UNAUTHORIZED");
    const wrong = await app.request("/api/signer/queue", {
      headers: auth("wrong-token-0123456789abcdef"),
    });
    expect(wrong.status).toBe(401);
    const paid = await app.request("/api/signer/paid", { method: "POST" });
    expect(paid.status).toBe(401);
  });

  it("configFromEnv refuses a short SIGNER_TOKEN and passes a proper one through", () => {
    const base = { BUYER_WEB_PORT: "8788" } as NodeJS.ProcessEnv;
    expect(() => configFromEnv({ ...base, SIGNER_TOKEN: "short" })).toThrowError(/too short/);
    expect(configFromEnv({ ...base, SIGNER_TOKEN: TOKEN }).signerToken).toBe(TOKEN);
    expect(configFromEnv(base).signerToken).toBeUndefined();
  });
});

describe("the queue", () => {
  it("lists approved-unpaid proposals with everything a payer needs", async () => {
    const { app } = makeApp();
    const approved = await approvedProposal(app);
    const res = await app.request("/api/signer/queue", { headers: auth() });
    expect(res.status).toBe(200);
    const { proposals } = (await res.json()) as { proposals: SignerQueueItem[] };
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      proposalId: approved.id,
      storeUrl: STORE_URL,
      itemId: "sticker",
      quantity: 1,
      amount: "1.5",
      amountMinor: approved.amountMinor,
    });
  });

  it("excludes pending, rejected and paid proposals", async () => {
    const { app } = makeApp();
    await saveProfile(app);
    await propose(app); // stays pending
    const rejected = await propose(app, "mug");
    await app.request(`/api/proposals/${rejected.id}/reject`, { method: "POST" });
    const empty = await app.request("/api/signer/queue", { headers: auth() });
    expect(((await empty.json()) as { proposals: unknown[] }).proposals).toHaveLength(0);
  });

  it("logs a queue delivery to the activity trail once per set, not once per poll", async () => {
    const { app, service } = makeApp();
    await approvedProposal(app);
    await app.request("/api/signer/queue", { headers: auth() });
    await app.request("/api/signer/queue", { headers: auth() });
    await app.request("/api/signer/queue", { headers: auth() });
    const deliveries = service.activity().filter((e) => e.kind === "signer.queue");
    expect(deliveries).toHaveLength(1);
  });
});

describe("paid reports", () => {
  it("marks an approved proposal paid, idempotently, and drops it from the queue", async () => {
    const { app, service } = makeApp();
    const approved = await approvedProposal(app);
    const first = await markPaid(app, approved.id);
    expect(first.status).toBe(200);
    const paid = ((await first.json()) as { proposal: Proposal }).proposal;
    expect(paid.status).toBe("paid");
    expect(paid.payment).toMatchObject({ txHash: "tx_abc", orderId: "order-1" });

    // Idempotent: the same report again is a 200 with the same payment, no double log.
    const again = await markPaid(app, approved.id);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { proposal: Proposal }).proposal.payment?.txHash).toBe(
      "tx_abc",
    );
    expect(service.activity().filter((e) => e.kind === "proposal.paid")).toHaveLength(1);

    const queue = await app.request("/api/signer/queue", { headers: auth() });
    expect(((await queue.json()) as { proposals: unknown[] }).proposals).toHaveLength(0);
  });

  it("refuses to mark paid a proposal that is not approved", async () => {
    const { app } = makeApp();
    await saveProfile(app);
    const pending = await propose(app);
    const onPending = await markPaid(app, pending.id);
    expect(onPending.status).toBe(409);
    expect(((await onPending.json()) as { error: { code: string } }).error.code).toBe(
      "APPROVAL_PENDING",
    );

    await app.request(`/api/proposals/${pending.id}/reject`, { method: "POST" });
    const onRejected = await markPaid(app, pending.id);
    expect(onRejected.status).toBe(409);
    expect(((await onRejected.json()) as { error: { code: string } }).error.code).toBe(
      "APPROVAL_REJECTED",
    );
  });

  it("shows the payment in the status views: pages, history and API", async () => {
    const { app } = makeApp();
    const approved = await approvedProposal(app);
    await markPaid(app, approved.id, "tx_visible");
    const proposalsHtml = await (await app.request("/proposals")).text();
    expect(proposalsHtml).toContain("Pagadas");
    expect(proposalsHtml).toContain("tx_visible");
    const activityHtml = await (await app.request("/activity")).text();
    expect(activityHtml).toContain("tx_visible");
    const api = (await (await app.request("/api/proposals")).json()) as {
      proposals: Proposal[];
    };
    expect(api.proposals[0]?.status).toBe("paid");
    // A paid proposal can no longer be approved or rejected.
    expect((await app.request(`/api/proposals/${approved.id}/reject`, { method: "POST" })).status)
      .toBe(400);
  });
});

describe("failure reports", () => {
  it("keeps the proposal approved, records why, and shows it to the human", async () => {
    const { app, service } = makeApp();
    const approved = await approvedProposal(app);
    const res = await app.request("/api/signer/failed", {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({
        proposalId: approved.id,
        code: "MANDATE_EXCEEDED",
        message: "Payment exceeds the per-transaction limit",
      }),
    });
    expect(res.status).toBe(200);
    const failed = ((await res.json()) as { proposal: Proposal }).proposal;
    expect(failed.status).toBe("approved");
    expect(failed.failure?.code).toBe("MANDATE_EXCEEDED");

    // Still in the queue: a watch restart may retry once.
    const queue = await app.request("/api/signer/queue", { headers: auth() });
    expect(((await queue.json()) as { proposals: unknown[] }).proposals).toHaveLength(1);

    const html = await (await app.request("/proposals")).text();
    expect(html).toContain("MANDATE_EXCEEDED");
    expect(html).toContain("El ultimo intento de pago fallo");
    expect(service.activity().some((e) => e.kind === "proposal.payment_failed")).toBe(true);
  });

  it("ignores a stale failure that arrives after the payment settled", async () => {
    const { app } = makeApp();
    const approved = await approvedProposal(app);
    await markPaid(app, approved.id);
    const res = await app.request("/api/signer/failed", {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ proposalId: approved.id, code: "INTERNAL", message: "stale" }),
    });
    expect(res.status).toBe(200);
    const proposal = ((await res.json()) as { proposal: Proposal }).proposal;
    expect(proposal.status).toBe("paid");
    expect(proposal.failure).toBeUndefined();
  });

  it("rejects a malformed report with a typed error", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/signer/failed", {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ proposalId: "x" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CONFIG_INVALID");
  });
});
