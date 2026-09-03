/**
 * Catalog and order domain types shared by scanner, site library, connectors and the buyer.
 * Money is UsdcMinor (integer, 7 decimals) in memory; use the *Json helpers at the edges.
 */
import { z } from "zod";
import type { UsdcMinor } from "./money.js";
import { usdcFromMinor } from "./money.js";

export const ITEM_TYPES = ["product", "service", "api"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const ITEM_STATUSES = ["draft", "confirmed", "published"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export interface SourcePrice {
  /** Decimal string as found in the source, e.g. "14.50". */
  amount: string;
  /** ISO 4217, e.g. "USD". */
  currency: string;
}

export interface Evidence {
  /** Where the fact was read: connector id, page URL, sitemap... */
  source: string;
  /** Selector, JSON-LD path, field name or line reference inside the source. */
  locator: string;
}

export interface CatalogItem {
  /** Stable local id (slug). */
  id: string;
  /** Platform product id when a connector is the source. */
  externalId?: string;
  type: ItemType;
  title: string;
  /** Short, factual description written for agents (no marketing). */
  descriptionAgent: string;
  url: string;
  imageUrl?: string;
  attributes: Record<string, string>;
  /** Confirmed price in USDC minor units. Undefined only while the item is a draft. */
  priceUsdc?: UsdcMinor;
  priceSrc?: SourcePrice;
  stockMode: "tracked" | "untracked";
  /** Physical goods require a shipping address at checkout. */
  physical: boolean;
  status: ItemStatus;
  /** Stellar address that receives payments for this item; defaults to the site payTo. */
  payTo?: string;
  sourceEvidence: Evidence[];
}

/** Draft produced by the scanner: same shape plus a confidence score and a price suggestion. */
export interface CatalogItemDraft extends Omit<CatalogItem, "priceUsdc" | "status"> {
  priceUsdcSuggested?: UsdcMinor;
  /** 0..1, how confident the scanner is that this is a real sellable item with correct fields. */
  confidence: number;
}

/** Derived from the zod schemas below so HTTP/MCP inputs type-check under exactOptionalPropertyTypes. */
export type Address = z.output<typeof addressSchema>;
export type BuyerContact = z.output<typeof buyerContactSchema>;

export interface CartLine {
  itemId: string;
  quantity: number;
}

export interface QuoteLine extends CartLine {
  title: string;
  externalId?: string;
  unitPriceUsdc: UsdcMinor;
  lineTotalUsdc: UsdcMinor;
  physical: boolean;
}

export interface Quote {
  lines: QuoteLine[];
  totalUsdc: UsdcMinor;
  /** Address that receives the payment for this cart (single payTo per cart in v1). */
  payTo: string;
  requiresShipping: boolean;
}

/**
 * Outcome of the merchant policy for this cart (M1). `requires_approval` carts are quoted but
 * cannot settle until a human approves them (M2); they still count toward the period volume.
 */
export interface CartPolicyState {
  decision: "allowed" | "requires_approval";
  code?: string;
  message?: string;
  evaluatedAt: string;
}

/**
 * Who asked (M3). Structural mirror of `AgentIdentity` in @agentpos/identity, kept here so the
 * domain types do not depend on the identity package. `authenticated: false` is a legitimate
 * value: an anonymous wallet is a valid buyer unless the merchant says otherwise.
 */
export interface AgentIdentityRecord {
  authenticated: boolean;
  agentKey?: string | undefined;
  owner?: string | undefined;
  name?: string | undefined;
  attested: boolean;
  verifiedAt?: string | undefined;
}

export interface Cart {
  id: string;
  lines: CartLine[];
  quote: Quote;
  buyer?: BuyerContact;
  shipping?: Address;
  policy?: CartPolicyState;
  agent?: AgentIdentityRecord;
  traceId?: string;
  createdAt: string;
  expiresAt: string;
}

export const ORDER_STATUSES = [
  "pending_payment",
  "paid",
  "fulfilled",
  "cancelled",
  "expired",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface PaymentRecord {
  txHash: string;
  network: string;
  asset: string;
  amountMinor: UsdcMinor;
  payer?: string;
  ts: string;
}

export interface Order {
  id: string;
  cartId: string;
  status: OrderStatus;
  quote: Quote;
  buyer?: BuyerContact;
  shipping?: Address;
  payment?: PaymentRecord;
  /** Id in the merchant's platform (Woo order number, Shopify order id...). */
  externalOrderId?: string;
  externalAdminUrl?: string;
  connectorError?: {
    code: string;
    message: string;
    hint: string;
    retryable: boolean;
    attempts: number;
  };
  /**
   * Set when a settled payment does not match the quoted terms (amount, asset, payTo, network).
   * The payment is kept, the platform order is NOT created, and an alert is raised (G1).
   */
  hold?: { reason: "PAYMENT_MISMATCH"; details: Record<string, unknown>; at: string };
  /** Identity of the agent that placed the order (M3), as verified at cart time. */
  agent?: AgentIdentityRecord;
  /** Correlates logs across scan, cart, checkout, settle and order creation. */
  traceId?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Connectors (SPEC 08)
// ---------------------------------------------------------------------------

export interface ConnectorProduct {
  externalId: string;
  title: string;
  description: string;
  url: string;
  imageUrl?: string;
  sku?: string;
  price?: SourcePrice;
  stock: { managed: boolean; quantity?: number; inStock: boolean };
  physical: boolean;
  attributes: Record<string, string>;
}

export interface AvailabilityResult {
  itemId: string;
  externalId?: string;
  available: boolean;
  quantity?: number;
  price?: SourcePrice;
}

export interface PaidOrderInput {
  orderId: string;
  lines: QuoteLine[];
  totalUsdc: UsdcMinor;
  payment: PaymentRecord;
  buyer?: BuyerContact;
  shipping?: Address;
  createdAt: string;
}

export interface ConnectorOrderResult {
  externalOrderId: string;
  adminUrl?: string;
}

export interface OrderConnector {
  readonly platform: "woocommerce" | "shopify" | "generic";
  /** Products as the platform sees them; used by the scanner as its highest-trust source. */
  listProducts?(): Promise<ConnectorProduct[]>;
  /** Live stock and price for the given items. */
  getAvailability(
    items: Array<{ itemId: string; externalId?: string; quantity: number }>,
  ): Promise<AvailabilityResult[]>;
  /** Creates the order in the merchant's system. Called ONLY after settlement (guardrail 6). */
  createOrder(input: PaidOrderInput): Promise<ConnectorOrderResult>;
  getOrderStatus?(externalOrderId: string): Promise<{ status: string; raw?: unknown }>;
}

// ---------------------------------------------------------------------------
// JSON (de)serialization: bigint <-> string at storage/HTTP edges
// ---------------------------------------------------------------------------

const minorString = z.string().regex(/^\d+$/);

export const sourcePriceSchema = z.object({
  amount: z.string().regex(/^\d+(\.\d+)?$/),
  currency: z.string().length(3),
});
export const evidenceSchema = z.object({ source: z.string().min(1), locator: z.string().min(1) });
export const addressSchema = z.object({
  name: z.string().min(1),
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  region: z.string().optional(),
  postalCode: z.string().min(1),
  country: z.string().length(2),
  phone: z.string().optional(),
});
export const buyerContactSchema = z.object({ email: z.email(), name: z.string().optional() });
export const cartLineSchema = z.object({
  itemId: z.string().min(1),
  quantity: z.number().int().positive().max(1000),
});

export const catalogItemJsonSchema = z.object({
  id: z.string().min(1),
  externalId: z.string().optional(),
  type: z.enum(ITEM_TYPES),
  title: z.string().min(1),
  descriptionAgent: z.string(),
  url: z.url(),
  imageUrl: z.url().optional(),
  attributes: z.record(z.string(), z.string()).default({}),
  priceUsdc: minorString.optional(),
  priceSrc: sourcePriceSchema.optional(),
  stockMode: z.enum(["tracked", "untracked"]).default("untracked"),
  physical: z.boolean().default(true),
  status: z.enum(ITEM_STATUSES).default("draft"),
  payTo: z.string().optional(),
  sourceEvidence: z.array(evidenceSchema).default([]),
});
export type CatalogItemJson = z.input<typeof catalogItemJsonSchema>;

export const catalogItemDraftJsonSchema = catalogItemJsonSchema
  .omit({ priceUsdc: true, status: true })
  .extend({
    priceUsdcSuggested: minorString.optional(),
    confidence: z.number().min(0).max(1),
  });
export type CatalogItemDraftJson = z.input<typeof catalogItemDraftJsonSchema>;

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

export function catalogItemToJson(item: CatalogItem): CatalogItemJson {
  return stripUndefined({ ...item, priceUsdc: item.priceUsdc?.toString() }) as CatalogItemJson;
}

export function catalogItemFromJson(input: unknown): CatalogItem {
  const parsed = catalogItemJsonSchema.parse(input);
  return stripUndefined({
    ...parsed,
    priceUsdc: parsed.priceUsdc === undefined ? undefined : usdcFromMinor(parsed.priceUsdc),
  }) as CatalogItem;
}

export function draftToJson(draft: CatalogItemDraft): CatalogItemDraftJson {
  return stripUndefined({
    ...draft,
    priceUsdcSuggested: draft.priceUsdcSuggested?.toString(),
  }) as CatalogItemDraftJson;
}

export function draftFromJson(input: unknown): CatalogItemDraft {
  const parsed = catalogItemDraftJsonSchema.parse(input);
  return stripUndefined({
    ...parsed,
    priceUsdcSuggested:
      parsed.priceUsdcSuggested === undefined
        ? undefined
        : usdcFromMinor(parsed.priceUsdcSuggested),
  }) as CatalogItemDraft;
}

/** Generic bigint-safe JSON: bigints become strings; callers re-hydrate known fields. */
export function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export function slugify(input: string): string {
  return (
    input
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "item"
  );
}
