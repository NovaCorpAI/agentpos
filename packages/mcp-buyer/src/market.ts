/**
 * The market call ("llamado al mercado"): one structured request, fanned out to every store the
 * buyer trusts, answered with comparable offers.
 *
 * Three rules shape everything here:
 *  - A store that fails must never fail the call. Whoever did not answer is NAMED in `stores`,
 *    with why, instead of quietly shrinking the result.
 *  - An offer outside the mandate is shown, not hidden. Hiding the cheapest option because of a
 *    limit is how an agent becomes confusing; `mandate.payable` plus a reason is how it stays
 *    honest. Nothing here can pay: payability is a label, the mandate is enforced at `buy`.
 *  - Money is integer minor units all the way through (guardrail 4). Only the formatted strings
 *    are for humans.
 */
import { addUsdc, compareUsdc, formatUsdc, mulUsdc, usdc, usdcFromMinor } from "@agentpos/core";
import type { UsdcMinor } from "@agentpos/core";
import type { Mandate } from "./mandate.js";
import { CATALOG_MAX_FACET_VALUES, normalizeTerm, stockSignal } from "./siteClient.js";
import type { SiteFacetValue, SiteFacets, SiteItem } from "./siteClient.js";

/** What the buyer asks the market for. Everything but `what` is optional. */
export interface MarketCallRequest {
  /** Free text, e.g. "lamina 30x40". Matched by each store over title, description and attributes. */
  what: string;
  /** Exact attribute filters, ANDed, e.g. `{ Fondo: "blanco", Passepartout: "con" }`. */
  attributes?: Record<string, string> | undefined;
  /** Decimal USDC bounds on the UNIT price, as the stores compare them. */
  maxPriceUsdc?: string | undefined;
  minPriceUsdc?: string | undefined;
  physical?: boolean | undefined;
  /** How many units the buyer wants. Totals are quoted for this quantity. Default 1. */
  quantity?: number | undefined;
  /** Extra stores for this call. The mandate still decides which of them may be queried. */
  sites?: string[] | undefined;
  /** Per-store budget in milliseconds. A slow store is reported, never waited for. */
  timeoutMs?: number | undefined;
}

/** Why an offer cannot be paid with this mandate. Machine-readable first, readable second. */
export interface MandateBlock {
  reason: "per_payment_cap" | "period_budget" | "physical_not_allowed" | "seller_not_allowed";
  code: "MANDATE_EXCEEDED" | "SELLER_UNVERIFIED";
  message: string;
  hint: string;
  details: Record<string, unknown>;
}

export interface MarketOfferMandate {
  /** False when at least one `blocks` entry applies. The offer is still listed. */
  payable: boolean;
  /** True when the amount is above the mandate's confirmation threshold: a human must approve. */
  needsApproval: boolean;
  blocks: MandateBlock[];
}

/** One comparable offer. Same shape whatever store it came from. */
export interface MarketOffer {
  store: { name: string; url: string; host: string };
  itemId: string;
  title: string;
  url: string;
  /** The requested attributes this item actually carries, spelled as the store spells them. */
  matchedAttributes: Record<string, string>;
  /** Everything the store says about this item, for the human comparing two of them. */
  attributes: Record<string, string>;
  quantity: number;
  unitPriceMinor: string;
  /** Formatted unit price, e.g. "9.9". */
  unitPrice: string;
  totalMinor: string;
  /** Formatted total for `quantity`, e.g. "19.8". */
  totalUsdc: string;
  asset: string;
  physical: boolean;
  stock: "in_stock" | "out_of_stock" | "unknown";
  mandate: MarketOfferMandate;
}

export type MarketStoreState = "ok" | "timeout" | "error" | "unsupported-filters" | "not-allowed";

/** What each store did. A market call is only as honest as this list. */
export interface MarketStoreReport {
  url: string;
  name: string;
  host: string;
  state: MarketStoreState;
  /** How many offers this store contributed to the result. */
  offers: number;
  /** Matching items the store reported, which can exceed `offers` when paging was capped. */
  total?: number;
  /** True when `total` exceeds what the page cap let us read. */
  truncated?: boolean;
  error?: { code: string; message: string; hint: string };
}

export type MarketFacetValue = SiteFacetValue;
export type MarketFacets = Record<string, MarketFacetValue[]>;

export interface MarketCallResult {
  /** The request as it was understood, after parsing and defaults. */
  query: {
    what: string;
    attributes: Record<string, string>;
    quantity: number;
    minPriceUsdc?: string;
    maxPriceUsdc?: string;
    physical?: boolean;
  };
  /** Cheapest total first, ties broken by store name then title: stable across calls. */
  offers: MarketOffer[];
  stores: MarketStoreReport[];
  /** Per-store facets merged by attribute name, counts summed per value. */
  facets: MarketFacets;
}

