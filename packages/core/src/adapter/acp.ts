/**
 * ACP adapter (SPEC 09): product feed. Skeleton in Phase 0; validate against the pinned
 * JSON Schema (agentic-commerce-protocol, version in versions.ts) in Phase 2.
 */
import type { UsdcMinor } from "../money.js";
import { formatUsdc } from "../money.js";
import { ADAPTER_VERSION, PROTOCOL_VERSIONS } from "./versions.js";

export interface AcpFeedItemInput {
  id: string;
  title: string;
  description: string;
  url: string;
  imageUrl?: string;
  priceUsdc: UsdcMinor;
  availability: "in_stock" | "out_of_stock" | "preorder";
  attributes?: Record<string, string>;
}

export interface AcpFeed {
  version: string;
  adapterVersion: string;
  merchant: { name: string; url: string };
  products: Array<{
    id: string;
    title: string;
    description: string;
    link: string;
    image_link?: string;
    price: { amount: string; currency: "USDC" };
    availability: AcpFeedItemInput["availability"];
    attributes?: Record<string, string>;
  }>;
}

export function buildAcpFeed(
  merchant: { name: string; url: string },
  items: AcpFeedItemInput[],
): AcpFeed {
  return {
    version: PROTOCOL_VERSIONS.acp.version,
    adapterVersion: ADAPTER_VERSION,
    merchant,
    products: items.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      link: item.url,
      ...(item.imageUrl ? { image_link: item.imageUrl } : {}),
      price: { amount: formatUsdc(item.priceUsdc), currency: "USDC" },
      availability: item.availability,
      ...(item.attributes ? { attributes: item.attributes } : {}),
    })),
  };
}
