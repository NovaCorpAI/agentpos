/**
 * UCP adapter (SPEC 09): builds the /.well-known/ucp manifest from a site's published state.
 * Skeleton in Phase 0: shape follows the public UCP overview (services / capabilities /
 * payment_handlers). MUST be validated against the pinned JSON Schema in Phase 2 before
 * any site publishes it.
 */
import { ADAPTER_VERSION, PROTOCOL_VERSIONS } from "./versions.js";

export interface UcpManifestInput {
  siteUrl: string;
  displayName: string;
  /** CAIP-2 network the x402 handler settles on. */
  network: `stellar:${string}`;
  capabilities?: Array<"checkout" | "discovery">;
  policies?: {
    shipping?: string | undefined;
    cancellation?: string | undefined;
    returns?: string | undefined;
    contact?: string | undefined;
  };
}

export interface UcpManifest {
  ucp: {
    version: string;
    adapterVersion: string;
    services: Record<string, { version: string; rest: { endpoint: string } }>;
    capabilities: Array<{ name: string; version: string }>;
    payment_handlers: Array<{
      id: string;
      name: string;
      spec: string;
      config: Record<string, unknown>;
    }>;
    policies?: UcpManifestInput["policies"];
  };
}

export function buildUcpManifest(input: UcpManifestInput): UcpManifest {
  const base = input.siteUrl.replace(/\/+$/, "");
  const caps = input.capabilities ?? ["discovery", "checkout"];
  return {
    ucp: {
      version: PROTOCOL_VERSIONS.ucp.version,
      adapterVersion: ADAPTER_VERSION,
      services: {
        "dev.ucp.shopping": {
          version: PROTOCOL_VERSIONS.ucp.version,
          rest: { endpoint: `${base}/agentgate` },
        },
      },
      capabilities: caps.map((name) => ({
        name: `dev.ucp.shopping.${name}`,
        version: PROTOCOL_VERSIONS.ucp.version,
      })),
      payment_handlers: [
        {
          id: "x402-stellar",
          name: "x402 (USDC on Stellar)",
          spec: "https://github.com/x402-foundation/x402",
          config: {
            network: input.network,
            scheme: PROTOCOL_VERSIONS.x402.scheme,
            checkout: `${base}/agentgate/checkout`,
          },
        },
      ],
      ...(input.policies ? { policies: input.policies } : {}),
    },
  };
}