/**
 * Merges what each store can filter on into one list the buyer can refine with. Names and
 * values are matched accent- and case-insensitively (two stores rarely capitalize the same
 * way) and shown in the first spelling seen, which keeps "Fondo: blanco 3, negro 2" readable.
 */
export function mergeFacets(perStore: SiteFacets[]): MarketFacets {
  const byName = new Map<string, { name: string; values: Map<string, MarketFacetValue> }>();
  for (const facets of perStore) {
    for (const [name, values] of Object.entries(facets)) {
      const key = normalizeTerm(name);
      let facet = byName.get(key);
      if (!facet) {
        facet = { name, values: new Map() };
        byName.set(key, facet);
      }
      for (const { value, count } of values) {
        const valueKey = normalizeTerm(value);
        const existing = facet.values.get(valueKey);
        if (existing) existing.count += count;
        else facet.values.set(valueKey, { value, count });
      }
    }
  }
  const merged: MarketFacets = {};
  for (const key of [...byName.keys()].sort()) {
    const facet = byName.get(key) as { name: string; values: Map<string, MarketFacetValue> };
    merged[facet.name] = [...facet.values.values()]
      .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
      .slice(0, CATALOG_MAX_FACET_VALUES);
  }
  return merged;
}

/** The requested attributes this item carries, in the store's own spelling. */
export function matchedAttributes(
  item: SiteItem,
  attributes: Record<string, string> | undefined,
): Record<string, string> {
  const matched: Record<string, string> = {};
  for (const [name, value] of Object.entries(attributes ?? {})) {
    const n = normalizeTerm(name);
    const v = normalizeTerm(value);
    for (const [itemName, itemValue] of Object.entries(item.attributes)) {
      if (normalizeTerm(itemName) === n && normalizeTerm(itemValue) === v) {
        matched[itemName] = itemValue;
        break;
      }
    }
  }
  return matched;
}

export interface MandateContext {
  mandate: Mandate;
  /** Already committed in the current mandate period. */
  spentInPeriod: UsdcMinor;
}

/**
 * Every reason this total could not be paid, not just the first one. An agent that is told
 * "over the per-payment cap" and then, once the human raises it, "and also over the budget"
 * has wasted a round trip and the human's patience.
 */
export function annotateMandate(
  context: MandateContext,
  offer: { totalMinor: UsdcMinor; host: string; physical: boolean },
): MarketOfferMandate {
  const { mandate } = context;
  const blocks: MandateBlock[] = [];
  const maxPerTx = usdc(mandate.maxPerTx);
  if (compareUsdc(offer.totalMinor, maxPerTx) > 0) {
    blocks.push({
      reason: "per_payment_cap",
      code: "MANDATE_EXCEEDED",
      message: `Total ${formatUsdc(offer.totalMinor)} USDC is above the ${mandate.maxPerTx} USDC per-payment limit`,
      hint: "Buy fewer units, pick a cheaper offer, or ask the human to raise maxPerTx.",
      details: { total: offer.totalMinor.toString(), maxPerTx: maxPerTx.toString() },
    });
  }
  const maxTotal = usdc(mandate.maxTotal);
  const projected = addUsdc(context.spentInPeriod, offer.totalMinor);
  if (compareUsdc(projected, maxTotal) > 0) {
    blocks.push({
      reason: "period_budget",
      code: "MANDATE_EXCEEDED",
      message: `Paying it would exceed the ${mandate.maxTotal} USDC limit for this ${mandate.period} (${formatUsdc(context.spentInPeriod)} USDC already committed)`,
      hint: "Wait for the next period, spend less, or ask the human to raise maxTotal.",
      details: {
        spentInPeriod: context.spentInPeriod.toString(),
        total: offer.totalMinor.toString(),
        maxTotal: maxTotal.toString(),
        period: mandate.period,
      },
    });
  }
  if (offer.physical && !mandate.allowPhysicalGoods) {
    blocks.push({
      reason: "physical_not_allowed",
      code: "MANDATE_EXCEEDED",
      message: "This is a physical good and the mandate does not allow physical goods",
      hint: "Ask the human to set allowPhysicalGoods (with a shipping address), or pick a digital item.",
      details: {},
    });
  }
  if (Array.isArray(mandate.allowedSellers) && !mandate.allowedSellers.includes(offer.host)) {
    blocks.push({
      reason: "seller_not_allowed",
      code: "SELLER_UNVERIFIED",
      message: `${offer.host} is not in the mandate allowlist`,
      hint: `Ask the human to add ${offer.host} to allowedSellers, or to set it to "any".`,
      details: { siteHost: offer.host, allowedSellers: mandate.allowedSellers },
    });
  }
  const needsApproval =
    mandate.requireConfirmAboveUsdc !== undefined &&
    compareUsdc(offer.totalMinor, usdc(mandate.requireConfirmAboveUsdc)) > 0;
  return { payable: blocks.length === 0, needsApproval, blocks };
}

