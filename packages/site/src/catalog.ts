import type { CatalogItem, CatalogItemDraft, UsdcMinor } from "@agentpos/core";
import { AgentPOSError, MIN_PRICE_USDC, compareUsdc, usdc } from "@agentpos/core";
import type { SiteStorage } from "./storage.js";

/**
 * Page size when the caller does not ask for one. Deliberately large: agents written before
 * paging existed read `/catalog` once and buy from what they get, so a small default would
 * silently hide the rest of the catalog from them. `page.total` always tells the truth, and a
 * caller that wants small pages asks for them.
 */
export const CATALOG_DEFAULT_LIMIT = 200;
/** Hard ceiling on a page: a catalog read must stay a cheap call for the store. */
export const CATALOG_MAX_LIMIT = 500;
/** Values kept per facet. Enough to enumerate a real option list, not enough to dump a catalog. */
export const CATALOG_MAX_FACET_VALUES = 25;
/** Longest free-text query accepted; the rest is truncated rather than refused. */
export const CATALOG_MAX_QUERY_CHARS = 200;
/** Attribute filters accepted in one request, and the longest name/value each may carry. */
export const CATALOG_MAX_ATTRIBUTE_FILTERS = 20;
export const CATALOG_MAX_ATTRIBUTE_CHARS = 120;
/** Query-string prefix for a structured attribute filter: `attr.Passepartout=con`. */
export const CATALOG_ATTRIBUTE_PREFIX = "attr.";

/** Combining marks, i.e. what NFD splits an accented letter into. Escaped, never literal: an
 *  invisible character in source is one bad editor away from breaking silently. */
const COMBINING_MARKS = /\p{M}/gu;

/**
 * Comparison form for attribute names, attribute values and free text: diacritics removed and
 * case folded, so `Tamaño` / `tamano` and `Café` / `cafe` are the same token. Spanish catalogs
 * are written with accents and agents rarely reproduce them.
 */
export function normalizeTerm(value: string): string {
  return value.normalize("NFD").replace(COMBINING_MARKS, "").trim().toLowerCase();
}

/**
 * Stock as the PUBLISHED catalog knows it, without calling the merchant's platform (a catalog
 * read must not fan out to Woo/Shopify). `untracked` means the merchant never asked us to count
 * this item, so it is always in stock. For `tracked` items we read the conventional attributes a
 * connector leaves behind; with none of them present the item counts as in stock, because
 * "unknown" must not hide something the merchant is actually selling. Live, per-quantity
 * availability is still checked at cart time by the connector.
 */
export function isInStock(item: CatalogItem): boolean {
  if (item.stockMode !== "tracked") return true;
  const attrs = new Map<string, string>();
  for (const [name, value] of Object.entries(item.attributes)) {
    attrs.set(normalizeTerm(name).replace(/[\s-]+/g, "_"), normalizeTerm(value));
  }
  const status = attrs.get("stock_status") ?? attrs.get("stockstatus");
  if (status !== undefined) return status === "instock" || status === "onbackorder";
  const flag =
    attrs.get("in_stock") ?? attrs.get("instock") ?? attrs.get("stock") ?? attrs.get("available");
  if (flag !== undefined)
    return !(flag === "false" || flag === "no" || flag === "0" || flag === "outofstock");
  const quantity = attrs.get("stock_quantity") ?? attrs.get("stockquantity");
  if (quantity !== undefined && /^-?\d+$/.test(quantity)) return Number(quantity) > 0;
  return true;
}

/**
 * A structured catalog request. Every field is optional and they all AND together. Money is
 * already in minor units here (guardrail 4): decimal parsing happens once, at the edge, in
 * `parseCatalogQuery` / `parsePriceBound`.
 */
