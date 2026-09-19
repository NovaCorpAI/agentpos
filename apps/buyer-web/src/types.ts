/**
 * Buyer-web domain types: the buyer's web profile (mandate + linked wallet PUBLIC address),
 * purchase proposals awaiting a human decision, and the append-only activity log.
 *
 * Custody rule (hard, see CLAUDE.md #1): nothing in this module can represent a secret key.
 * The profile links a wallet by public address only; signatures always happen on the buyer's
 * own machine (agentpos-buyer CLI or a future signing bridge).
 */
import { z } from "zod";
import { addressSchema } from "@agentpos/core";
import { mandateSchema } from "@agentpos/mcp-buyer";

/** Stellar PUBLIC key: starts with G. A secret starts with S and must never reach storage. */
export const STELLAR_PUBLIC_KEY_RE = /^G[A-Z2-7]{55}$/;

export const buyerWebProfileSchema = z.object({
  id: z.string().min(1).default("default"),
  /** Linked wallet, public address only. Never a secret; see STELLAR_PUBLIC_KEY_RE. */
  walletAddress: z.string().regex(STELLAR_PUBLIC_KEY_RE).optional(),
  /** Contact email the agent passes to stores as the buyer contact. */
  email: z.email().optional(),
  /**
   * Where physical orders are shipped. Same shape the CLI profile stores, so the address
   * travels to the store through the existing mcp-buyer profile path. Pages and logs only
   * ever show its city and country: the full address stays in this record.
   */
  shipping: addressSchema.optional(),
  /** Store URLs the agent may search and buy from. Doubles as the mandate seller allowlist. */
  stores: z.array(z.url()).default([]),
  network: z.enum(["testnet", "mainnet"]).default("testnet"),
  /** Reused verbatim from @agentpos/mcp-buyer: the agent can never change it. */
  mandate: mandateSchema,
  updatedAt: z.string(),
});

export type BuyerWebProfileInput = z.input<typeof buyerWebProfileSchema>;
export type BuyerWebProfile = z.output<typeof buyerWebProfileSchema>;

export type ProposalStatus = "pending" | "approved" | "rejected" | "expired" | "paid";

/**
 * A purchase the agent wants to make, frozen as a quote, waiting for the human.
 * `approved` means exactly that and no more: the money has NOT moved. Payment happens later,
 * on the machine that holds the key; `paid` is only ever set when that machine reports back
 * a settled transaction hash through the signing bridge.
 */
export interface Proposal {
  id: string;
  status: ProposalStatus;
  storeUrl: string;
  storeName: string;
  itemId: string;
  /** Human-readable cart summary, e.g. "2 x Ceramic Mug". */
  title: string;
  quantity: number;
  /** Decimal USDC string as quoted by the store, e.g. "9.9". */
  amount: string;
  /** Same amount in minor units (7 decimals), for arithmetic. */
  amountMinor: string;
  asset: string;
  network: string;
  cartId: string;
  checkoutUrl: string;
  physical: boolean;
  cartExpiresAt: string;
  createdAt: string;
  /** Set when the human approves or rejects. */
  decidedAt?: string;
  /** Set by the signing bridge when the buyer's own machine settled the payment. */
  payment?: { txHash: string; orderId: string; paidAt: string };
  /**
   * Last payment attempt reported failed by the signing bridge. The proposal stays
   * `approved` (the approval still stands); this is why the money has not moved yet.
   */
  failure?: { code: string; message: string; at: string };
}

/**
 * One entry of the pending-signature feed (`GET /api/signer/queue`): everything the buyer's
 * own signer daemon needs to execute the purchase, and nothing that could pay by itself.
 */
export interface SignerQueueItem {
  proposalId: string;
  storeUrl: string;
  itemId: string;
  quantity: number;
  title: string;
  /** Quoted total the human approved, decimal USDC. The payer must not exceed it. */
  amount: string;
  amountMinor: string;
  asset: string;
  network: string;
  approvedAt: string;
}

/**
 * What an approval yields: everything needed to pay, and nothing that can pay by itself.
 * The signature this refers to only exists on the buyer's own machine.
 */
export interface PaymentInstructions {
  proposalId: string;
  storeUrl: string;
  cartId: string;
  checkoutUrl: string;
  amount: string;
  asset: string;
  network: string;
  /** Always "local": this server has no key and cannot sign. */
  signer: "local";
  /** Exact command to run where the wallet key lives. */
  cli: string;
  note: string;
}

export interface ApprovalResult {
  proposal: Proposal;
  instructions: PaymentInstructions;
}

/**
 * The single owner account of this buyer space. One per installation: this surface belongs
 * to one person, the one whose money it can commit. The password is only ever here as a
 * scrypt hash (salt and parameters included); the plaintext is never stored or logged.
 */
