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
    /** Protocol version (YYYY-MM-DD) as used by the reference scaffold in the UCP repo. */
    version: "2026-01-01",
    spec: "https://ucp.dev/2026-01-01/specification/overview",
    schemas: {
      profile: "https://ucp.dev/schemas/profile.json",
      checkout: "https://ucp.dev/schemas/shopping/checkout.json",
      catalogSearch: "https://ucp.dev/schemas/shopping/catalog_search.json",
      catalogLookup: "https://ucp.dev/schemas/shopping/catalog_lookup.json",
      shoppingRest: "https://ucp.dev/2026-01-01/services/shopping/rest.openapi.json",
    },
    checkedAt: "2026-08-25",
    source:
      "https://github.com/Universal-Commerce-Protocol/ucp (source/schemas, scripts/scaffolds/profile_response.json)",
    notes:
      "v1 publishes a schema-valid business profile with an AgentGate service and the x402 Stellar payment handler. dev.ucp.shopping capabilities are NOT declared until we implement UCP checkout semantics (Build phase).",
  },
  acp: {
    /** Date-based versioning by OpenAI/Stripe. Feed = ProductsResponse from schema.feed.json. */
    version: "2026-04-17",
    schemas: {
      feed: "https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/blob/main/spec/2026-04-17/json-schema/schema.feed.json",
    },
    checkedAt: "2026-08-25",
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
