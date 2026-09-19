/**
 * HTTP client for AgentPOS sites (and, later, any UCP/ACP/x402 site through the adapter).
 */
import { AgentPOSError, formatUsdc, usdcFromMinor } from "@agentpos/core";
import type { Address, BuyerContact, CartLine, UsdcMinor } from "@agentpos/core";

export interface SiteInfo {
  url: string;
  host: string;
  name: string;
  network: string;
  asset: string;
  basePath: string;
  manifest: unknown;
}

export interface SiteItem {
  id: string;
  title: string;
  description: string;
  url: string;
  price: { amount: string; asset: string; minor: string };
  physical: boolean;
  attributes: Record<string, string>;
  /** `tracked` when the merchant counts this item; absent on stores older than stock tracking. */
  stockMode?: "tracked" | "untracked";
}

/**
 * A structured catalog request, as `packages/site` accepts it over HTTP. Money is already in
 * minor units here (guardrail 4): decimals are parsed once, by whoever built the request.
 */
export interface CatalogQuery {
  q?: string | undefined;
  /** Attribute name -> value. Exact match on the value, forgiving on case and accents. */
  attributes?: Record<string, string> | undefined;
  minPriceUsdc?: UsdcMinor | undefined;
  maxPriceUsdc?: UsdcMinor | undefined;
  physical?: boolean | undefined;
  inStock?: boolean | undefined;
  /** Page size asked of the store. Paging is followed for you, up to `CATALOG_MAX_PAGES`. */
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface SiteFacetValue {
  value: string;
  count: number;
}

/** Attribute name -> the values it can take among the matching items, with their counts. */
export type SiteFacets = Record<string, SiteFacetValue[]>;

export interface SiteCatalogPage {
  items: SiteItem[];
  facets: SiteFacets;
  page: { limit: number; offset: number; returned: number; total: number };
  /** Display name as the store reports it, when it does. */
  siteName?: string;
  /**
   * The store refused the structured filters (4xx) and was asked again with the plain `q` call
   * every AgentPOS store has always answered; the filtering below was then done here. Older
   * stores stay in the results instead of vanishing from them.
   */
  degraded: boolean;
  /** `page.total` is larger than what fits in `CATALOG_MAX_PAGES` pages: the rest was not read. */
  truncated: boolean;
}

/** Page size the buyer asks a store for when the caller does not pick one. */
export const CATALOG_PAGE_LIMIT = 100;
/** Pages followed per store. A hard cap: one big catalog must not stall a whole market call. */
export const CATALOG_MAX_PAGES = 5;
/** Values kept per merged facet, mirroring what a store returns. */
export const CATALOG_MAX_FACET_VALUES = 25;

/** Combining marks, i.e. what NFD splits an accented letter into. Escaped, never literal. */
const COMBINING_MARKS = /\p{M}/gu;

/**
 * Comparison form for attribute names and values: diacritics removed and case folded, so
 * `Tamaño` and `tamano` are the same token. Same rule `packages/site` applies on its side;
 * the buyer needs it to compare offers across stores, and to filter a degraded store itself.
 */
export function normalizeTerm(value: string): string {
  return value.normalize("NFD").replace(COMBINING_MARKS, "").trim().toLowerCase();
}

export interface SiteCart {
  cartId: string;
  expiresAt: string;
  checkout: string;
  /** Merchant policy outcome (M1): `requires_approval` carts cannot be paid until a human approves. */
  policy?: { decision: "allowed" | "requires_approval"; code?: string; message?: string };
  quote: {
    total: string;
    totalMinor: string;
    asset: string;
    network: string;
    payTo: string;
    requiresShipping: boolean;
    lines: Array<{ itemId: string; title: string; quantity: number; physical: boolean }>;
  };
}

export interface SiteOrder {
  orderId: string;
  status: string;
  total: string;
  payment?: { txHash: string; network: string; asset: string; amountMinor: string; payer?: string };
  externalOrderId?: string;
  externalAdminUrl?: string;
  connectorError?: { code: string; message: string; hint: string };
}

type FetchLike = typeof globalThis.fetch;

async function readJson(res: Response, what: string): Promise<Record<string, unknown>> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = body.error as
      | { code?: string; message?: string; hint?: string; details?: Record<string, unknown> }
      | undefined;
    const code = err?.code;
    const known = [
      "CART_EXPIRED",
      "CART_NOT_FOUND",
      "OUT_OF_STOCK",
      "ITEM_NOT_FOUND",
      "SHIPPING_REQUIRED",
      "ORDER_NOT_FOUND",
    ] as const;
    throw new AgentPOSError(
      known.find((k) => k === code) ?? "SITE_UNREACHABLE",
      err?.message ?? `${what} failed (${res.status})`,
      {
        hint: err?.hint ?? "The site answered with an error; see details.",
        retryable: res.status >= 500,
        details: { status: res.status, ...(err?.details ?? {}) },
      },
    );
  }
  return body;
}