/** One catalog item, turned into an offer that can be compared with any other store's. */
export function toOffer(
  item: SiteItem,
  store: { name: string; url: string; host: string },
  request: { attributes?: Record<string, string> | undefined; quantity: number },
  context: MandateContext,
): MarketOffer {
  const unit = usdcFromMinor(item.price.minor);
  const total = mulUsdc(unit, request.quantity);
  return {
    store,
    itemId: item.id,
    title: item.title,
    url: item.url,
    matchedAttributes: matchedAttributes(item, request.attributes),
    attributes: item.attributes,
    quantity: request.quantity,
    unitPriceMinor: unit.toString(),
    unitPrice: formatUsdc(unit),
    totalMinor: total.toString(),
    totalUsdc: formatUsdc(total),
    asset: item.price.asset,
    physical: item.physical,
    stock: stockSignal(item),
    mandate: annotateMandate(context, {
      totalMinor: total,
      host: store.host,
      physical: item.physical,
    }),
  };
}

/** Cheapest total first; ties by store name, then title, then item id, so the order is stable. */
export function sortOffers(offers: MarketOffer[]): MarketOffer[] {
  return [...offers].sort((a, b) => {
    const at = BigInt(a.totalMinor);
    const bt = BigInt(b.totalMinor);
    if (at !== bt) return at < bt ? -1 : 1;
    return (
      a.store.name.localeCompare(b.store.name) ||
      a.title.localeCompare(b.title) ||
      a.itemId.localeCompare(b.itemId)
    );
  });
}

// --- terminal rendering ------------------------------------------------------

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

function padStart(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padStart(width);
}

function attributesLabel(offer: MarketOffer): string {
  const source =
    Object.keys(offer.matchedAttributes).length > 0 ? offer.matchedAttributes : offer.attributes;
  return Object.entries(source)
    .map(([name, value]) => `${name}=${value}`)
    .join(" ");
}

const STATE_LABEL: Record<MarketStoreState, string> = {
  ok: "ok",
  timeout: "timeout",
  error: "error",
  "unsupported-filters": "unsupported-filters",
  "not-allowed": "not-allowed",
};

/** Why an offer cannot be paid, in one short cell. */
export function payableLabel(offer: MarketOffer): string {
  if (offer.mandate.payable) {
    return offer.mandate.needsApproval ? "yes (needs approval)" : "yes";
  }
  return `no (${offer.mandate.blocks.map((b) => b.reason).join(", ")})`;
}

/**
 * The market call as a terminal table: one row per offer, then one line per store. Pure text,
 * no colors, so it can be asserted on in a test and piped anywhere.
 */
export function formatMarketTable(result: MarketCallResult): string {
  const lines: string[] = [];
  const header = [
    pad("STORE", 18),
    pad("TITLE", 26),
    pad("ATTRIBUTES", 24),
    padStart("UNIT", 9),
    padStart("TOTAL", 9),
    "PAYABLE",
  ].join("  ");
  if (result.offers.length === 0) {
    lines.push(`No offers for "${result.query.what}".`);
  } else {
    lines.push(header);
    for (const offer of result.offers) {
      lines.push(
        [
          pad(offer.store.name, 18),
          pad(offer.title, 26),
          pad(attributesLabel(offer), 24),
          padStart(offer.unitPrice, 9),
          padStart(offer.totalUsdc, 9),
          payableLabel(offer),
        ].join("  "),
      );
      for (const block of offer.mandate.blocks) lines.push(`${" ".repeat(20)}${block.message}`);
    }
    lines.push("");
    lines.push(
      `${String(result.offers.length)} offer(s) for ${String(result.query.quantity)} unit(s), cheapest total first. Prices in USDC.`,
    );
  }
  lines.push("");
  lines.push("Stores");
  for (const store of result.stores) {
    const detail = store.error
      ? ` ${store.error.code}: ${store.error.message}`
      : store.truncated
        ? ` (${String(store.offers)} of ${String(store.total ?? store.offers)} read)`
        : "";
    lines.push(
      `  ${pad(STATE_LABEL[store.state], 20)} ${pad(store.name, 18)} ${String(store.offers)} offer(s) ${store.url}${detail}`,
    );
  }
  const facets = Object.entries(result.facets);
  if (facets.length > 0) {
    lines.push("");
    lines.push("Refine with");
    for (const [name, values] of facets) {
      lines.push(`  ${name}: ${values.map((v) => `${v.value} (${String(v.count)})`).join(", ")}`);
    }
  }
  return lines.join("\n");
}
