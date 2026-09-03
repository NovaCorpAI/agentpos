/**
 * A minimal x402 facilitator for Stellar: `/verify`, `/settle`, `/supported`.
 *
 * It reimplements nothing. Verification and settlement are `ExactStellarScheme` from
 * `@x402/stellar/exact/facilitator` (Apache-2.0, the official SDK we already depend on) wired to
 * `x402Facilitator` from `@x402/core`. This file is the HTTP surface, the authentication and the
 * guardrails around them, and that is deliberately all it is.
 *
 * Why it exists: so that a store's ability to sell does not depend on one hosted service run by
 * someone else, with no alternative and no SLA. See docs/EVAL-facilitador-propio.md.
 *
 * What it does NOT do, and must never start doing: hold anyone's funds. The payment moves
 * buyer -> seller inside the transaction this service submits. What this service holds is XLM to
 * pay fees with, and that is the only balance it should ever have.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { timingSafeEqual } from "node:crypto";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { createEd25519Signer } from "@x402/stellar";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { Keypair } from "@stellar/stellar-sdk";
import { newTraceId, silentLogger } from "@agentpos/core";
import type { Logger } from "@agentpos/core";
import type { FacilitatorConfig } from "./config.js";

export interface FacilitatorAppDeps {
  config: FacilitatorConfig;
  logger?: Logger;
  /** Tests inject a fake Horizon; production uses global fetch. */
  fetchImpl?: typeof globalThis.fetch;
  /** Tests only: replaces the real scheme so verify/settle can be exercised without a ledger. */
  facilitator?: x402Facilitator;
}

export interface FacilitatorApp {
  app: Hono;
  fetch: (request: Request) => Promise<Response>;
  /** Public address that signs and pays fees. Safe to publish; it holds no one else's money. */
  signerAddress: string;
}

const MAX_BODY_BYTES = 128 * 1024;

/** Horizon reports balances as decimal strings with 7 places; stroops are the integer form. */
export function toStroops(balance: string): bigint | undefined {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(balance.trim());
  if (!match) return undefined;
  return BigInt(match[1] as string) * 10_000_000n + BigInt((match[2] ?? "").padEnd(7, "0"));
}

function errorBody(code: string, message: string, hint: string) {
  return { error: { code, message, hint, retryable: false } };
}

/** Constant-time comparison, so a caller cannot learn a key one byte at a time. */
function keyMatches(presented: string, allowed: string[]): boolean {
  const given = Buffer.from(presented);
  let ok = false;
  for (const key of allowed) {
    const expected = Buffer.from(key);
    if (expected.length === given.length && timingSafeEqual(expected, given)) ok = true;
  }
  return ok;
}