/**
 * A refusal that means "I do not understand this request" (4xx), as opposed to "I am broken"
 * (5xx) or "I am unreachable". Only the first kind is worth retrying without the new filters.
 */
function isClientRefusal(err: unknown): boolean {
  if (!(err instanceof AgentPOSError)) return false;
  const status = err.details?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}

function catalogQueryString(query: CatalogQuery, limit: number, offset: number): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  for (const [name, value] of Object.entries(query.attributes ?? {})) {
    params.append(`attr.${name}`, value);
  }
  if (query.minPriceUsdc !== undefined) params.set("minPriceUsdc", formatUsdc(query.minPriceUsdc));
  if (query.maxPriceUsdc !== undefined) params.set("maxPriceUsdc", formatUsdc(query.maxPriceUsdc));
  if (query.physical !== undefined) params.set("physical", String(query.physical));
  if (query.inStock !== undefined) params.set("inStock", String(query.inStock));
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return params.toString();
}

function readFacets(raw: unknown): SiteFacets {
  if (typeof raw !== "object" || raw === null) return {};
  const facets: SiteFacets = {};
  for (const [name, values] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(values)) continue;
    const kept: SiteFacetValue[] = [];
    for (const entry of values) {
      const value = (entry as { value?: unknown }).value;
      const count = (entry as { count?: unknown }).count;
      if (typeof value === "string" && typeof count === "number") kept.push({ value, count });
    }
    if (kept.length > 0) facets[name] = kept;
  }
  return facets;
}

/**
 * Stock as the item itself reports it, with no extra call to the store. `unknown` is said out
 * loud rather than guessed: an item the merchant tracks without leaving a readable signal is
 * not the same as one that is certainly on the shelf.
 */
export function stockSignal(item: SiteItem): "in_stock" | "out_of_stock" | "unknown" {
  if (item.stockMode !== "tracked") return "in_stock";
  const attrs = new Map<string, string>();
  for (const [name, value] of Object.entries(item.attributes)) {
    attrs.set(normalizeTerm(name).replace(/[\s-]+/g, "_"), normalizeTerm(value));
  }
  const status = attrs.get("stock_status") ?? attrs.get("stockstatus");
  if (status !== undefined) {
    return status === "instock" || status === "onbackorder" ? "in_stock" : "out_of_stock";
  }
  const flag =
    attrs.get("in_stock") ?? attrs.get("instock") ?? attrs.get("stock") ?? attrs.get("available");
  if (flag !== undefined) {
    return flag === "false" || flag === "no" || flag === "0" || flag === "outofstock"
      ? "out_of_stock"
      : "in_stock";
  }
  const quantity = attrs.get("stock_quantity") ?? attrs.get("stockquantity");
  if (quantity !== undefined && /^-?\d+$/.test(quantity)) {
    return Number(quantity) > 0 ? "in_stock" : "out_of_stock";
  }
  return "unknown";
}

