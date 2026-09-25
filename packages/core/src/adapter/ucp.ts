/**
 * UCP adapter (SPEC 09): builds the business profile served at /.well-known/ucp.
 * Shape follows profile.json#/$defs/business_schema (registries keyed by reverse-domain names,
 * YYYY-MM-DD versions). Validated against the pinned official schemas in conformance tests.
 *
 * Honesty rule: we only declare what the site actually implements. The AgentPOS service and the
 * x402 Stellar payment handler are real; dev.ucp.shopping capabilities are not declared until the
 * UCP checkout semantics ship (Build phase).
 */
import type { PaymentRailDescription } from "./rails.js";
import { ADAPTER_VERSION, PROTOCOL_VERSIONS } from "./versions.js";

export interface UcpProfileInput {
  siteUrl: string;
  /** Path prefix of the AgentPOS routes, e.g. "/agentpos". */
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
  /**
   * Other rails the store accepts besides x402, as their `describe()` reports them. Each becomes
   * one more payment handler; the x402 handler is unchanged (adding a rail is additive).
   */
  rails?: PaymentRailDescription[];
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
    /** AgentPOS-specific, ignored by UCP consumers (protocol object is open). */
    "com.novacorplabs.agentpos"?: Record<string, unknown>;
  };
}

export function buildUcpProfile(input: UcpProfileInput): UcpBusinessProfile {
  const base = `${input.siteUrl.replace(/\/+$/, "")}${input.basePath}`;
  const v = PROTOCOL_VERSIONS.ucp.version;
  const ag = PROTOCOL_VERSIONS.agentpos;
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
        // A card rail is a second handler under its own rail id. No secrets, no commerce codes:
        // only what the rail itself publishes, plus where a card checkout starts.
        ...Object.fromEntries(
          (input.rails ?? []).map((rail) => [
            rail.id,
            [
              {
                id: rail.id.split(".").join("-"),
                version: v,
                spec: rail.spec ?? ag.spec,
                // Our own schema for this handler's config, published next to the x402 one.
                schema: ag.handlerSchema.replace(
                  /[^/]+\.json$/,
                  `${rail.id.split(".").join("-")}-handler.json`,
                ),
                available_instruments: [{ type: "card" }],
                config: {
                  protocol: rail.protocol,
                  protocolVersion: rail.protocolVersion,
                  networks: rail.capabilities.networks,
                  currencies: rail.capabilities.currencies,
                  settlesOnLedger: rail.capabilities.settlesOnLedger,
                  checkout: `${base}/checkout/card`,
                  cart: `${base}/cart`,
                },
              },
            ],
          ]),
        ),
      },
      "com.novacorplabs.agentpos": {
        adapterVersion: ADAPTER_VERSION,
        catalog: `${base}/catalog`,
        feed: `${base}/feed`,
        ...(input.policies ? { policies: input.policies } : {}),
      },
    },
  };
}
