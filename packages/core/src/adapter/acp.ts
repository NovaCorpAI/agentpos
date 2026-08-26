/**
 * ACP adapter (SPEC 09): product feed as `ProductsResponse` from the pinned schema.feed.json.
 * Prices in the ACP feed are fiat (ISO 4217 minor units), so we publish the source price the
 * merchant sells at; the USDC/x402 terms live in the UCP payment handler and our catalog.
 */
import type { SourcePrice } from "../catalog.js";
import { AgentGateError } from "../errors.js";

export interface AcpFeedItemInput {
  id: string;
  title: string;
  description: string;
  url: string;
  imageUrl?: string;
  priceSrc?: SourcePrice;
  available: boolean;
  /** Extensible fulfillment state; known values: in_stock, limited_stock, backorder, preorder, out_of_stock, discontinued. */
  status?: string;
}

export interface AcpPrice {
  amount: number;
  currency: string;
}

export interface AcpVariant {
  id: string;
  title: string;
  url: string;
  price?: AcpPrice;
  availability: { available: boolean; status: string };
}

export interface AcpProduct {
  id: string;
  title: string;
  description: { plain: string };
  url: string;
  media?: Array<{ type: "image"; url: string }>;
  variants: AcpVariant[];
}

export interface AcpProductsResponse {
  products: AcpProduct[];
}

/** ISO 4217 minor unit exponents that differ from the default of 2. */
const MINOR_UNITS: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  CLP: 0,
  VND: 0,
  ISK: 0,
  XOF: 0,
  XAF: 0,
  UGX: 0,
  PYG: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  JOD: 3,
  TND: 3,
};

/** "9.90" USD -> 990. Integer arithmetic only. */
export function fiatToMinorUnits(price: SourcePrice): AcpPrice {
  const currency = price.currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new AgentGateError("INVALID_AMOUNT", `Not an ISO 4217 currency: ${price.currency}`, {
      hint: "ACP feeds require a three-letter ISO 4217 currency; USDC prices are published via the UCP payment handler instead.",
    });
  }
  const exponent = MINOR_UNITS[currency] ?? 2;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(price.amount.replace(/,/g, ""));
  if (!match) {
    throw new AgentGateError("INVALID_AMOUNT", `Invalid price amount: ${price.amount}`, {
      hint: "Use a decimal string such as '12.50'.",
    });
  }
  const whole = match[1] ?? "0";
  const frac = (match[2] ?? "").padEnd(exponent, "0").slice(0, exponent);
  return { amount: Number(`${whole}${frac}`), currency };
}

export function buildAcpFeed(items: AcpFeedItemInput[]): AcpProductsResponse {
  return {
    products: items.map((item) => ({
      id: item.id,
      title: item.title,
      description: { plain: item.description || item.title },
      url: item.url,
      ...(item.imageUrl ? { media: [{ type: "image" as const, url: item.imageUrl }] } : {}),
      variants: [
        {
          id: item.id,
          title: item.title,
          url: item.url,
          ...(item.priceSrc ? { price: fiatToMinorUnits(item.priceSrc) } : {}),
          availability: {
            available: item.available,
            status: item.status ?? (item.available ? "in_stock" : "out_of_stock"),
          },
        },
      ],
    })),
  };
}