/** Every filter of the request EXCEPT the attribute ones, applied here. */
function matchesNonAttributeFilters(item: SiteItem, query: CatalogQuery): boolean {
  if (query.physical !== undefined && item.physical !== query.physical) return false;
  if (query.inStock !== undefined && (stockSignal(item) !== "out_of_stock") !== query.inStock) {
    return false;
  }
  if (query.minPriceUsdc !== undefined || query.maxPriceUsdc !== undefined) {
    // Integer comparison in minor units, never a float (guardrail 4). Both bounds inclusive.
    const price = BigInt(item.price.minor);
    if (query.minPriceUsdc !== undefined && price < query.minPriceUsdc) return false;
    if (query.maxPriceUsdc !== undefined && price > query.maxPriceUsdc) return false;
  }
  return true;
}

/** Whether the item carries every requested attribute, comparing both sides normalized. */
export function matchesAttributes(
  item: SiteItem,
  attributes: Record<string, string> | undefined,
): boolean {
  const filters = Object.entries(attributes ?? {});
  if (filters.length === 0) return true;
  const own = Object.entries(item.attributes).map(([name, value]) => ({
    name: normalizeTerm(name),
    value: normalizeTerm(value),
  }));
  return filters.every(([name, value]) => {
    const n = normalizeTerm(name);
    const v = normalizeTerm(value);
    return own.some((a) => a.name === n && a.value === v);
  });
}

function facetsFromItems(items: SiteItem[]): SiteFacets {
  const byName = new Map<string, { name: string; values: Map<string, SiteFacetValue> }>();
  for (const item of items) {
    for (const [name, value] of Object.entries(item.attributes)) {
      const key = normalizeTerm(name);
      let facet = byName.get(key);
      if (!facet) {
        facet = { name, values: new Map() };
        byName.set(key, facet);
      }
      const valueKey = normalizeTerm(value);
      const existing = facet.values.get(valueKey);
      if (existing) existing.count += 1;
      else facet.values.set(valueKey, { value, count: 1 });
    }
  }
  const facets: SiteFacets = {};
  for (const key of [...byName.keys()].sort()) {
    const facet = byName.get(key) as { name: string; values: Map<string, SiteFacetValue> };
    facets[facet.name] = [...facet.values.values()]
      .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
      .slice(0, CATALOG_MAX_FACET_VALUES);
  }
  return facets;
}

export class SiteClient {
  private readonly base: string;
  readonly host: string;
  constructor(
    siteUrl: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    readonly basePath = "/agentpos",
  ) {
    const u = new URL(siteUrl);
    this.base = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
    this.host = u.host;
  }

  get url(): string {
    return this.base;
  }