export interface CatalogQuery {
  /** Free text over title, description and attribute values. */
  q?: string | undefined;
  /** Attribute name -> value. Matched exactly, case- and accent-insensitively, on both sides. */
  attributes?: Record<string, string> | undefined;
  minPriceUsdc?: UsdcMinor | undefined;
  maxPriceUsdc?: UsdcMinor | undefined;
  physical?: boolean | undefined;
  inStock?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface CatalogFacetValue {
  /** The value as the catalog spells it (first occurrence wins when only accents differ). */
  value: string;
  count: number;
}

/**
 * Distinct values per attribute name, so an agent can learn that `Passepartout` is `con` or
 * `sin` without a human explaining it. Counted over everything that matches the request EXCEPT
 * its attribute filters, which is what makes the other options of the same facet visible.
 */
export type CatalogFacets = Record<string, CatalogFacetValue[]>;

export interface CatalogSearchResult {
  /** The requested page. */
  items: CatalogItem[];
  /** Items matching the whole request (attribute filters included), before paging. */
  total: number;
  limit: number;
  offset: number;
  facets: CatalogFacets;
}

/** Attribute of one item in both spellings: as written, and in comparison form. */
interface NormalizedAttribute {
  name: string;
  normalizedName: string;
  value: string;
  normalizedValue: string;
}

interface ScopedItem {
  item: CatalogItem;
  score: number;
  attributes: NormalizedAttribute[];
}

const USDC_DECIMAL = /^\d+(\.\d{1,7})?$/;

function invalid(message: string, hint: string, details?: Record<string, unknown>): AgentPOSError {
  return new AgentPOSError("CONFIG_INVALID", message, {
    hint,
    retryable: false,
    ...(details ? { details } : {}),
  });
}

/** Decimal USDC string -> minor units. Never a float, and never a silent 0 for garbage input. */
export function parsePriceBound(raw: string, field: "minPriceUsdc" | "maxPriceUsdc"): UsdcMinor {
  const text = raw.trim();
  if (!USDC_DECIMAL.test(text)) {
    throw invalid(
      `Invalid ${field} '${raw.slice(0, 32)}'`,
      `${field} is a non-negative decimal USDC amount with at most 7 decimals, e.g. ${field}=40 or ${field}=39.99.`,
      { field, value: raw.slice(0, 32) },
    );
  }
  return usdc(text);
}

function parseBoolean(raw: string, field: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw invalid(`Invalid ${field} '${raw.slice(0, 32)}'`, `${field}=true or ${field}=false.`, {
    field,
    value: raw.slice(0, 32),
  });
}

function parseCount(raw: string, field: string, min: number, max: number): number {
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalid(
      `Invalid ${field} '${raw.slice(0, 32)}'`,
      `${field} is an integer between ${min} and ${max}.`,
      { field, value: raw.slice(0, 32) },
    );
  }
  return value;
}

/**
 * Query string -> CatalogQuery. Unknown parameters are ignored (an agent probing the surface must
 * not be punished for it); malformed KNOWN parameters are refused with a typed CONFIG_INVALID so
 * the agent can fix the call instead of silently reading the wrong catalog.
 */
export function parseCatalogQuery(params: URLSearchParams): CatalogQuery {
  const attributes: Record<string, string> = {};
  let attributeCount = 0;
  for (const [rawKey, rawValue] of params) {
    if (!rawKey.startsWith(CATALOG_ATTRIBUTE_PREFIX)) continue;
    const name = rawKey.slice(CATALOG_ATTRIBUTE_PREFIX.length).trim();
    const value = rawValue.trim();
    if (name === "" || value === "") {
      throw invalid(
        `Invalid attribute filter '${rawKey.slice(0, 48)}'`,
        `Use attr.<name>=<value> with both sides non-empty, e.g. attr.Passepartout=con. Repeat it for another attribute.`,
        { parameter: rawKey.slice(0, 48) },
      );
    }
    if (name.length > CATALOG_MAX_ATTRIBUTE_CHARS || value.length > CATALOG_MAX_ATTRIBUTE_CHARS) {
      throw invalid(
        `Attribute filter '${name.slice(0, 32)}' is too long`,
        `Attribute names and values are at most ${CATALOG_MAX_ATTRIBUTE_CHARS} characters.`,
      );
    }
    // A repeated name keeps the last value: one attribute filter means one exact value.
    if (!(name in attributes)) attributeCount += 1;
    if (attributeCount > CATALOG_MAX_ATTRIBUTE_FILTERS) {
      throw invalid(
        "Too many attribute filters",
        `Send at most ${CATALOG_MAX_ATTRIBUTE_FILTERS} attr.<name>=<value> filters in one request.`,
      );
    }
    attributes[name] = value;
  }

  const q = params.get("q");
  const minRaw = params.get("minPriceUsdc");
  const maxRaw = params.get("maxPriceUsdc");
  const physicalRaw = params.get("physical");
  const inStockRaw = params.get("inStock");
  const limitRaw = params.get("limit");
  const offsetRaw = params.get("offset");

  const query: CatalogQuery = {
    ...(q ? { q: q.slice(0, CATALOG_MAX_QUERY_CHARS) } : {}),
    ...(attributeCount > 0 ? { attributes } : {}),
    ...(minRaw !== null ? { minPriceUsdc: parsePriceBound(minRaw, "minPriceUsdc") } : {}),
    ...(maxRaw !== null ? { maxPriceUsdc: parsePriceBound(maxRaw, "maxPriceUsdc") } : {}),
    ...(physicalRaw !== null ? { physical: parseBoolean(physicalRaw, "physical") } : {}),
    ...(inStockRaw !== null ? { inStock: parseBoolean(inStockRaw, "inStock") } : {}),
    ...(limitRaw !== null ? { limit: parseCount(limitRaw, "limit", 1, CATALOG_MAX_LIMIT) } : {}),
    ...(offsetRaw !== null
      ? { offset: parseCount(offsetRaw, "offset", 0, Number.MAX_SAFE_INTEGER) }
      : {}),
  };
  assertPriceRange(query);
  return query;
}

