import { describe, expect, it, vi } from "vitest";
import { AgentPOSError } from "../../errors.js";
import { fiatMinor } from "../../money.js";
import { minorAmount, usdcAmount } from "../rails.js";
import { usdc } from "../../money.js";
import type { TransbankPayload, TransbankTerms, WebpayPlusTerms } from "./transbank-webpay.js";
import { TRANSBANK_RAIL_ID, createTransbankRail } from "./transbank-webpay.js";

/** The public integration credentials from Transbank's docs repo. Not secrets. */
const CREDENTIALS = {
  commerceCode: "597055555532",
  apiKey: "579B532A7440BB0C9079DED94D31EA1615BACEB56610332264630D42D0A36B1C",
};
const ONECLICK = { mallCode: "597055555541", childCommerceCode: "597055555542" };

function clp(pesos: string) {
  return minorAmount(fiatMinor(pesos, 0, "CLP"), "CLP", 0);
}

type Reply = { status: number; body: unknown } | Error;

/** A fake Transbank: one queued reply per call, and every request kept for assertions. */
function fakeTransbank(replies: Reply[]) {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const reply = replies.shift();
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    if (reply instanceof Error) throw reply;
    if (!reply) throw new Error("fake Transbank has no reply queued");
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

function rail(replies: Reply[] = [], extra: Record<string, unknown> = {}) {
  const fake = fakeTransbank(replies);
  const r = createTransbankRail({
    environment: "integration",
    ...CREDENTIALS,
    oneclick: ONECLICK,
    fetchImpl: fake.fetchImpl,
    buyOrderFor: () => "ap-order-1",
    ...extra,
  });
  return { r, ...fake };
}

const created = {
  status: 200,
  body: { token: "tok_1", url: "https://webpay3gint.transbank.cl/webpayserver/initTransaction" },
};
const authorized = (amount = 14990) => ({
  status: 200,
  body: {
    status: "AUTHORIZED",
    response_code: 0,
    authorization_code: "1213",
    amount,
    buy_order: "ap-order-1",
    vci: "TSY",
  },
});

describe("Transbank rail: identity and support", () => {
  it("has the pinned reverse-DNS id and publishes no credentials", () => {
    const { r } = rail();
    expect(r.id).toBe("cl.transbank.webpay");
    expect(r.id).toBe(TRANSBANK_RAIL_ID);
    const d = r.describe();
    expect(d.protocolVersion).toBe("1.2");
    expect(d.capabilities).toMatchObject({
      networks: ["transbank:integration"],
      currencies: ["CLP"],
      settlesOnLedger: false,
    });
    expect(d.capabilities.minAmount).toEqual({ minor: 50n, currency: "CLP", decimals: 0 });
    // Amounts are bigint on purpose; serialize them as strings to scan the description.
    const published = JSON.stringify(d, (_k, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(published).not.toContain(CREDENTIALS.apiKey);
    expect(published).not.toContain(CREDENTIALS.commerceCode);
  });

  it("refuses to be built without the merchant's credentials", () => {
    expect(() =>
      createTransbankRail({ environment: "integration", commerceCode: "", apiKey: "" }),
    ).toThrowError(AgentPOSError);
  });

  it("takes whole pesos within bounds and nothing else", () => {
    const { r } = rail([], { maxAmountClp: 100_000n });
    expect(r.supports({ amount: clp("14990") }).supported).toBe(true);
    expect(r.supports({ currency: "clp" }).supported).toBe(true);
    for (const ctx of [
      { amount: usdcAmount(usdc("1")) },
      { currency: "USD" },
      { amount: minorAmount(1499n, "CLP", 2) },
      { amount: clp("49") },
      { amount: clp("100001") },
      { network: "stellar:pubnet" },
    ]) {
      const decision = r.supports(ctx);
      expect(decision.supported).toBe(false);
      if (!decision.supported) expect(decision.code).toBe("RAIL_UNSUPPORTED");
    }
  });
});

describe("Transbank rail: Webpay Plus (first purchase, the human pays)", () => {
  it("creates the transaction with integer pesos and returns the page the human must visit", async () => {
    const { r, calls } = rail([created]);
    const quote = await r.quote({
      payTo: "https://tienda.cl/agentpos/return",
      amount: clp("14990"),
      reference: "cart_9",
    });

    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://webpay3gint.transbank.cl/rswebpaytransaction/api/webpay/v1.2/transactions",
      headers: {
        "Tbk-Api-Key-Id": CREDENTIALS.commerceCode,
        "Tbk-Api-Key-Secret": CREDENTIALS.apiKey,
      },
      body: {
        buy_order: "ap-order-1",
        amount: 14990,
        return_url: "https://tienda.cl/agentpos/return",
      },
    });
    expect(Number.isInteger((calls[0]?.body as { amount: unknown }).amount)).toBe(true);
    expect(quote.terms).toEqual({
      mode: "webpay-plus",
      token: "tok_1",
      url: created.body.url,
      buyOrder: "ap-order-1",
      amount: "14990",
      environment: "integration",
    });
    expect(quote.network).toBe("transbank:integration");
    expect(quote.expiresInSeconds).toBe(300);
    expect(typeof quote.amount.minor).toBe("bigint");
  });

  it("refuses to quote what it does not support, before any network call", async () => {
    const { r, calls } = rail([created]);
    await expect(r.quote({ payTo: "x", amount: usdcAmount(usdc("1")) })).rejects.toThrowError(
      AgentPOSError,
    );
    expect(calls).toHaveLength(0);
  });

  it("reports an unpaid transaction as PENDING: retryable, never pre-submission", async () => {
    const { r } = rail([
      created,
      { status: 200, body: { status: "INITIALIZED", buy_order: "ap-order-1", amount: 14990 } },
    ]);
    const quote = await r.quote({ payTo: "x", amount: clp("14990") });
    const result = await r.verify({ mode: "webpay-plus", token: "tok_1" }, quote.terms);
    expect(result.ok).toBe(false);
    if (result.ok) expect.unreachable();
    expect(result.failure.code).toBe("PAYMENT_PENDING");
    expect(result.failure.kind).toBe("unavailable");
    expect(result.failure.retryable).toBe(true);
    expect(result.failure.preSubmission).toBe(false);
  });

  it("accepts an authorized transaction only when amount and order match the quote", async () => {
    const { r } = rail([created, authorized(), created, authorized(14000)]);
    const quote = await r.quote({ payTo: "x", amount: clp("14990") });
    const ok = await r.verify({ mode: "webpay-plus", token: "tok_1" }, quote.terms);
    expect(ok.ok).toBe(true);

    const quote2 = await r.quote({ payTo: "x", amount: clp("14990") });
    const bad = await r.verify({ mode: "webpay-plus", token: "tok_1" }, quote2.terms);
    expect(bad.ok).toBe(false);
    if (bad.ok) expect.unreachable();
    expect(bad.failure.code).toBe("PAYMENT_REJECTED");
    expect(bad.failure.details?.actual).toEqual({ amount: "14000", buyOrder: "ap-order-1" });
  });

  it("refuses a token that is not the quoted one, without calling Transbank", async () => {
    const { r, calls } = rail([created]);
    const quote = await r.quote({ payTo: "x", amount: clp("14990") });
    const result = await r.verify({ mode: "webpay-plus", token: "someone-elses" }, quote.terms);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("commits the token once and settles with our buy order as the reference", async () => {
    const { r, calls } = rail([created, authorized()]);
    const quote = await r.quote({ payTo: "x", amount: clp("14990") });
    const result = await r.settle({ mode: "webpay-plus", token: "tok_1" }, quote.terms);
    expect(calls[1]).toMatchObject({
      method: "PUT",
      url: expect.stringMatching(/\/transactions\/tok_1$/),
    });
    expect(result).toMatchObject({
      railId: "cl.transbank.webpay",
      settled: true,
      reference: "ap-order-1",
    });
    expect(result.amount).toEqual({ minor: 14990n, currency: "CLP", decimals: 0 });
    expect((result.raw as { authorization_code: string }).authorization_code).toBe("1213");
  });

  it("does not settle a refused commit and keeps the refusal deterministic", async () => {
    const { r } = rail([
      created,
      {
        status: 200,
        body: { status: "FAILED", response_code: -1, amount: 14990, buy_order: "ap-order-1" },
      },
    ]);
    const quote = await r.quote({ payTo: "x", amount: clp("14990") });
    const result = await r.settle({ mode: "webpay-plus", token: "tok_1" }, quote.terms);
    expect(result.settled).toBe(false);
    expect(result.reference).toBe("");
    expect(result.failure?.code).toBe("SETTLEMENT_FAILED");
    expect(result.failure?.retryable).toBe(false);
    expect(result.failure?.details?.responseCode).toBe(-1);
  });

  it("holds an authorized amount that differs from the quote as a mismatch, not a success", async () => {
    const { r } = rail([created, authorized(14000)]);
    const quote = await r.quote({ payTo: "x", amount: clp("14990") });
    const result = await r.settle({ mode: "webpay-plus", token: "tok_1" }, quote.terms);
    expect(result.settled).toBe(false);
    expect(result.failure?.code).toBe("PAYMENT_MISMATCH");
  });

  it("treats a 422 on commit as rejected (a token commits once), never as pre-submission", async () => {
    const { r } = rail([
      created,
      { status: 422, body: { error_message: "Transaction already committed" } },
    ]);
    const quote = await r.quote({ payTo: "x", amount: clp("14990") });
    const result = await r.settle({ mode: "webpay-plus", token: "tok_1" }, quote.terms);
    expect(result.settled).toBe(false);
    expect(result.failure?.kind).toBe("rejected");
    expect(result.failure?.retryable).toBe(false);
    expect(result.failure?.preSubmission).toBeUndefined();
    expect(result.failure?.details?.status).toBe(422);
  });

  it("marks a connection-level failure as unavailable and provably pre-submission", async () => {
    const { r } = rail([created, Object.assign(new Error("connect"), { code: "ECONNREFUSED" })]);
    const quote = await r.quote({ payTo: "x", amount: clp("14990") });
    const result = await r.settle({ mode: "webpay-plus", token: "tok_1" }, quote.terms);
    expect(result.settled).toBe(false);
    expect(result.failure?.kind).toBe("unavailable");
    expect(result.failure?.code).toBe("RAIL_UNAVAILABLE");
    expect(result.failure?.retryable).toBe(true);
    expect(result.failure?.preSubmission).toBe(true);
  });

  it("keeps a 5xx from Transbank retryable but never pre-submission", async () => {
    const { r } = rail([created, { status: 503, body: {} }]);
    const quote = await r.quote({ payTo: "x", amount: clp("14990") });
    const result = await r.settle({ mode: "webpay-plus", token: "tok_1" }, quote.terms);
    expect(result.failure?.kind).toBe("unavailable");
    expect(result.failure?.preSubmission).toBe(false);
  });
});

describe("Transbank rail: Oneclick (repeat purchase, the agent buys alone)", () => {
  const enrolment: TransbankPayload = {
    mode: "oneclick",
    username: "cliente-42",
    tbkUser: "tbk_user_abc",
  };
  const approved = {
    status: 200,
    body: {
      buy_order: "ap-order-1",
      details: [
        {
          status: "AUTHORIZED",
          response_code: 0,
          authorization_code: "1213",
          amount: 14990,
          buy_order: "ap-order-1",
          commerce_code: ONECLICK.childCommerceCode,
        },
      ],
    },
  };

  it("quotes without touching the network and needs the enrolment to verify", async () => {
    const { r, calls } = rail([]);
    const quote = r.quoteOneclick({ payTo: "tienda", amount: clp("14990"), reference: "cart_3" });
    expect(calls).toHaveLength(0);
    expect(quote.terms).toEqual({
      mode: "oneclick",
      buyOrder: "ap-order-1",
      amount: "14990",
      childCommerceCode: ONECLICK.childCommerceCode,
      environment: "integration",
    });
    expect((await r.verify(enrolment, quote.terms)).ok).toBe(true);
    const missing = await r.verify({ mode: "oneclick", username: "", tbkUser: "" }, quote.terms);
    expect(missing.ok).toBe(false);
  });

  it("authorizes on the mall with the child store and settles with our reference", async () => {
    const { r, calls } = rail([approved]);
    const quote = r.quoteOneclick({ payTo: "tienda", amount: clp("14990") });
    const result = await r.settle(enrolment, quote.terms);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://webpay3gint.transbank.cl/rswebpaytransaction/api/oneclick/v1.2/transactions",
      headers: { "Tbk-Api-Key-Id": ONECLICK.mallCode },
      body: {
        username: "cliente-42",
        tbk_user: "tbk_user_abc",
        buy_order: "ap-order-1",
        details: [
          {
            commerce_code: ONECLICK.childCommerceCode,
            buy_order: "ap-order-1",
            amount: 14990,
            installments_number: 1,
          },
        ],
      },
    });
    expect(result).toMatchObject({ settled: true, reference: "ap-order-1", payer: "cliente-42" });
    expect(result.amount).toEqual({ minor: 14990n, currency: "CLP", decimals: 0 });
  });

  it("does not settle a declined detail line", async () => {
    const declined = {
      status: 200,
      body: { details: [{ status: "FAILED", response_code: -1, amount: 14990 }] },
    };
    const { r } = rail([declined]);
    const quote = r.quoteOneclick({ payTo: "tienda", amount: clp("14990") });
    const result = await r.settle(enrolment, quote.terms);
    expect(result.settled).toBe(false);
    expect(result.failure?.code).toBe("SETTLEMENT_FAILED");
    expect(result.failure?.retryable).toBe(false);
  });

  it("refuses Oneclick when the store has no mall configured", () => {
    const fake = fakeTransbank([]);
    const r = createTransbankRail({
      environment: "integration",
      ...CREDENTIALS,
      fetchImpl: fake.fetchImpl,
    });
    expect(() => r.quoteOneclick({ payTo: "t", amount: clp("100") })).toThrowError(AgentPOSError);
  });

  it("never mixes modes: Oneclick terms with a Webpay payload do not settle", async () => {
    const { r, calls } = rail([]);
    const terms: TransbankTerms = r.quoteOneclick({ payTo: "t", amount: clp("100") }).terms;
    const result = await r.settle({ mode: "webpay-plus", token: "tok" }, terms);
    expect(result.settled).toBe(false);
    expect(calls).toHaveLength(0);
    const webpay: WebpayPlusTerms = {
      mode: "webpay-plus",
      token: "t",
      url: "u",
      buyOrder: "b",
      amount: "100",
      environment: "integration",
    };
    const cross = await r.settle(enrolment, webpay);
    expect(cross.settled).toBe(false);
  });
});