  private async get(path: string, what: string): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      throw new AgentPOSError("SITE_UNREACHABLE", `Cannot reach ${this.base}`, {
        hint: "Check the site URL and that its AgentPOS sidecar is running.",
        retryable: true,
        cause,
      });
    }
    return readJson(res, what);
  }

  async info(): Promise<SiteInfo> {
    const manifest = await this.get("/.well-known/ucp", "manifest");
    // /health answers 503 when the site's facilitator is down or orders are stuck; the body is
    // still informative, so read it leniently and let the mandate/network checks decide.
    let health: Record<string, unknown> = {};
    try {
      const res = await this.fetchImpl(`${this.base}${this.basePath}/health`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      health = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      /* health unreachable: keep defaults */
    }
    return {
      url: this.base,
      host: this.host,
      name: String(health.name ?? this.host),
      network: String(health.network ?? "unknown"),
      asset: String(health.asset ?? "USDC"),
      basePath: this.basePath,
      manifest,
    };
  }

  async search(query: string): Promise<SiteItem[]> {
    const body = await this.get(
      `${this.basePath}/catalog${query ? `?q=${encodeURIComponent(query)}` : ""}`,
      "catalog",
    );
    return (body.items as SiteItem[]) ?? [];
  }

  /**
   * Structured catalog read: attributes, price bounds, physical and stock, with `facets` and
   * `page` alongside the items. Paging is followed for the caller up to `CATALOG_MAX_PAGES`,
   * and a store that answers 4xx to the new parameters is asked again with the plain `q` call
   * and filtered here (`degraded: true`), so a store written before structured search still
   * takes part in a market call instead of disappearing from it.
   */
  async catalog(query: CatalogQuery = {}): Promise<SiteCatalogPage> {
    try {
      return await this.catalogPages(query, false);
    } catch (err) {
      if (!isClientRefusal(err)) throw err;
      const plain = await this.catalogPages(query.q ? { q: query.q } : {}, true);
      return this.filterLocally(plain, query);
    }
  }

  /** Reads one page after another until the store's `page.total` is covered, or the cap is. */
  private async catalogPages(query: CatalogQuery, plain: boolean): Promise<SiteCatalogPage> {
    const limit = query.limit ?? CATALOG_PAGE_LIMIT;
    const start = query.offset ?? 0;
    const items: SiteItem[] = [];
    let facets: SiteFacets = {};
    let siteName: string | undefined;
    let total = 0;
    let truncated = false;
    let pages = 0;
    for (;;) {
      const suffix = plain
        ? query.q
          ? `?q=${encodeURIComponent(query.q)}`
          : ""
        : `?${catalogQueryString(query, limit, start + items.length)}`;
      const body = await this.get(`${this.basePath}/catalog${suffix}`, "catalog");
      pages += 1;
      const got = ((body.items as SiteItem[] | undefined) ?? []).filter(
        (i) => typeof i?.id === "string",
      );
      items.push(...got);
      // Facets and the store name describe the whole request, so the first page is the truth.
      if (pages === 1) {
        facets = readFacets(body.facets);
        const site = body.site as { name?: unknown } | undefined;
        if (typeof site?.name === "string") siteName = site.name;
      }
      const page = body.page as { total?: unknown } | undefined;
      total = typeof page?.total === "number" ? page.total : items.length;
      // No `page` block means a store that does not page at all: what came back is everything.
      if (page === undefined || got.length === 0 || items.length >= total) break;
      if (pages >= CATALOG_MAX_PAGES) {
        truncated = true;
        break;
      }
    }
    return {
      items,
      facets,
      page: { limit, offset: start, returned: items.length, total: Math.max(total, items.length) },
      ...(siteName !== undefined ? { siteName } : {}),
      degraded: false,
      truncated,
    };
  }

  /**
   * What the store would have done with the filters it refused. Facets are counted BEFORE the
   * attribute filters, exactly as a current store counts them, so the sibling options of the
   * facet being filtered on stay visible.
   */
  private filterLocally(plain: SiteCatalogPage, query: CatalogQuery): SiteCatalogPage {
    const scoped = plain.items.filter((i) => matchesNonAttributeFilters(i, query));
    const matched = scoped.filter((i) => matchesAttributes(i, query.attributes));
    const limit = query.limit ?? CATALOG_PAGE_LIMIT;
    const offset = query.offset ?? 0;
    const items = matched.slice(offset, offset + limit);
    return {
      items,
      facets: facetsFromItems(scoped),
      page: { limit, offset, returned: items.length, total: matched.length },
      ...(plain.siteName !== undefined ? { siteName: plain.siteName } : {}),
      degraded: true,
      truncated: plain.truncated,
    };
  }

  async item(id: string): Promise<SiteItem> {
    return (await this.get(
      `${this.basePath}/items/${encodeURIComponent(id)}`,
      "item",
    )) as unknown as SiteItem;
  }

  async createCart(items: CartLine[], buyer?: BuyerContact, shipping?: Address): Promise<SiteCart> {
    const res = await this.fetchImpl(`${this.base}${this.basePath}/cart`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        items,
        ...(buyer ? { buyer } : {}),
        ...(shipping ? { shipping } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    return (await readJson(res, "cart")) as unknown as SiteCart;
  }

  async order(orderId: string): Promise<SiteOrder> {
    return (await this.get(
      `${this.basePath}/orders/${encodeURIComponent(orderId)}`,
      "order",
    )) as unknown as SiteOrder;
  }

  async waitForOrder(orderId: string, timeoutMs = 15_000): Promise<SiteOrder> {
    const deadline = Date.now() + timeoutMs;
    let last = await this.order(orderId);
    while (!last.externalOrderId && !last.connectorError && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      last = await this.order(orderId);
    }
    return last;
  }
}

export function cartTotalMinor(cart: SiteCart): UsdcMinor {
  return usdcFromMinor(cart.quote.totalMinor);
}