/** An inverted range asks for nothing; say so instead of answering an empty catalog. */
export function assertPriceRange(query: CatalogQuery): void {
  const { minPriceUsdc, maxPriceUsdc } = query;
  if (minPriceUsdc !== undefined && maxPriceUsdc !== undefined && minPriceUsdc > maxPriceUsdc) {
    throw invalid(
      "minPriceUsdc is greater than maxPriceUsdc",
      "Use minPriceUsdc <= maxPriceUsdc, both decimal USDC amounts.",
      { minPriceUsdc: minPriceUsdc.toString(), maxPriceUsdc: maxPriceUsdc.toString() },
    );
  }
}

function normalizeAttributes(item: CatalogItem): NormalizedAttribute[] {
  return Object.entries(item.attributes).map(([name, value]) => ({
    name,
    normalizedName: normalizeTerm(name),
    value,
    normalizedValue: normalizeTerm(value),
  }));
}

function matchesAttributeFilters(
  attributes: NormalizedAttribute[],
  filters: Array<{ name: string; value: string }>,
): boolean {
  // Every filter must match some attribute of the item (AND). An unknown name matches nothing,
  // which is the honest answer: the store has no such option to offer.
  return filters.every((f) =>
    attributes.some((a) => a.normalizedName === f.name && a.normalizedValue === f.value),
  );
}

function buildFacets(scoped: ScopedItem[]): CatalogFacets {
  const byName = new Map<string, { name: string; values: Map<string, CatalogFacetValue> }>();
  for (const entry of scoped) {
    for (const attribute of entry.attributes) {
      let facet = byName.get(attribute.normalizedName);
      if (!facet) {
        facet = { name: attribute.name, values: new Map() };
        byName.set(attribute.normalizedName, facet);
      }
      const existing = facet.values.get(attribute.normalizedValue);
      if (existing) existing.count += 1;
      else facet.values.set(attribute.normalizedValue, { value: attribute.value, count: 1 });
    }
  }
  const facets: CatalogFacets = {};
  for (const key of [...byName.keys()].sort()) {
    const facet = byName.get(key) as { name: string; values: Map<string, CatalogFacetValue> };
    facets[facet.name] = [...facet.values.values()]
      .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
      .slice(0, CATALOG_MAX_FACET_VALUES);
  }
  return facets;
}

export class CatalogService {
  constructor(private readonly storage: SiteStorage) {}

  published(): CatalogItem[] {
    return this.storage.listItems("published");
  }

  getPublished(id: string): CatalogItem {
    const item = this.storage.getItem(id);
    if (!item) {
      throw new AgentPOSError("ITEM_NOT_FOUND", `Unknown item '${id}'`, {
        hint: "List items via GET /agentpos/catalog and use their `id`.",
        details: { id },
      });
    }
    if (item.status !== "published") {
      throw new AgentPOSError("ITEM_NOT_PUBLISHED", `Item '${id}' is not published`, {
        hint: "The merchant has not confirmed this item yet.",
        details: { id, status: item.status },
      });
    }
    return item;
  }