export interface OwnerAccount {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a session is allowed to do. `full` is the signed-in owner. `recovery` is what
 * proving a recovery code (or a WhatsApp code, or the operator token) buys: the right to
 * set a new password and nothing else, not the mandate, not the proposals, not an approval.
 */
export type SessionScope = "full" | "recovery";

/**
 * A live login. The cookie carries this row's `id` and nothing else: no signed payload, no
 * claim the server has to trust. Deleting the row ends the session everywhere, at once.
 */
export interface SessionRecord {
  id: string;
  accountId: string;
  /** Per-session CSRF token, rendered in every form and compared in constant time. */
  csrfToken: string;
  createdAt: string;
  /** Slides forward on every authenticated request. */
  expiresAt: string;
  lastSeenAt: string;
  /** sha256 of the client address, first 8 hex chars. The address itself is never stored. */
  ipHash: string;
  /** Coarse browser family ("Chrome", "Firefox", "curl"), never the full user-agent. */
  uaFamily: string;
  /** `full` unless this session came out of a recovery. See SessionScope. */
  scope: SessionScope;
}

/**
 * One printable recovery code, as it is kept: a scrypt hash and whether it has been spent.
 * The code itself exists on the owner's paper and nowhere else, not even in a log line.
 */
export interface RecoveryCodeRecord {
  id: number;
  codeHash: string;
  createdAt: string;
  /** Set the moment the code is spent; a spent code never works again. */
  usedAt: string | undefined;
}

/** What a recovery challenge is: a WhatsApp code sent out, or an operator's one-time URL. */
export type RecoveryChallengeKind = "whatsapp" | "operator";

/**
 * A short-lived, single-use secret waiting to be presented back. At most one per kind: a
 * new one replaces the old, so asking for a second WhatsApp code retires the first.
 */
export interface RecoveryChallenge {
  kind: RecoveryChallengeKind;
  /** scrypt hash of the code or token. The value itself is shown once and never stored. */
  codeHash: string;
  createdAt: string;
  expiresAt: string;
  /** Wrong guesses so far. The challenge dies at MAX_RECOVERY_ATTEMPTS. */
  attempts: number;
}

/** What the owner can read on the `Accesos` panel: who got in, who tried, what was approved. */
export interface AccessEntry {
  seq: number;
  at: string;
  event:
    | "setup"
    | "login_ok"
    | "login_failed"
    | "login_rate_limited"
    | "logout"
    | "session_expired"
    | "approval"
    | "reauth_failed"
    | "csrf_invalid"
    /** A new set of printable recovery codes was generated; the old set stopped working. */
    | "recovery_codes_generated"
    /** A six-digit code was sent to the owner's allowlisted WhatsApp number. */
    | "recovery_code_sent"
    /** A code (or the operator token) checked out: a recovery session was opened. */
    | "recovery_started"
    /** A code, a WhatsApp code or an operator token was refused. */
    | "recovery_failed"
    /** Too many recovery attempts from this address or against this account. */
    | "recovery_rate_limited"
    /** A recovery session set a new password. Every session died with it. */
    | "recovery_completed"
    /** The owner changed their password from inside a live session. */
    | "password_changed"
    /** The operator issued a one-time recovery URL from the server's command line. */
    | "operator_token_issued";
  ipHash: string;
  uaFamily: string;
  /** sha256 of the email tried, first 8 hex chars. Never the email itself. */
  emailHash: string;
  /** One short line of context (the proposal approved, for instance). Never a secret. */
  detail: string;
}

/** One row of the append-only activity log. */
export interface ActivityEntry {
  seq: number;
  at: string;
  kind:
    | "profile.saved"
    | "search"
    | "proposal.created"
    | "proposal.approved"
    | "proposal.rejected"
    | "proposal.expired"
    | "signer.queue"
    | "proposal.paid"
    | "proposal.payment_failed";
  data: Record<string, unknown>;
}

/** Channel-agnostic snapshot: what a web page or a future WhatsApp adapter reports. */
export interface ServiceStatus {
  profileConfigured: boolean;
  walletLinked: boolean;
  network: string;
  stores: string[];
  mandate?: {
    maxPerTx: string;
    maxTotal: string;
    period: string;
    allowPhysicalGoods: boolean;
  };
  /** City and country of the shipping address on file. Never the full address. */
  shipping?: { city: string; country: string };
  /**
   * The broken state this platform must not hide: the mandate allows physical goods but the
   * store could never ship, because there is no address or no contact email on file.
   */
  physicalWithoutShipping: boolean;
  pendingProposals: number;
  approvedAwaitingSignature: number;
  /** Sum of approved proposals in the current mandate period, decimal USDC. */
  approvedInPeriod: string;
}
