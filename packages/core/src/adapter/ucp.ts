/**
 * UCP adapter (SPEC 09): builds the business profile served at /.well-known/ucp.
 * Shape follows profile.json#/$defs/business_schema (registries keyed by reverse-domain names,
 * YYYY-MM-DD versions). Validated against the pinned official schemas in conformance tests.
 *
 * Honesty rule: we only declare what the site actually implements. The AgentGate service and the
 * x402 Stellar payment handler are real; dev.ucp.shopping capabilities are not declared until the
 * UCP checkout semantics ship (Build phase).
 */
import { ADAPTER_VERSION, PROTOCOL_VERSIONS } from "./versions.js";

export interface UcpProfileInput {
  siteUrl: string;
  /** Path prefix of the AgentGate routes, e.g. "/agentgate". */
  basePath: string;
  /** CAIP-2 network the x402 handler settles on. */
  network: `stellar:${string}`;
  /** Checkout asset symbol (USDC by default). */
  asset: string;
  /** Contract id of the asset on that network. */
  assetAddress: string;
  /** Stellar address that receives payments (watch-only; never a key). */
  payTo: string;
  policies?: {
    shipping?: string | undefined;
    cancellation?: string | undefined;
    returns?: string | undefined;
    contact?: string | undefined;
  };
}

export interface UcpServiceEntry {
  version: string;
  transport: "rest" | "mcp";
  endpoint: string;
  spec: string;
  schema?: string;
  config?: Record<string, unknown>;
}

export interface UcpPaymentHandlerEntry {
  id: string;
  version: string;
  spec: string;
  schema: string;
  available_instruments: Array<{ type: string }>;
  config: Record<string, unknown>;
}

export interface UcpBusinessProfile {
  ucp: {
    version: string;
    services: Record<string, UcpServiceEntry[]>;
    capabilities: Record<string, never[]>;
    payment_handlers: Record<string, UcpPaymentHandlerEntry[]>;
    /** AgentGate-specific, ignored by UCP consumers (protocol object is open). */
    "com.novacorplabs.agentgate"?: Record<string, unknown>;
  };
}

export function buildUcpProfile(input: UcpProfileInput): UcpBusinessProfile {
  const base = `${input.siteUrl.replace(/\/+$/, "")}${input.basePath}`;
  const v = PROTOCOL_VERSIONS.ucp.version;
  const ag = PROTOCOL_VERSIONS.agentgate;
  return {
    ucp: {
      version: v,
      services: {
        [ag.serviceName]: [
          {
            version: v,
            transport: "rest",
            endpoint: base,
            spec: ag.spec,
            schema: ag.serviceSchema,
          },
          { version: v, transport: "mcp", endpoint: `${base}/mcp`, spec: ag.spec },
        ],
      },
      capabilities: {},
      payment_handlers: {
        [ag.paymentHandlerName]: [
          {
            id: ag.paymentHandlerId,
            version: v,
            spec: PROTOCOL_VERSIONS.x402.source,
            schema: ag.handlerSchema,
            available_instruments: [{ type: "stellar_wallet" }],
            config: {
              protocol: "x402",
              x402Version: PROTOCOL_VERSIONS.x402.protocol,
              scheme: PROTOCOL_VERSIONS.x402.scheme,
              network: input.network,
              asset: input.asset,
              assetAddress: input.assetAddress,
              payTo: input.payTo,
              checkout: `${base}/checkout`,
              cart: `${base}/cart`,
            },
          },
        ],
      },
      "com.novacorplabs.agentgate": {
        adapterVersion: ADAPTER_VERSION,
        catalog: `${base}/catalog`,
        feed: `${base}/feed`,
        ...(input.policies ? { policies: input.policies } : {}),
      },
    },
  };
}
