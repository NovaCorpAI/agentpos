/**
 * Scanner orchestrator (SPEC 05). Sources by trust: connector > structured data on pages.
 * Output is always a DRAFT; a human confirms before anything is published (guardrail 5).
 */
import type {
  CatalogItemDraft,
  ConnectorProduct,
  LlmProvider,
  OrderConnector,
  UsdcMinor,
} from "@agentgate/core";
import { AgentGateError, slugify, usdc } from "@agentgate/core";
import { SiteFetcher } from "./fetch.js";
import type { SiteFetcherOptions } from "./fetch.js";
import { extractFromHtml } from "./html.js";
import { collectSitemapUrls, looksLikeItemUrl } from "./sitemap.js";

export interface ScanOptions {
  baseUrl: string;
  connector?: OrderConnector;
  llm?: LlmProvider;
  /** Max product pages fetched from the sitemap. */
  maxPages?: number;
  fetcher?: Partial<SiteFetcherOptions>;
  /** Called for progress lines in the CLI. */
  onProgress?: (message: string) => void;
}

export interface ScanResult {
  drafts: CatalogItemDraft[];
  stats: {
    connectorItems: number;
    sitemapUrls: number;
    pagesFetched: number;
    pageItems: number;
    llmRedacted: number;
  };
}

/** Suggests a USDC price only for USD sources (1:1). Other currencies need the human. */
export function suggestUsdc(
  price: { amount: string; currency: string } | undefined,
): UsdcMinor | undefined {
  if (!price || price.currency !== "USD") return undefined;
  try {
    const normalized = price.amount.replace(/,/g, "");
    const [whole, frac = ""] = normalized.split(".");
    return usdc(`${whole}${frac ? `.${frac.slice(0, 7)}` : ""}`);
  } catch {
    return undefined;
  }
}

function fromConnectorProduct(p: ConnectorProduct, platform: string): CatalogItemDraft {
  const suggested = suggestUsdc(p.price);
  return {
    id: slugify(p.sku ? `${p.title}-${p.sku}` : `${p.title}-${p.externalId}`),
    externalId: p.externalId,
    type: "product",
    title: p.title,
    descriptionAgent: p.description,
    url: p.url,
    ...(p.imageUrl ? { imageUrl: p.imageUrl } : {}),
    attributes: p.attributes,
    ...(p.price ? { priceSrc: p.price } : {}),
    stockMode: p.stock.managed ? "tracked" : "untracked",
    physical: p.physical,
    sourceEvidence: [{ source: `connector:${platform}`, locator: `product/${p.externalId}` }],
    confidence: p.price ? 0.95 : 0.7,
    ...(suggested !== undefined ? { priceUsdcSuggested: suggested } : {}),
  };
}

const REDACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["descriptionAgent", "attributes"],
  properties: {
    descriptionAgent: { type: "string", maxLength: 400 },
    attributes: { type: "object", additionalProperties: { type: "string" } },
  },
} as const;

async function redactWithLlm(
  llm: LlmProvider,
  draft: CatalogItemDraft,
  context: string,
): Promise<CatalogItemDraft> {
  const res = await llm.complete({
    system:
      "You write catalog entries for AI shopping agents. Output only facts present in the input. Never invent specs, prices or availability. Units and formats explicit. No marketing language. Keep it under 60 words.",
    prompt: `Item title: ${draft.title}\nSource description: ${draft.descriptionAgent || "(none)"}\nKnown attributes: ${JSON.stringify(draft.attributes)}\nPage text (may include noise): ${context.slice(0, 2500)}\n\nReturn JSON {descriptionAgent, attributes}. Only include attributes supported by the text.`,
    jsonSchema: REDACTION_SCHEMA,
    effort: "low",
    maxTokens: 800,
  });
  const json = res.json as
    { descriptionAgent?: string; attributes?: Record<string, string> } | undefined;
  if (!json?.descriptionAgent) return draft;
  return {
    ...draft,
    descriptionAgent: json.descriptionAgent,
    attributes: { ...draft.attributes, ...(json.attributes ?? {}) },
    sourceEvidence: [
      ...draft.sourceEvidence,
      { source: `llm:${llm.name}/${llm.model}`, locator: "descriptionAgent" },
    ],
  };
}

export async function scanSite(options: ScanOptions): Promise<ScanResult> {
  const progress = options.onProgress ?? (() => {});
  const fetcher = new SiteFetcher({ baseUrl: options.baseUrl, ...options.fetcher });
  const byId = new Map<string, CatalogItemDraft>();
  const stats = {
    connectorItems: 0,
    sitemapUrls: 0,
    pagesFetched: 0,
    pageItems: 0,
    llmRedacted: 0,
  };
  const pageContext = new Map<string, string>();

  if (options.connector?.listProducts) {
    progress(`reading products from ${options.connector.platform} connector`);
    const products = await options.connector.listProducts();
    for (const p of products) {
      const draft = fromConnectorProduct(p, options.connector.platform);
      byId.set(draft.id, draft);
    }
    stats.connectorItems = products.length;
    progress(`connector returned ${products.length} products`);
  }

  progress("reading sitemap");
  const urls = await collectSitemapUrls(fetcher);
  stats.sitemapUrls = urls.length;
  const ranked = [...urls].sort(
    (a, b) => Number(looksLikeItemUrl(b)) - Number(looksLikeItemUrl(a)),
  );
  const maxPages = options.maxPages ?? 200;
  for (const url of ranked.slice(0, maxPages)) {
    const html = await fetcher.text(url);
    if (!html) continue;
    stats.pagesFetched += 1;
    const page = extractFromHtml(html, url);
    for (const draft of page.drafts) {
      const suggested = suggestUsdc(draft.priceSrc);
      const withPrice =
        suggested !== undefined ? { ...draft, priceUsdcSuggested: suggested } : draft;
      pageContext.set(withPrice.id, page.textSnippet);
      const existing =
        byId.get(withPrice.id) ?? [...byId.values()].find((d) => d.url === withPrice.url);
      if (existing) {
        // Connector wins on price/stock; pages add evidence, image and attributes.
        byId.set(existing.id, {
          ...existing,
          imageUrl: existing.imageUrl ?? withPrice.imageUrl,
          attributes: { ...withPrice.attributes, ...existing.attributes },
          descriptionAgent: existing.descriptionAgent || withPrice.descriptionAgent,
          sourceEvidence: [...existing.sourceEvidence, ...withPrice.sourceEvidence],
        } as CatalogItemDraft);
        pageContext.set(existing.id, page.textSnippet);
      } else {
        byId.set(withPrice.id, withPrice);
        stats.pageItems += 1;
      }
    }
  }

  let drafts = [...byId.values()];
  if (options.llm) {
    progress(`redacting ${drafts.length} descriptions with ${options.llm.name}`);
    const redacted: CatalogItemDraft[] = [];
    for (const draft of drafts) {
      try {
        redacted.push(
          await redactWithLlm(
            options.llm,
            draft,
            pageContext.get(draft.id) ?? draft.descriptionAgent,
          ),
        );
        stats.llmRedacted += 1;
      } catch (err) {
        progress(
          `llm skipped for ${draft.id}: ${err instanceof AgentGateError ? err.code : String(err)}`,
        );
        redacted.push(draft);
      }
    }
    drafts = redacted;
  }

  drafts.sort((a, b) => b.confidence - a.confidence || a.title.localeCompare(b.title));
  return { drafts, stats };
}