export function createFacilitatorApp(deps: FacilitatorAppDeps): FacilitatorApp {
  const { config } = deps;
  const logger = deps.logger ?? silentLogger;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  const keypair = Keypair.fromSecret(config.signerSecret);
  const signer = createEd25519Signer(config.signerSecret, config.caip2);
  const scheme = new ExactStellarScheme([signer], {
    ...(config.rpcUrl ? { rpcConfig: { url: config.rpcUrl } } : {}),
    areFeesSponsored: true,
    maxTransactionFeeStroops: config.maxFeeStroops,
  });
  const facilitator = deps.facilitator ?? new x402Facilitator().register(config.caip2, scheme);

  const app = new Hono();

  /** Correlates a request across verify, settle and the merchant's own logs. */
  const traceOf = (c: Context): string =>
    c.req.header("x-trace-id")?.slice(0, 64) ?? c.res.headers.get("x-trace-id") ?? newTraceId();

  app.use("*", async (c, next) => {
    c.header("x-trace-id", traceOf(c));
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json(errorBody("CONFIG_INVALID", "Body too large", `Max ${MAX_BODY_BYTES} bytes`), 413),
    }),
  );

  // Authentication on everything except /health. A facilitator open to the world is an open
  // relay that spends our fee balance for strangers.
  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token || !keyMatches(token, config.apiKeys)) {
      logger.warn("facilitator.unauthorized", { traceId: traceOf(c), path: c.req.path });
      return c.json(
        errorBody(
          "APPROVAL_UNAUTHORIZED",
          "Missing or invalid API key",
          "Send `Authorization: Bearer <key>`. Ask the operator of this facilitator for one.",
        ),
        401,
      );
    }
    return next();
  });

  const readPayment = async (
    c: Context,
  ): Promise<
    { ok: true; payload: PaymentPayload; requirements: PaymentRequirements } | { ok: false; response: Response }
  > => {
    const body = (await c.req.json().catch(() => undefined)) as
      | { paymentPayload?: PaymentPayload; paymentRequirements?: PaymentRequirements }
      | undefined;
    if (!body?.paymentPayload || !body?.paymentRequirements) {
      return {
        ok: false,
        response: c.json(
          errorBody(
            "CONFIG_INVALID",
            "Expected { x402Version, paymentPayload, paymentRequirements }",
            "This endpoint speaks the x402 v2 facilitator API.",
          ),
          400,
        ),
      };
    }
    const requirements = body.paymentRequirements;
    if (requirements.network !== config.caip2) {
      return {
        ok: false,
        response: c.json(
          errorBody(
            "SPEC_MISMATCH",
            `This facilitator settles ${config.caip2}, not ${String(requirements.network)}`,
            "Point the resource server at a facilitator for its own network.",
          ),
          422,
        ),
      };
    }
    // Account separation, enforced rather than documented: the fee account signs and pays for
    // other people's transactions and must never be the recipient of one. If it were, this
    // service would be receiving funds, which is a different product with a different posture.
    if (String(requirements.payTo) === keypair.publicKey()) {
      return {
        ok: false,
        response: c.json(
          errorBody(
            "SPEC_MISMATCH",
            "payTo is this facilitator's own fee account",
            "A facilitator's fee account pays fees only and never receives payments. Point payTo at the merchant's wallet.",
          ),
          422,
        ),
      };
    }
    // The asset allowlist is the guardrail that keeps our fee balance from being spent on
    // arbitrary tokens by anyone holding a key.
    if (!config.allowedAssets.includes(String(requirements.asset))) {
      return {
        ok: false,
        response: c.json(
          errorBody(
            "SPEC_MISMATCH",
            `Asset ${String(requirements.asset)} is not on this facilitator's allowlist`,
            "Ask the operator to allow it, or use a facilitator that settles it.",
          ),
          422,
        ),
      };
    }
    return { ok: true, payload: body.paymentPayload, requirements };
  };

  app.post("/verify", async (c) => {
    const parsed = await readPayment(c);
    if (!parsed.ok) return parsed.response;
    const traceId = traceOf(c);
    try {
      const result = await facilitator.verify(parsed.payload, parsed.requirements);
      logger.info("facilitator.verify", {
        traceId,
        isValid: result.isValid,
        payer: result.payer,
        reason: result.invalidReason,
      });
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("facilitator.verify_failed", { traceId, error: message });
      // The shape the x402 client expects for a refusal, not a bare 500: an agent must be able to
      // tell "your payment is not acceptable" from "this service is broken".
      return c.json({ isValid: false, invalidReason: "unexpected_verify_error", payer: "" }, 200);
    }
  });

  app.post("/settle", async (c) => {
    const parsed = await readPayment(c);
    if (!parsed.ok) return parsed.response;
    const traceId = traceOf(c);
    try {
      const result = await facilitator.settle(parsed.payload, parsed.requirements);
      logger.info("facilitator.settle", {
        traceId,
        success: result.success,
        transaction: result.transaction,
        payer: result.payer,
        error: result.errorReason,
      });
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("facilitator.settle_failed", { traceId, error: message });
      return c.json(
        {
          success: false,
          transaction: "",
          network: config.caip2,
          errorReason: "unexpected_settle_error",
        },
        200,
      );
    }
  });

  app.get("/supported", (c) => c.json(facilitator.getSupported()));

  /**
   * Unauthenticated on purpose: whoever depends on this service must be able to see that it is
   * alive, and that its fee account still has a balance, before a payment fails for that reason.
   * It exposes the signer address (public by construction) and a balance, nothing else.
   */
  app.get("/health", async (c) => {
    let balanceStroops: bigint | undefined;
    // Anything that is not XLM on the fee account means someone sent it money it was never meant
    // to hold. Reported, not hidden: it is the operator's signal that separation has been broken.
    const foreignBalances: Array<{ asset: string; balance: string }> = [];
    try {
      const res = await fetchImpl(`${config.horizonUrl}/accounts/${keypair.publicKey()}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) {
        const account = (await res.json()) as {
          balances?: Array<{ asset_type: string; balance: string; asset_code?: string; asset_issuer?: string }>;
        };
        for (const b of account.balances ?? []) {
          if (b.asset_type === "native") balanceStroops = toStroops(b.balance);
          else if (toStroops(b.balance) !== 0n)
            foreignBalances.push({ asset: `${b.asset_code ?? b.asset_type}:${b.asset_issuer ?? ""}`, balance: b.balance });
        }
      } else if (res.status === 404) {
        balanceStroops = 0n;
      }
    } catch {
      balanceStroops = undefined;
    }
    const funded = balanceStroops === undefined ? undefined : balanceStroops >= BigInt(config.minBalanceStroops);
    const ok = funded !== false;
    return c.json(
      {
        ok,
        network: config.caip2,
        signer: keypair.publicKey(),
        feeAccount: {
          balanceStroops: balanceStroops?.toString(),
          minimumStroops: String(config.minBalanceStroops),
          funded,
          note:
            funded === false
              ? "Fee account is below the configured minimum. Top it up: settlements will start failing."
              : "This account pays transaction fees only. It never holds buyer or seller funds.",
          ...(foreignBalances.length > 0
            ? {
                warning: "The fee account holds assets other than XLM. It should not: move them out and find out who sent them.",
                foreignBalances,
              }
            : {}),
        },
        allowedAssets: config.allowedAssets.length,
      },
      ok ? 200 : 503,
    );
  });

  app.notFound((c) =>
    c.json(
      errorBody("NOT_IMPLEMENTED", `No route ${c.req.method} ${c.req.path}`, "Routes: POST /verify, POST /settle, GET /supported, GET /health"),
      404,
    ),
  );

  return {
    app,
    fetch: (request) => Promise.resolve(app.fetch(request)),
    signerAddress: keypair.publicKey(),
  };
}
