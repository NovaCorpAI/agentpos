/**
 * Structured-data extraction from a single HTML page: JSON-LD schema.org Product/Offer first,
 * then Open Graph product tags. Every field carries evidence (locator) so nothing is invented.
 */
import * as cheerio from "cheerio";
import type { CatalogItemDraft, Evidence } from "@agentpos/core";
import { slugify } from "@agentpos/core";

interface JsonLdOffer {
  price?: string | number;
  priceCurrency?: string;
  availability?: string;
  url?: string;
}

interface JsonLdProduct {
  "@type"?: string | string[];
  name?: string;
  description?: string;
  image?: string | string[] | { url?: string } | Array<{ url?: string }>;
  sku?: string;
  brand?: { name?: string } | string;
  url?: string;
  offers?: JsonLdOffer | JsonLdOffer[];
  [key: string]: unknown;
}

function typeIncludes(node: JsonLdProduct, wanted: string): boolean {
  const t = node["@type"];
  return Array.isArray(t) ? t.includes(wanted) : t === wanted;
}

function* walkJsonLd(node: unknown): Generator<JsonLdProduct> {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) yield* walkJsonLd(n);
    return;
  }
  const obj = node as JsonLdProduct;
  if (typeIncludes(obj, "Product") || typeIncludes(obj, "Service")) yield obj;
  const graph = (obj as { "@graph"?: unknown })["@graph"];
  if (graph) yield* walkJsonLd(graph);
  for (const key of ["mainEntity", "itemListElement", "item"]) {
    if (key in obj) yield* walkJsonLd(obj[key]);
  }
}

function firstImage(image: JsonLdProduct["image"]): string | undefined {
  if (!image) return undefined;
  if (typeof image === "string") return image;
  if (Array.isArray(image)) {
    const first = image[0];
    return typeof first === "string" ? first : first?.url;
  }
  return image.url;
}

export interface ExtractedPage {
  drafts: CatalogItemDraft[];
  /** Page title / visible text used later by the LLM redaction step. */
  title: string | undefined;
  textSnippet: string;
}

export function extractFromHtml(html: string, pageUrl: string): ExtractedPage {
  const $ = cheerio.load(html);
  const drafts: CatalogItemDraft[] = [];
  const pageTitle = $("title").first().text().trim() || undefined;

  $('script[type="application/ld+json"]').each((index, el) => {
    const raw = $(el).text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    for (const product of walkJsonLd(parsed)) {
      if (!product.name) continue;
      const locator = `script[type=application/ld+json][${index}]`;
      const evidence: Evidence[] = [{ source: pageUrl, locator }];
      const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
      const attributes: Record<string, string> = {};
      if (product.sku) attributes.sku = String(product.sku);
      const brand = typeof product.brand === "string" ? product.brand : product.brand?.name;
      if (brand) attributes.brand = brand;
      for (const key of ["color", "material", "size", "weight", "width", "height", "depth"]) {
        const value = product[key];
        if (typeof value === "string" || typeof value === "number") attributes[key] = String(value);
      }
      const price =
        offers?.price !== undefined && offers.priceCurrency
          ? { amount: String(offers.price), currency: String(offers.priceCurrency).toUpperCase() }
          : undefined;
      const url = product.url ?? offers?.url ?? pageUrl;
      const image = firstImage(product.image);
      const inStock = offers?.availability
        ? /InStock|PreOrder|LimitedAvailability/i.test(offers.availability)
        : true;
      drafts.push({
        id: slugify(product.sku ? `${product.name}-${product.sku}` : product.name),
        type: typeIncludes(product, "Service") ? "service" : "product",
        title: product.name.trim(),
        descriptionAgent: (product.description ?? "").replace(/\s+/g, " ").trim(),
        url,
        ...(image ? { imageUrl: image } : {}),
        attributes,
        ...(price ? { priceSrc: price } : {}),
        stockMode: "untracked",
        physical: !typeIncludes(product, "Service"),
        sourceEvidence: evidence,
        confidence: price ? 0.85 : 0.6,
        ...(inStock ? {} : { attributes: { ...attributes, availability: "out_of_stock" } }),
      });
    }
  });

  // Open Graph product fallback (single product per page).
  if (drafts.length === 0 && $('meta[property="og:type"]').attr("content")?.startsWith("product")) {
    const title = $('meta[property="og:title"]').attr("content")?.trim();
    const amount = $(
      'meta[property="product:price:amount"], meta[property="og:price:amount"]',
    ).attr("content");
    const currency = $(
      'meta[property="product:price:currency"], meta[property="og:price:currency"]',
    ).attr("content");
    if (title) {
      drafts.push({
        id: slugify(title),
        type: "product",
        title,
        descriptionAgent: ($('meta[property="og:description"]').attr("content") ?? "").trim(),
        url: $('meta[property="og:url"]').attr("content") ?? pageUrl,
        ...($('meta[property="og:image"]').attr("content")
          ? { imageUrl: $('meta[property="og:image"]').attr("content") as string }
          : {}),
        attributes: {},
        ...(amount && currency ? { priceSrc: { amount, currency: currency.toUpperCase() } } : {}),
        stockMode: "untracked",
        physical: true,
        sourceEvidence: [{ source: pageUrl, locator: "meta[property^=og:|product:]" }],
        confidence: amount ? 0.6 : 0.4,
      });
    }
  }

  const textSnippet = $("main, article, body")
    .first()
    .text()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
  return { drafts, title: pageTitle, textSnippet };
}
