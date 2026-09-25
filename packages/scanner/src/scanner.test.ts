import { describe, expect, it, vi } from "vitest";
import type { ConnectorProduct, OrderConnector } from "@agentpos/core";
import { extractFromHtml } from "./html.js";
import { scanSite, suggestUsdc } from "./scan.js";
import { SiteFetcher } from "./fetch.js";

const productPage = `<!doctype html><html><head><title>Mug | Shop</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Ceramic Mug 350ml","sku":"AG-MUG-350","description":"White ceramic mug, 350 ml.","image":["https://shop.test/mug.jpg"],"brand":{"name":"AG"},"offers":{"@type":"Offer","price":"9.90","priceCurrency":"USD","availability":"https://schema.org/InStock","url":"https://shop.test/product/mug/"}}</script>
</head><body><main>Ceramic mug 350 ml dishwasher safe</main></body></html>`;

const ogPage = `<html><head><meta property="og:type" content="product"><meta property="og:title" content="Sticker Pack"><meta property="og:description" content="10 vinyl stickers"><meta property="product:price:amount" content="3.00"><meta property="product:price:currency" content="EUR"></head><body></body></html>`;

const sitemap = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://shop.test/</loc></url><url><loc>https://shop.test/product/mug/</loc></url><url><loc>https://shop.test/product/stickers/</loc></url><url><loc>https://shop.test/private/secret/</loc></url><url><loc>https://other.test/product/x/</loc></url></urlset>`;

function siteFetch(pages: Record<string, string>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const body = pages[path];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200 });
  });
}

describe("extractFromHtml", () => {
  it("extracts schema.org Product with evidence and price", () => {
    const { drafts } = extractFromHtml(productPage, "https://shop.test/product/mug/");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      id: "ceramic-mug-350ml-ag-mug-350",
      title: "Ceramic Mug 350ml",
      priceSrc: { amount: "9.90", currency: "USD" },
      imageUrl: "https://shop.test/mug.jpg",
      attributes: { sku: "AG-MUG-350", brand: "AG" },
      physical: true,
    });
    expect(drafts[0]?.sourceEvidence[0]?.locator).toContain("ld+json");
  });

  it("falls back to Open Graph product tags", () => {
    const { drafts } = extractFromHtml(ogPage, "https://shop.test/product/stickers/");
    expect(drafts[0]).toMatchObject({
      title: "Sticker Pack",
      priceSrc: { amount: "3.00", currency: "EUR" },
      confidence: 0.6,
    });
  });

  it("never invents items from plain pages", () => {
    expect(
      extractFromHtml("<html><body><h1>About us</h1></body></html>", "https://shop.test/about")
        .drafts,
    ).toEqual([]);
  });
});

describe("suggestUsdc", () => {
  it("suggests 1:1 only for USD", () => {
    expect(suggestUsdc({ amount: "9.90", currency: "USD" })).toBe(99_000_000n);
    expect(suggestUsdc({ amount: "1,234.5", currency: "USD" })).toBe(12_345_000_000n);
    expect(suggestUsdc({ amount: "3.00", currency: "EUR" })).toBeUndefined();
    expect(suggestUsdc(undefined)).toBeUndefined();
  });
});

describe("scanSite", () => {
  const pages: Record<string, string> = {
    "/robots.txt": "User-agent: *\nDisallow: /private/\n",
    "/sitemap.xml": sitemap,
    "/product/mug/": productPage,
    "/product/stickers/": ogPage,
    "/private/secret/": productPage,
    "/": "<html><body>home</body></html>",
  };

  it("crawls same-origin sitemap pages, respects robots.txt and suggests USD prices", async () => {
    const fetchImpl = siteFetch(pages);
    const result = await scanSite({
      baseUrl: "https://shop.test",
      fetcher: { fetchImpl, minIntervalMs: 0 },
    });
    expect(result.stats.sitemapUrls).toBe(4); // other.test excluded
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/private/secret/"))).toBe(false);
    expect(urls.some((u) => u.includes("other.test"))).toBe(false);
    const mug = result.drafts.find((d) => d.title === "Ceramic Mug 350ml");
    expect(mug?.priceUsdcSuggested).toBe(99_000_000n);
    const stickers = result.drafts.find((d) => d.title === "Sticker Pack");
    expect(stickers?.priceUsdcSuggested).toBeUndefined();
  });

  it("prefers connector data and merges page evidence", async () => {
    const connectorProduct: ConnectorProduct = {
      externalId: "12",
      title: "Ceramic Mug 350ml",
      description: "White ceramic mug, 350 ml, dishwasher safe.",
      url: "https://shop.test/product/mug/",
      sku: "AG-MUG-350",
      price: { amount: "9.90", currency: "USD" },
      stock: { managed: true, quantity: 50, inStock: true },
      physical: true,
      attributes: { sku: "AG-MUG-350" },
    };
    const connector: OrderConnector = {
      platform: "woocommerce",
      listProducts: async () => [connectorProduct],
      getAvailability: async () => [],
      createOrder: async () => ({ externalOrderId: "1" }),
    };
    const result = await scanSite({
      baseUrl: "https://shop.test",
      connector,
      fetcher: { fetchImpl: siteFetch(pages), minIntervalMs: 0 },
    });
    const mug = result.drafts.find((d) => d.externalId === "12");
    expect(mug).toBeDefined();
    expect(mug?.stockMode).toBe("tracked");
    expect(mug?.imageUrl).toBe("https://shop.test/mug.jpg");
    expect(mug?.sourceEvidence.map((e) => e.source)).toEqual([
      "connector:woocommerce",
      "https://shop.test/product/mug/",
    ]);
    expect(result.stats.connectorItems).toBe(1);
    expect(result.drafts.filter((d) => d.title === "Ceramic Mug 350ml")).toHaveLength(1);
  });

  it("uses the LLM only to redact, keeping evidence", async () => {
    const llm = {
      name: "fake",
      model: "m",
      complete: vi.fn(async () => ({
        text: "",
        json: {
          descriptionAgent: "Ceramic mug, 350 ml, dishwasher safe.",
          attributes: { capacity: "350 ml" },
        },
        provider: "fake",
        model: "m",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      })),
    };
    const result = await scanSite({
      baseUrl: "https://shop.test",
      llm,
      fetcher: { fetchImpl: siteFetch(pages), minIntervalMs: 0 },
    });
    const mug = result.drafts.find((d) => d.title === "Ceramic Mug 350ml");
    expect(mug?.descriptionAgent).toBe("Ceramic mug, 350 ml, dishwasher safe.");
    expect(mug?.attributes.capacity).toBe("350 ml");
    expect(mug?.sourceEvidence.at(-1)?.source).toBe("llm:fake/m");
    expect(result.stats.llmRedacted).toBe(2);
  });
});

describe("SiteFetcher", () => {
  it("refuses other origins", async () => {
    const f = new SiteFetcher({
      baseUrl: "https://shop.test",
      fetchImpl: siteFetch({}),
      minIntervalMs: 0,
    });
    await expect(f.text("https://evil.test/")).rejects.toThrow(/origin/);
  });
});
