import { XMLParser } from "fast-xml-parser";
import type { SiteFetcher } from "./fetch.js";

const parser = new XMLParser({ ignoreAttributes: true });

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Collects page URLs from /sitemap.xml (and nested sitemap indexes), capped. */
export async function collectSitemapUrls(fetcher: SiteFetcher, maxUrls = 500): Promise<string[]> {
  const seen = new Set<string>();
  const queue = [
    `${fetcher.origin}/sitemap.xml`,
    `${fetcher.origin}/sitemap_index.xml`,
    `${fetcher.origin}/wp-sitemap.xml`,
  ];
  const visited = new Set<string>();
  while (queue.length && seen.size < maxUrls) {
    const url = queue.shift() as string;
    if (visited.has(url)) continue;
    visited.add(url);
    const xml = await fetcher.text(url);
    if (!xml) continue;
    let doc: Record<string, unknown>;
    try {
      doc = parser.parse(xml) as Record<string, unknown>;
    } catch {
      continue;
    }
    const index = doc.sitemapindex as { sitemap?: unknown } | undefined;
    for (const entry of asArray(
      index?.sitemap as { loc?: string }[] | { loc?: string } | undefined,
    )) {
      if (entry?.loc && fetcher.isSameOrigin(entry.loc)) queue.push(entry.loc);
    }
    const urlset = doc.urlset as { url?: unknown } | undefined;
    for (const entry of asArray(urlset?.url as { loc?: string }[] | { loc?: string } | undefined)) {
      if (entry?.loc && fetcher.isSameOrigin(entry.loc)) seen.add(entry.loc);
      if (seen.size >= maxUrls) break;
    }
  }
  return [...seen];
}

/** Heuristic: URLs that usually are product/service pages, to prioritize crawling. */
export function looksLikeItemUrl(url: string): boolean {
  return /\/(product|products|producto|productos|item|items|shop|tienda|service|servicios|services|p)\//i.test(
    url,
  );
}
