/**
 * A facilitator's refusal of a signed payment, as an error an agent can act on (F3): the reasons
 * Circle's Facilitator Service documents map to what the agent can do about them, and anything
 * it does not explain (a failed compliance screen among them) is a decline the human decides on.
 */
import { describe, expect, it } from "vitest";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentPayload } from "@x402/core/types";
import { paymentFailureError, signedPaymentFailure } from "./x402.js";

const ARC = "eip155:5042002";

describe("paymentFailureError", () => {
  const code = (reason?: string) => paymentFailureError({ network: ARC, reason }).code;

  it("keeps an undocumented refusal as a decline, never retryable", () => {
    for (const reason of [
      'Facilitator settle failed (403): {"code":403,"message":"Forbidden"}',
      "unknown reason",
      undefined,
    ]) {
      const err = paymentFailureError({ network: ARC, reason });
      expect(err.code).toBe("PAYMENT_DECLINED");
      expect(err.retryable).toBe(false);
      expect(err.details).toMatchObject({ network: ARC });
      expect(err.hint).toMatch(/do not pay on another network on your own/);
    }
  });

  it("tells the agent what it can do about the documented reasons", () => {
    expect(code("insufficient_funds")).toBe("INSUFFICIENT_FUNDS");
    expect(code("invalid_exact_evm_insufficient_balance")).toBe("INSUFFICIENT_FUNDS");
    expect(code("settlement_pending")).toBe("PAYMENT_PENDING");
    expect(code("invalid_exact_evm_payload_signature")).toBe("PAYMENT_REJECTED");
    expect(code("invalid_exact_evm_payload_authorization_valid_before")).toBe("PAYMENT_REJECTED");
    expect(
      code('Facilitator settle failed (409): {"errors":[{"reason":"authorization_reused"}]}'),
    ).toBe("PAYMENT_REJECTED");
    expect(code("invalid_exact_evm_payload_recipient_mismatch")).toBe("PAYMENT_REJECTED");
    expect(
      code('Facilitator settle failed (403): {"errors":[{"reason":"registration_required"}]}'),
    ).toBe("PAYMENT_REJECTED");
    expect(code("Facilitator settle failed (503): busy")).toBe("FACILITATOR_UNAVAILABLE");
    expect(code("fetch failed")).toBe("FACILITATOR_UNAVAILABLE");
  });

  it("asks for a fresh signature only when one would help", () => {
    const retryable = (reason: string) => paymentFailureError({ reason }).retryable;
    expect(retryable("invalid_exact_evm_payload_signature")).toBe(true);
    expect(retryable("invalid_exact_evm_payload_recipient_mismatch")).toBe(false);
    expect(retryable("insufficient_funds")).toBe(false);
    expect(paymentFailureError({ reason: "settlement_pending" }).hint).toMatch(/Do not pay again/);
  });
});

describe("signedPaymentFailure", () => {
  const client = new x402HTTPClient(new x402Client());
  const signature = client.encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: ARC,
      amount: "2500000",
      asset: "0x3600000000000000000000000000000000000000",
      payTo: "0x75284c0856d11112321014Cd4405dEc5d84393f8",
      maxTimeoutSeconds: 300,
      extra: {},
    },
    payload: {},
  } as unknown as PaymentPayload);
  const get = (h: Record<string, string>) => (n: string) => h[n] ?? h[n.toLowerCase()] ?? null;
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

  it("is undefined for an unsigned request: that 402 is an offer", () => {
    expect(signedPaymentFailure(get({}), get({}))).toBeUndefined();
  });

  it("reads the network from the signature and the reason from a failed settle", () => {
    const response = {
      "PAYMENT-RESPONSE": b64({
        success: false,
        errorReason: "insufficient_funds",
        transaction: "",
        network: ARC,
      }),
    };
    expect(signedPaymentFailure(get(signature), get(response))).toEqual({
      network: ARC,
      reason: "insufficient_funds",
    });
  });

  it("falls back to the 402's own error after a failed verify", () => {
    const response = {
      "PAYMENT-REQUIRED": b64({
        x402Version: 2,
        error: "invalid_exact_evm_payload_signature",
        accepts: [],
        resource: { url: "https://shop.test/agentpos/checkout" },
      }),
    };
    expect(signedPaymentFailure(get(signature), get(response))).toEqual({
      network: ARC,
      reason: "invalid_exact_evm_payload_signature",
    });
  });
});
