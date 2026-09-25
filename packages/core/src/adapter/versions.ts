/**
 * Pinned protocol versions (guardrail 3). Update ONLY here, in wt-core, and document the
 * change in docs/adapter-versions.md. Every emitted surface carries `adapterVersion`.
 */
export const ADAPTER_VERSION = "0.2.0";

/**
 * Version of the `PaymentRail` interface itself (adapter/rails.ts), independent of any single
 * rail's protocol version. Bump on every breaking change to the interface so a store can tell
 * which shape of rail it is running.
 */
export const PAYMENT_RAIL_INTERFACE_VERSION = "1.0.0";

/**
 * Pinned rail identifiers (reverse-DNS). A rail id is part of our public surface: it appears in
 * discovery, reconciliation and (later) the merchant's routing policy, so it NEVER changes once
 * published. Declared here, implemented in adapter/rails/. Ids listed as reserved have no
 * implementation yet and must not be registered.
 */
export const PAYMENT_RAIL_IDS = {
  /** x402 + exact scheme over Stellar. */
  x402Stellar: "org.x402.stellar",
  /**
   * Transbank (Chile) card rail over the merchant's OWN commerce code: Webpay Plus for a first
   * purchase (the human pays on Transbank's page) and Oneclick Mall for repeat purchases (the
   * agent charges an enrolled card without the human present). Credentials are the merchant's.
   */
  transbankWebpay: "cl.transbank.webpay",
} as const;

/**
 * Rails we expect to implement, kept here so the id is fixed before any code exists and two
 * worktrees cannot invent two spellings for the same rail. NOT registrable.
 */
export const RESERVED_PAYMENT_RAIL_IDS = {
  /** Amazon agentic payments (hackathon bridge; declared and simulated, never charged for real). */
  amazonPayments: "com.amazon.payments",
  /** The merchant's own fiat acquirer, executed by the merchant's sidecar (plan/RIELES.md). */
  merchantFiat: "com.novacorplabs.agentpos.merchant-fiat",
} as const;

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
    /** Business profile served at /.well-known/ucp (profile.json#/$defs/business_schema). */
    profilePath: "/.well-known/ucp",
    /** Release snapshot we publish against. Real UCP releases are tagged vYYYY-MM-DD. */
    version: "2026-08-25",
    spec: "https://ucp.dev/2026-08-25/specification/overview/",
    schemas: {
      profile: "https://ucp.dev/2026-08-25/schemas/profile.json",
      paymentHandler: "https://ucp.dev/2026-08-25/schemas/payment_handler.json",
      checkout: "https://ucp.dev/2026-08-25/schemas/shopping/checkout.json",
      catalogSearch: "https://ucp.dev/2026-08-25/schemas/shopping/catalog_search.json",
      catalogLookup: "https://ucp.dev/2026-08-25/schemas/shopping/catalog_lookup.json",
      shoppingRest: "https://ucp.dev/2026-08-25/services/shopping/rest.openapi.json",
    },
    checkedAt: "2026-08-29",
    source:
      "https://github.com/Universal-Commerce-Protocol/ucp (branch release/2026-08-25, source/schemas). Re-vendor with `pnpm --filter @agentpos/core vendor:schemas`.",
    notes:
      "Corrected 2026-08-29: the previous pin (2026-01-01) was never a released snapshot and its schema URLs 404ed. Real releases are 2026-01-11, 2026-01-23, 2026-04-08 and 2026-08-25. Our business profile validates unchanged against 2026-08-25. dev.ucp.shopping capabilities are NOT declared until we implement UCP checkout semantics (Build phase).",
  },
  acp: {
    /** Date-based versioning by OpenAI/Stripe. Feed = ProductsResponse from schema.feed.json. */
    version: "2026-04-17",
    schemas: {
      feed: "https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/blob/main/spec/2026-04-17/json-schema/schema.feed.json",
    },
    /** Released snapshots upstream, newest last. 2026-04-17 is still the latest. */
    releases: ["2025-09-29", "2025-12-12", "2026-01-16", "2026-01-30", "2026-04-17"],
    checkedAt: "2026-08-29",
    source: "https://github.com/agentic-commerce-protocol/agentic-commerce-protocol",
    notes:
      "Product feed only (fiat prices in ISO 4217 minor units, as the schema requires). Checkout + delegated payment are Build-phase slots.",
  },
  rails: {
    /** Interface version of adapter/rails.ts (see PAYMENT_RAIL_INTERFACE_VERSION). */
    interface: PAYMENT_RAIL_INTERFACE_VERSION,
    /** Rail ids with an implementation behind them today. */
    implemented: [PAYMENT_RAIL_IDS.x402Stellar, PAYMENT_RAIL_IDS.transbankWebpay],
    checkedAt: "2026-09-24",
    source: "plan/RIELES.md",
    notes:
      "Two rails: x402 on Stellar (settles on ledger) and Transbank Webpay/Oneclick (Chile, cards, settles at the acquirer). Adding a rail is additive: it never changes the catalog or order surfaces. Routing between rails belongs to packages/policy, not here.",
  },
  transbank: {
    /** Webpay Plus and Oneclick Mall REST API version, part of every endpoint path. */
    version: "1.2",
    hosts: {
      integration: "https://webpay3gint.transbank.cl",
      production: "https://webpay3g.transbank.cl",
    },
    /** Integration credentials are public (no contract needed); listed in the docs repo below. */
    checkedAt: "2026-09-24",
    /** A plain URI: it is published as the handler's `spec` in the UCP profile (format: uri). */
    source: "https://github.com/TransbankDevelopers/transbank-developers-docs",
    notes:
      "Webpay Plus: documentacion/webpay-plus; Oneclick Mall: documentacion/oneclick. Verified 2026-09-24 against the integration environment: create transaction and start inscription both answer 200 with the public credentials. Approved means status AUTHORIZED and response_code 0. A Webpay Plus token lives 5 minutes; commit exactly once.",
  },
  agentpos: {
    /** Our own namespaced identifiers inside UCP registries. */
    serviceName: "com.novacorplabs.agentpos",
    /** Same string as the x402 rail id: the UCP payment handler IS that rail. */
    paymentHandlerName: PAYMENT_RAIL_IDS.x402Stellar,
    paymentHandlerId: "x402-stellar",
    /**
     * Published on the public site (apps/landing/schemas, served at agentposhq.com/schemas).
     * The previous host, agentpos.novacorplabs.com, never existed in DNS; corrected 2026-09-25.
     * The machine-readable spec IS the OpenAPI document.
     */
    spec: "https://agentposhq.com/schemas/agentpos-service.openapi.json",
    serviceSchema: "https://agentposhq.com/schemas/agentpos-service.openapi.json",
    handlerSchema: "https://agentposhq.com/schemas/x402-stellar-handler.json",
  },
} as const;
