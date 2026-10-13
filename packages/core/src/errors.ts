/**
 * Machine-readable errors. Every error AgentPOS emits carries a closed-set code, a human
 * message and a hint an agent can act on.
 */
export const ERROR_CODES = [
  // config
  "CONFIG_INVALID",
  "MAINNET_NOT_CONFIRMED",
  "RPC_URL_REQUIRED",
  // money
  "INVALID_AMOUNT",
  // payment
  "PAYMENT_REJECTED",
  "SETTLEMENT_FAILED",
  "SPEC_MISMATCH",
  // payment rails (adapter/rails.ts)
  "RAIL_ID_INVALID",
  "RAIL_NOT_FOUND",
  "RAIL_DUPLICATE",
  "RAIL_UNSUPPORTED",
  "RAIL_UNAVAILABLE",
  /** The rail has the charge but is waiting for a human step (a card redirect, an enrolment). */
  "PAYMENT_PENDING",
  // catalog / checkout
  "ITEM_NOT_FOUND",
  "ITEM_NOT_PUBLISHED",
  "OUT_OF_STOCK",
  "CART_EXPIRED",
  "CART_NOT_FOUND",
  "SHIPPING_REQUIRED",
  "MIXED_PAYTO",
  "ORDER_NOT_FOUND",
  "ORDER_NOT_CREATED",
  // merchant policy (M1)
  "POLICY_SUSPENDED",
  "POLICY_ITEM_EXCLUDED",
  "POLICY_ITEM_QUANTITY",
  "POLICY_ORDER_QUANTITY",
  "POLICY_ORDER_LIMIT",
  "POLICY_PERIOD_LIMIT",
  "POLICY_SHIPPING_COUNTRY",
  "POLICY_APPROVAL_REQUIRED",
  // human approvals (M2)
  "APPROVAL_PENDING",
  "APPROVAL_REJECTED",
  "APPROVAL_EXPIRED",
  "APPROVAL_NOT_FOUND",
  "APPROVAL_UNAUTHORIZED",
  "APPROVAL_SNAPSHOT_CHANGED",
  // agent identity (M3)
  "AGENT_IDENTITY_REQUIRED",
  "AGENT_SIGNATURE_INVALID",
  "AGENT_TIMESTAMP_OUT_OF_WINDOW",
  "AGENT_NONCE_REUSED",
  "AGENT_REVOKED",
  "AGENT_ATTESTATION_INVALID",
  "AGENT_NOT_FOUND",
  // verifiable receipts (M4)
  "RECEIPT_NOT_FOUND",
  "RECEIPT_SIGNATURE_INVALID",
  "RECEIPT_TAMPERED",
  "RECEIPT_CHAIN_BROKEN",
  "RECEIPT_UNVERIFIABLE",
  // production gate (G1)
  "REQUOTE_REQUIRED",
  "PAYMENT_MISMATCH",
  "RATE_LIMITED",
  "FACILITATOR_UNAVAILABLE",
  "SECRET_IN_CONFIG",
  // buyer / mandate (SPEC 02)
  "MANDATE_EXCEEDED",
  "SELLER_UNVERIFIED",
  "CONFIRMATION_REQUIRED",
  "SITE_UNREACHABLE",
  "INSUFFICIENT_FUNDS",
  // signer / wallet
  "SIGNER_NOT_IMPLEMENTED",
  "INVALID_SECRET_KEY",
  // llm
  "LLM_REQUEST_FAILED",
  "LLM_INVALID_JSON",
  // generic
  "NOT_IMPLEMENTED",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface AgentPOSErrorShape {
  code: ErrorCode;
  message: string;
  hint: string;
  retryable: boolean;
  details?: Record<string, unknown> | undefined;
}

export class AgentPOSError extends Error implements AgentPOSErrorShape {
  readonly code: ErrorCode;
  readonly hint: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      hint: string;
      retryable?: boolean;
      details?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AgentPOSError";
    this.code = code;
    this.hint = options.hint;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toJSON(): AgentPOSErrorShape {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function isAgentPOSError(value: unknown): value is AgentPOSError {
  return value instanceof AgentPOSError;
}
