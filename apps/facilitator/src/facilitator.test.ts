/**
 * A facilitator signs and pays for other people's transactions, so most of what matters here is
 * what it REFUSES: an unauthenticated caller, a network it does not serve, an asset outside its
 * allowlist, and a configuration that would let any of those through.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { x402Facilitator } from "@x402/core/facilitator";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { AgentGateError } from "@agentgate/core";
import { createFacilitatorApp, toStroops } from "./app.js";
import { configFromEnv } from "./config.js";
import type { FacilitatorConfig } from "./config.js";

const signer = Keypair.random();
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const OTHER_ASSET = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEY = "test-key-at-least-16-chars";

const baseEnv = {
  AGENTGATE_FACILITATOR_NETWORK: "testnet",
  AGENTGATE_FACILITATOR_SIGNER_SECRET: signer.secret(),
  AGENTGATE_FACILITATOR_ASSETS: USDC,
  AGENTGATE_FACILITATOR_KEYS: KEY,
};

function config(overrides: Record<string, string | undefined> = {}): FacilitatorConfig {
  return configFromEnv({ ...baseEnv, ...overrides });
}

/** A scheme-free facilitator: lets us exercise the HTTP surface without touching a ledger. */
function stubFacilitator(
  verify: VerifyResponse = { isValid: true, payer: "GPAYER" },
  settle?: SettleResponse,
): x402Facilitator {
  const stub = {
    getSupported: () => ({
      kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet" }],
      extensions: [],
      signers: { "stellar:testnet": [signer.publicKey()] },
    }),
    verify: async () => verify,
    settle: async () =>
      settle ?? {
        success: true,
        transaction: "abc123",
        network: "stellar:testnet",
        payer: "GPAYER",
      },
  };
  return stub as unknown as x402Facilitator;
}

