/**
 * Pinned protocol versions (guardrail 3). Update ONLY here, in wt-core, and document the
 * change in docs/adapter-versions.md. Every emitted surface carries `adapterVersion`.
 */
export const ADAPTER_VERSION = "0.1.0";

export const PROTOCOL_VERSIONS = {
  x402: {
    /** x402 wire protocol major version (V2 headers: PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE). */
    protocol: 2,
    sdk: "2.23.0",
    scheme: "exact",
    checkedAt: "2026-08-25",
    source: "https://github.com/x402-foundation/x402",
    notes: "x402 Foundation (Linux Foundation) targets spec v1.0 in Q3 2026; re-check weekly.",
  },
  ucp: {
    /** Manifest served at /.well-known/ucp. Version string to be pinned against ucp.dev schema in Phase 2. */
    manifestPath: "/.well-known/ucp",
    version: "unpinned",
    checkedAt: "2026-08-25",
    source: "https://ucp.dev",
    notes:
      "Emit for discovery only in v1; validate against published JSON Schema before publishing.",
  },
  acp: {
    /** Date-based versioning by OpenAI/Stripe. Last known stable snapshot. */
    version: "2026-04-17",
    checkedAt: "2026-08-25",
    source: "https://github.com/agentic-commerce-protocol/agentic-commerce-protocol",
    notes: "Product feed only in v1; checkout + delegated payment are Build-phase slots.",
  },
} as const;
