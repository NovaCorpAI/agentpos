/**
 * Pinned protocol versions (guardrail 3). Update ONLY here, in wt-core, and document the
 * change in docs/adapter-versions.md. Every emitted surface carries `adapterVersion`.
 */
export const ADAPTER_VERSION = "0.2.0";

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
      "https://github.com/Universal-Commerce-Protocol/ucp (branch release/2026-08-25, source/schemas). Re-vendor with `pnpm --filter @agentgate/core vendor:schemas`.",
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
  agentgate: {
    /** Our own namespaced identifiers inside UCP registries. */
    serviceName: "com.novacorplabs.agentgate",
    paymentHandlerName: "org.x402.stellar",
    paymentHandlerId: "x402-stellar",
    spec: "https://agentgate.novacorplabs.com/spec/agentgate-service",
    serviceSchema: "https://agentgate.novacorplabs.com/schemas/agentgate-service.openapi.json",
    handlerSchema: "https://agentgate.novacorplabs.com/schemas/x402-stellar-handler.json",
  },
} as const;
