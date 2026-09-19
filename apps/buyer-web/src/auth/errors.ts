/**
 * Typed refusals for the access layer. The codes in @agentpos/core are a closed set about
 * commerce (carts, mandates, payments); access control is this app's own concern, so it has
 * its own closed set here, shaped exactly like an AgentPOS error ({ code, message, hint })
 * so a caller, human or agent, can reason about it the same way.
 */

export const AUTH_ERROR_CODES = [
  /** No session (or an expired one) on a route that requires the owner. */
  "AUTH_REQUIRED",
  /** Wrong email or wrong password. Deliberately says nothing about which. */
  "INVALID_CREDENTIALS",
  /** Too many failed attempts from this address or against this account. */
  "LOGIN_RATE_LIMITED",
  /** Missing or wrong per-session CSRF token on a state-changing request. */
  "CSRF_INVALID",
  /** The password was not given again where approving requires it. */
  "REAUTH_REQUIRED",
  /** The password given again (approving a payment, or changing the password) was wrong. */
  "REAUTH_FAILED",
  /** The owner account does not exist yet: go through /setup. */
  "SETUP_REQUIRED",
  /** The owner account already exists: /setup is gone for good. */
  "SETUP_DONE",
  /** The email or the password does not meet the rules at setup time. */
  "ACCOUNT_INVALID",
  /**
   * The recovery code, the WhatsApp code or the operator token did not check out (wrong,
   * already used, or expired). Deliberately one code for all of them, and it says nothing
   * about whether the email matched.
   */
  "RECOVERY_INVALID",
  /** The set-a-new-password step was reached without a live recovery session. */
  "RECOVERY_REQUIRED",
  /** A recovery session tried to reach anything other than the set-a-new-password page. */
  "RECOVERY_SCOPE_LIMITED",
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

const STATUS: Record<AuthErrorCode, number> = {
  AUTH_REQUIRED: 401,
  INVALID_CREDENTIALS: 401,
  LOGIN_RATE_LIMITED: 429,
  CSRF_INVALID: 403,
  REAUTH_REQUIRED: 403,
  REAUTH_FAILED: 403,
  SETUP_REQUIRED: 403,
  SETUP_DONE: 404,
  ACCOUNT_INVALID: 400,
  RECOVERY_INVALID: 401,
  RECOVERY_REQUIRED: 403,
  RECOVERY_SCOPE_LIMITED: 403,
};

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly hint: string;
  readonly status: number;
  /** Seconds a rate-limited caller must wait; rendered as `Retry-After`. */
  readonly retryAfter: number | undefined;

  constructor(
    code: AuthErrorCode,
    message: string,
    options: { hint: string; retryAfter?: number },
  ) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.hint = options.hint;
    this.status = STATUS[code];
    this.retryAfter = options.retryAfter;
  }
}

export function isAuthError(value: unknown): value is AuthError {
  return value instanceof AuthError;
}