function app(options: { cfg?: FacilitatorConfig; facilitator?: x402Facilitator; fetchImpl?: typeof globalThis.fetch } = {}) {
  return createFacilitatorApp({
    config: options.cfg ?? config(),
    facilitator: options.facilitator ?? stubFacilitator(),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}

const payload = { x402Version: 2, accepted: {}, payload: { transaction: "xdr" } } as unknown as PaymentPayload;
const requirements = (overrides: Partial<PaymentRequirements> = {}) =>
  ({
    scheme: "exact",
    network: "stellar:testnet",
    asset: USDC,
    payTo: Keypair.random().publicKey(),
    amount: "9900000",
    ...overrides,
  }) as unknown as PaymentRequirements;

/**
 * `key: null` means "send no Authorization header at all". Note it cannot be `undefined`: a
 * default parameter fires on undefined, so passing undefined would silently send a VALID key and
 * the test would prove the opposite of what it claims.
 */
function post(path: string, body: unknown, key: string | null = KEY): Request {
  return new Request(`https://facilitator.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key === null ? {} : { authorization: `Bearer ${key}` }),
    },
    body: JSON.stringify(body),
  });
}

describe("configuration", () => {
  it("refuses to start without an asset allowlist", () => {
    expect(() => config({ AGENTGATE_FACILITATOR_ASSETS: "" })).toThrow(
      /Refusing to start with no asset allowlist/,
    );
  });

  it("refuses mainnet without an explicit RPC URL", () => {
    try {
      config({ AGENTGATE_FACILITATOR_NETWORK: "mainnet" });
      throw new Error("should have refused");
    } catch (err) {
      expect((err as AgentGateError).code).toBe("RPC_URL_REQUIRED");
    }
  });

  it("accepts mainnet with an RPC URL, and maps the CAIP-2 network", () => {
    const cfg = config({
      AGENTGATE_FACILITATOR_NETWORK: "mainnet",
      AGENTGATE_FACILITATOR_RPC_URL: "https://rpc.example/soroban",
    });
    expect(cfg.caip2).toBe("stellar:pubnet");
    expect(cfg.horizonUrl).toBe("https://horizon.stellar.org");
  });

  it("refuses a missing signer, a bad signer and a short API key", () => {
    expect(() => config({ AGENTGATE_FACILITATOR_SIGNER_SECRET: "" })).toThrow(/Invalid facilitator configuration/);
    expect(() => config({ AGENTGATE_FACILITATOR_SIGNER_SECRET: "not-a-seed" })).toThrow();
    expect(() => config({ AGENTGATE_FACILITATOR_KEYS: "short" })).toThrow();
    expect(() => config({ AGENTGATE_FACILITATOR_KEYS: "" })).toThrow();
  });

  it("keeps a sane default fee ceiling", () => {
    expect(config().maxFeeStroops).toBe(50_000);
    expect(config({ AGENTGATE_FACILITATOR_MAX_FEE_STROOPS: "120000" }).maxFeeStroops).toBe(120_000);
  });
});

describe("authentication", () => {
  it("refuses verify, settle and supported without a valid key", async () => {
    const f = app();
    const cases: Array<[string, Request]> = [
      ["verify without a key", post("/verify", { paymentPayload: payload, paymentRequirements: requirements() }, null)],
      ["settle with a wrong key", post("/settle", { paymentPayload: payload, paymentRequirements: requirements() }, "wrong-key-but-long-enough")],
      ["supported without a key", new Request("https://facilitator.test/supported")],
    ];
    for (const [label, request] of cases) {
      const res = await f.fetch(request);
      expect(res.status, label).toBe(401);
      const body = (await res.json()) as { error: { code: string; hint: string } };
      expect(body.error.code).toBe("APPROVAL_UNAUTHORIZED");
      expect(body.error.hint).toContain("Bearer");
    }
  });

  it("leaves health open, so whoever depends on it can see it is alive", async () => {
    const f = app({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ balances: [{ asset_type: "native", balance: "100.0000000" }] }), {
          status: 200,
        })) as typeof globalThis.fetch,
    });
    const res = await f.fetch(new Request("https://facilitator.test/health"));
    expect(res.status).toBe(200);
  });
});

describe("guardrails on what it will settle", () => {
  it("refuses a network it does not serve", async () => {
    const res = await app().fetch(
      post("/verify", {
        paymentPayload: payload,
        paymentRequirements: requirements({ network: "stellar:pubnet" as never }),
      }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      "settles stellar:testnet",
    );
  });

  it("refuses an asset outside the allowlist, on verify AND on settle", async () => {
    const f = app();
    for (const path of ["/verify", "/settle"]) {
      const res = await f.fetch(
        post(path, {
          paymentPayload: payload,
          paymentRequirements: requirements({ asset: OTHER_ASSET }),
        }),
      );
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
        "not on this facilitator's allowlist",
      );
    }
  });

  it("refuses a body that is not an x402 facilitator request", async () => {
    const res = await app().fetch(post("/verify", { hello: "world" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CONFIG_INVALID");
  });
});

describe("the x402 facilitator API", () => {
  it("verifies and settles through the registered scheme", async () => {
    const f = app();
    const verified = await f.fetch(
      post("/verify", { paymentPayload: payload, paymentRequirements: requirements() }),
    );
    expect(verified.status).toBe(200);
    expect((await verified.json()) as VerifyResponse).toEqual({ isValid: true, payer: "GPAYER" });

    const settled = await f.fetch(
      post("/settle", { paymentPayload: payload, paymentRequirements: requirements() }),
    );
    expect(((await settled.json()) as SettleResponse).transaction).toBe("abc123");
  });

  it("answers a scheme failure as a refusal, not as a broken service", async () => {
    const exploding = {
      getSupported: () => ({ kinds: [], extensions: [], signers: {} }),
      verify: async () => {
        throw new Error("rpc exploded");
      },
      settle: async () => {
        throw new Error("rpc exploded");
      },
    } as unknown as x402Facilitator;
    const f = app({ facilitator: exploding });

    const verified = await f.fetch(
      post("/verify", { paymentPayload: payload, paymentRequirements: requirements() }),
    );
    // 200 with isValid:false, because the x402 client distinguishes a refusal from a transport
    // failure by the body, and a 500 would be retried as if the service were merely flaky.
    expect(verified.status).toBe(200);
    expect((await verified.json()) as VerifyResponse).toMatchObject({ isValid: false });

    const settled = await f.fetch(
      post("/settle", { paymentPayload: payload, paymentRequirements: requirements() }),
    );
    expect((await settled.json()) as SettleResponse).toMatchObject({
      success: false,
      transaction: "",
    });
  });

  it("advertises its own signer, not somebody else's", async () => {
    const res = await app().fetch(
      new Request("https://facilitator.test/supported", {
        headers: { authorization: `Bearer ${KEY}` },
      }),
    );
    const body = (await res.json()) as { signers: Record<string, string[]> };
    expect(body.signers["stellar:testnet"]).toEqual([signer.publicKey()]);
  });
});

describe("health and the fee account", () => {
  const horizon = (balance: string | undefined, status = 200): typeof globalThis.fetch =>
    (async () =>
      new Response(
        balance === undefined ? "" : JSON.stringify({ balances: [{ asset_type: "native", balance }] }),
        { status },
      )) as typeof globalThis.fetch;

  it("reports the fee account and says what it is for", async () => {
    const res = await app({ fetchImpl: horizon("100.0000000") }).fetch(
      new Request("https://facilitator.test/health"),
    );
    const body = (await res.json()) as {
      ok: boolean;
      signer: string;
      feeAccount: { balanceStroops: string; funded: boolean; note: string };
    };
    expect(body.ok).toBe(true);
    expect(body.signer).toBe(signer.publicKey());
    expect(body.feeAccount.balanceStroops).toBe("1000000000");
    expect(body.feeAccount.funded).toBe(true);
    expect(body.feeAccount.note).toContain("never holds buyer or seller funds");
  });

  it("goes unhealthy BEFORE settlements start failing, not after", async () => {
    const res = await app({ fetchImpl: horizon("0.5000000") }).fetch(
      new Request("https://facilitator.test/health"),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { feeAccount: { funded: boolean; note: string } };
    expect(body.feeAccount.funded).toBe(false);
    expect(body.feeAccount.note).toContain("Top it up");
  });

  it("treats an unfunded account as zero, and an unreachable Horizon as unknown", async () => {
    const missing = await app({ fetchImpl: horizon(undefined, 404) }).fetch(
      new Request("https://facilitator.test/health"),
    );
    expect(missing.status).toBe(503);

    const unreachable = await app({
      fetchImpl: (async () => {
        throw new Error("ENOTFOUND");
      }) as typeof globalThis.fetch,
    }).fetch(new Request("https://facilitator.test/health"));
    // Unknown is not unhealthy: a Horizon outage must not take the facilitator down with it.
    expect(unreachable.status).toBe(200);
    const body = (await unreachable.json()) as { feeAccount: { funded?: boolean } };
    expect(body.feeAccount.funded).toBeUndefined();
  });

  it("parses Horizon balances into stroops without floating point", () => {
    expect(toStroops("100.0000000")).toBe(1_000_000_000n);
    expect(toStroops("0.0000001")).toBe(1n);
    expect(toStroops("0")).toBe(0n);
    expect(toStroops("9999999999.9999999")).toBe(99_999_999_999_999_999n);
    expect(toStroops("not a number")).toBeUndefined();
  });
});

describe("unknown routes", () => {
  it("says which routes exist instead of a bare 404", async () => {
    const res = await app().fetch(
      new Request("https://facilitator.test/nope", { headers: { authorization: `Bearer ${KEY}` } }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { hint: string } }).error.hint).toContain("/settle");
  });
});

describe("account separation, enforced", () => {
  it("refuses to settle a payment whose payee is its own fee account", async () => {
    const f = app();
    for (const path of ["/verify", "/settle"]) {
      const res = await f.fetch(
        post(path, {
          paymentPayload: payload,
          paymentRequirements: requirements({ payTo: signer.publicKey() }),
        }),
      );
      expect(res.status, path).toBe(422);
      const body = (await res.json()) as { error: { message: string; hint: string } };
      expect(body.error.message).toContain("own fee account");
      expect(body.error.hint).toContain("never receives payments");
    }
  });

  it("warns on health when the fee account holds anything other than XLM", async () => {
    const horizon = (async () =>
      new Response(
        JSON.stringify({
          balances: [
            { asset_type: "native", balance: "100.0000000" },
            {
              asset_type: "credit_alphanum4",
              asset_code: "USDC",
              asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
              balance: "12.5000000",
            },
            { asset_type: "credit_alphanum4", asset_code: "EMPTY", asset_issuer: "GXYZ", balance: "0.0000000" },
          ],
        }),
        { status: 200 },
      )) as typeof globalThis.fetch;
    const res = await app({ fetchImpl: horizon }).fetch(new Request("https://facilitator.test/health"));
    const body = (await res.json()) as {
      ok: boolean;
      feeAccount: { warning?: string; foreignBalances?: Array<{ asset: string; balance: string }> };
    };
    // Still healthy: it can pay fees. But it says loudly that separation was broken.
    expect(body.ok).toBe(true);
    expect(body.feeAccount.warning).toContain("other than XLM");
    expect(body.feeAccount.foreignBalances).toHaveLength(1);
    expect(body.feeAccount.foreignBalances?.[0]?.asset).toContain("USDC");
  });
});
