import type { CatalogItem, CatalogItemDraft, UsdcMinor } from "@agentpos/core";
import { AgentPOSError, MIN_PRICE_USDC, compareUsdc } from "@agentpos/core";
import type { SiteStorage } from "./storage.js";

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

  /** Plain-text search over title, description and attributes (v1). */
  search(query: string, limit = 20): CatalogItem[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const items = this.published();
    if (terms.length === 0) return items.slice(0, limit);
    return items
      .map((item) => {
        const haystack = `${item.title} ${item.descriptionAgent} ${Object.entries(item.attributes)
          .map(([k, v]) => `${k} ${v}`)
          .join(" ")}`.toLowerCase();
        const score = terms.reduce((acc, t) => acc + (haystack.includes(t) ? 1 : 0), 0);
        return { item, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => r.item);
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