  /** Plain-text search over title, description and attributes. Kept for callers that only search. */
  search(query: string, limit = CATALOG_DEFAULT_LIMIT): CatalogItem[] {
    return this.query({ q: query, limit }).items;
  }

  /**
   * Structured, attribute-aware search over the published catalog.
   *
   * Variants live in the catalog as one item per option combination (a WooCommerce variation
   * becomes an item carrying its options in `attributes`), so a buying agent can ask for the
   * exact variant it wants instead of guessing from a text match.
   *
   * Reads the published catalog ONCE: the same scoped list feeds the facets and the page.
   * Facets are computed BEFORE the attribute filters are applied, which is what lets an agent
   * see the sibling options of the facet it is already filtering on.
   */
  query(input: CatalogQuery = {}): CatalogSearchResult {
    assertPriceRange(input);
    const limit = input.limit ?? CATALOG_DEFAULT_LIMIT;
    const offset = input.offset ?? 0;
    const terms = input.q ? normalizeTerm(input.q).split(/\s+/).filter(Boolean) : [];
    const filters = Object.entries(input.attributes ?? {}).map(([name, value]) => ({
      name: normalizeTerm(name),
      value: normalizeTerm(value),
    }));

    const scoped: ScopedItem[] = [];
    for (const item of this.published()) {
      if (input.physical !== undefined && item.physical !== input.physical) continue;
      if (input.inStock !== undefined && isInStock(item) !== input.inStock) continue;
      if (input.minPriceUsdc !== undefined || input.maxPriceUsdc !== undefined) {
        const price = item.priceUsdc;
        // Integer comparison in minor units, never a float (guardrail 4). Both bounds inclusive.
        if (price === undefined) continue;
        if (input.minPriceUsdc !== undefined && compareUsdc(price, input.minPriceUsdc) < 0)
          continue;
        if (input.maxPriceUsdc !== undefined && compareUsdc(price, input.maxPriceUsdc) > 0)
          continue;
      }
      const attributes = normalizeAttributes(item);
      let score = 0;
      if (terms.length > 0) {
        const haystack = normalizeTerm(
          `${item.title} ${item.descriptionAgent} ${attributes.map((a) => `${a.name} ${a.value}`).join(" ")}`,
        );
        for (const term of terms) if (haystack.includes(term)) score += 1;
        if (score === 0) continue;
      }
      scoped.push({ item, score, attributes });
    }

    const facets = buildFacets(scoped);
    const matched = scoped.filter((entry) => matchesAttributeFilters(entry.attributes, filters));
    if (terms.length > 0) {
      // Relevance first, then id: two items with the same score must always come back in the
      // same order, or paging would skip and repeat rows.
      matched.sort(
        (a, b) => b.score - a.score || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0),
      );
    }
    return {
      items: matched.slice(offset, offset + limit).map((entry) => entry.item),
      total: matched.length,
      limit,
      offset,
      facets,
    };
  }

  /** Human-confirmed draft -> confirmed item (guardrail 5). Price is always set by the human. */
  confirm(
    draft: CatalogItemDraft,
    priceUsdc: UsdcMinor,
    overrides: Partial<Pick<CatalogItem, "descriptionAgent" | "title" | "payTo">> = {},
  ): CatalogItem {
    if (compareUsdc(priceUsdc, MIN_PRICE_USDC) < 0) {
      throw new AgentPOSError("INVALID_AMOUNT", "Price below the minimum of 0.001 USDC", {
        hint: "Set a price of at least 0.001 USDC.",
        details: { id: draft.id },
      });
    }
    const { priceUsdcSuggested: _s, confidence: _c, ...rest } = draft;
    const item: CatalogItem = { ...rest, ...overrides, priceUsdc, status: "confirmed" };
    this.storage.upsertItem(item);
    this.storage.deleteDraft(draft.id);
    return item;
  }

  publishAll(): CatalogItem[] {
    const confirmed = this.storage.listItems("confirmed");
    for (const item of confirmed) this.storage.setItemStatus(item.id, "published");
    return this.storage.listItems("published");
  }

  unpublish(id: string): void {
    this.storage.setItemStatus(id, "confirmed");
  }
}
