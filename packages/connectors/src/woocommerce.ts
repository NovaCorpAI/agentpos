/**
 * WooCommerce connector (SPEC 08): REST API v3 over HTTPS with consumer key/secret.
 * Orders are created ONLY from a PaidOrderInput, i.e. after on-chain settlement.
 */
import { z } from "zod";
import { AgentPOSError, formatUsdc } from "@agentpos/core";
import type {
  AvailabilityResult,
  ConnectorOrderResult,
  ConnectorProduct,
  OrderConnector,
  PaidOrderInput,
} from "@agentpos/core";
import { connectorHttpError } from "./errors.js";

export interface WooCommerceConnectorOptions {
  /** Store base URL, e.g. https://shop.example. */
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  /** Only for local demo stores: WooCommerce itself rejects Basic Auth over plain HTTP. */
  allowInsecureHttp?: boolean;
  fetchImpl?: typeof globalThis.fetch;
  /** Store currency; fetched from the API when omitted. */
  currency?: string;
}

const wooProductSchema = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string().optional(),
  permalink: z.string(),
  sku: z.string().optional().default(""),
  status: z.string().optional(),
  type: z.string().optional(),
  virtual: z.boolean().optional().default(false),
  downloadable: z.boolean().optional().default(false),
  price: z.string().optional().default(""),
  regular_price: z.string().optional().default(""),
  description: z.string().optional().default(""),
  short_description: z.string().optional().default(""),
  // Boolean on products; variations that inherit parent stock answer the string "parent".
  manage_stock: z.union([z.boolean(), z.literal("parent")]).optional().default(false),
  stock_quantity: z.number().nullable().optional(),
  stock_status: z.string().optional().default("instock"),
  // GET /products/<variation_id> answers with type "variation" plus the parent product id.
  parent_id: z.number().optional().default(0),
  purchasable: z.boolean().optional(),
  images: z
    .array(z.object({ src: z.string() }))
    .optional()
    .default([]),
  attributes: z
    .array(
      z.object({
        name: z.string(),
        // Parent products list every option; a variation carries the single selected `option`.
        options: z.array(z.string()).optional().default([]),
        option: z.string().optional(),
      }),
    )
    .optional()
    .default([]),
  weight: z.string().optional(),
});
type WooProduct = z.output<typeof wooProductSchema>;

/** Entry of GET /products/<parent>/variations (REST v3): no name/type, single image/option. */
const wooVariationSchema = z.object({
  id: z.number(),
  permalink: z.string().optional().default(""),
  sku: z.string().optional().default(""),
  status: z.string().optional().default("publish"),
  purchasable: z.boolean().optional().default(true),
  virtual: z.boolean().optional().default(false),
  downloadable: z.boolean().optional().default(false),
  price: z.string().optional().default(""),
  regular_price: z.string().optional().default(""),
  description: z.string().optional().default(""),
  manage_stock: z.union([z.boolean(), z.literal("parent")]).optional().default(false),
  stock_quantity: z.number().nullable().optional(),
  stock_status: z.string().optional().default("instock"),
  image: z.object({ src: z.string() }).nullable().optional(),
  attributes: z
    .array(z.object({ name: z.string(), option: z.string() }))
    .optional()
    .default([]),
  weight: z.string().optional(),
});
type WooVariation = z.output<typeof wooVariationSchema>;

const wooOrderSchema = z.object({
  id: z.number(),
  status: z.string(),
  number: z.string().optional(),
});

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export class WooCommerceConnector implements OrderConnector {
  readonly platform = "woocommerce" as const;
  private readonly base: string;
  private readonly auth: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private currency: string | undefined;

  constructor(private readonly options: WooCommerceConnectorOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "https:" && !options.allowInsecureHttp) {
      throw new AgentPOSError(
        "CONFIG_INVALID",
        "WooCommerce connector requires an https:// store URL",
        {
          hint: "WooCommerce only accepts REST credentials over HTTPS. Use allowInsecureHttp only for the local demo store.",
        },
      );
    }
    this.base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    this.auth = `Basic ${Buffer.from(`${options.consumerKey}:${options.consumerSecret}`).toString("base64")}`;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.currency = options.currency;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    schema?: z.ZodType<T>,
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/wp-json/wc/v3${path}`, {
        method,
        headers: {
          authorization: this.auth,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (cause) {
      throw new AgentPOSError("INTERNAL", "WooCommerce store unreachable", {
        hint: "Check the store URL and that the sidecar can reach it.",
        retryable: true,
        cause,
      });
    }
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) throw connectorHttpError("WooCommerce", res.status, json);
    return schema ? schema.parse(json) : (json as T);
  }

  async getCurrency(): Promise<string> {
    if (this.currency) return this.currency;
    const setting = await this.request<{ value?: string }>(
      "GET",
      "/settings/general/woocommerce_currency",
    );
    this.currency =
      typeof setting.value === "string" && setting.value.length === 3 ? setting.value : "USD";
    return this.currency;
  }

  private toProduct(p: WooProduct, currency: string): ConnectorProduct {
    const attributes: Record<string, string> = {};
    for (const a of p.attributes) {
      if (a.options.length) attributes[a.name] = a.options.join(", ");
      else if (a.option) attributes[a.name] = a.option; // variation fetched via /products/<id>
    }
    if (p.sku) attributes.sku = p.sku;
    if (p.weight) attributes.weight = p.weight;
    const description = stripHtml(p.short_description || p.description);
    const price = p.price || p.regular_price;
    return {
      externalId: String(p.id),
      title: p.name,
      description,
      url: p.permalink,
      ...(p.images[0]?.src ? { imageUrl: p.images[0].src } : {}),
      ...(p.sku ? { sku: p.sku } : {}),
      ...(price ? { price: { amount: price, currency } } : {}),
      stock: {
        managed: p.manage_stock === true,
        ...(typeof p.stock_quantity === "number" ? { quantity: p.stock_quantity } : {}),
        inStock: p.stock_status === "instock" || p.stock_status === "onbackorder",
      },
      physical: !(p.virtual || p.downloadable),
      attributes,
    };
  }

  /** One catalog item per purchasable variation: "Parent name — Attr: value — Attr: value". */
  private variationToProduct(
    parent: WooProduct,
    v: WooVariation,
    currency: string,
  ): ConnectorProduct {
    const optionSummary = v.attributes.map((a) => `${a.name}: ${a.option}`).join(" — ");
    const attributes: Record<string, string> = {};
    // Parent attributes first (full option lists), then each selected option overrides its own.
    for (const a of parent.attributes) if (a.options.length) attributes[a.name] = a.options.join(", ");
    for (const a of v.attributes) attributes[a.name] = a.option;
    // Traceability back to the variable product the variation belongs to.
    attributes.parent_id = String(parent.id);
    if (parent.sku) attributes.parent_sku = parent.sku;
    const sku = v.sku || parent.sku;
    if (sku) attributes.sku = sku;
    const weight = v.weight ?? parent.weight;
    if (weight) attributes.weight = weight;
    const price = v.price || v.regular_price || parent.price || parent.regular_price;
    // manage_stock === "parent" means the variation has no stock record of its own: stock is
    // managed (or not) at the parent level, so we surface the parent's stock fields instead.
    const stockSource = v.manage_stock === "parent" ? parent : v;
    const description =
      stripHtml(v.description) || stripHtml(parent.short_description || parent.description);
    return {
      externalId: String(v.id),
      title: optionSummary ? `${parent.name} — ${optionSummary}` : `${parent.name} #${v.id}`,
      description,
      url: v.permalink || parent.permalink,
      ...(v.image?.src
        ? { imageUrl: v.image.src }
        : parent.images[0]?.src
          ? { imageUrl: parent.images[0].src }
          : {}),
      ...(sku ? { sku } : {}),
      ...(price ? { price: { amount: price, currency } } : {}),
      stock: {
        managed: stockSource.manage_stock === true,
        ...(typeof stockSource.stock_quantity === "number"
          ? { quantity: stockSource.stock_quantity }
          : {}),
        // The variation's stock_status already reflects the parent when stock is inherited.
        inStock: v.stock_status === "instock" || v.stock_status === "onbackorder",
      },
      physical: !(v.virtual || v.downloadable),
      attributes,
    };
  }

  private async listVariations(parent: WooProduct, currency: string): Promise<ConnectorProduct[]> {
    const out: ConnectorProduct[] = [];
    for (let page = 1; page <= 50; page += 1) {
      const batch = await this.request(
        "GET",
        `/products/${parent.id}/variations?per_page=100&page=${page}`,
        undefined,
        z.array(wooVariationSchema),
      );
      for (const v of batch) {
        // Debug: skip variations an agent could not buy anyway. `purchasable: false` means Woo
        // itself refuses it (no price, or parent not purchasable); a non-publish status means the
        // merchant disabled ("private") or never enabled ("draft") this combination.
        if (v.purchasable === false) continue;
        if (v.status !== "publish") continue;
        out.push(this.variationToProduct(parent, v, currency));
      }
      if (batch.length < 100) break;
    }
    return out;
  }

  async listProducts(): Promise<ConnectorProduct[]> {
    const currency = await this.getCurrency();
    const out: ConnectorProduct[] = [];
    for (let page = 1; page <= 50; page += 1) {
      const batch = await this.request(
        "GET",
        `/products?per_page=100&page=${page}&status=publish`,
        undefined,
        z.array(wooProductSchema),
      );
      for (const p of batch) {
        if (p.type === "variable") {
          // Variable products are not directly purchasable; publish their variations instead.
          out.push(...(await this.listVariations(p, currency)));
        } else {
          out.push(this.toProduct(p, currency));
        }
      }
      if (batch.length < 100) break;
    }
    return out;
  }

  async getAvailability(
    items: Array<{ itemId: string; externalId?: string; quantity: number }>,
  ): Promise<AvailabilityResult[]> {
    const currency = await this.getCurrency();
    const results: AvailabilityResult[] = [];
    for (const item of items) {
      if (!item.externalId) {
        results.push({ itemId: item.itemId, available: false });
        continue;
      }
      // One call covers simple products AND variations: Woo REST v3 resolves ids through
      // wc_get_product(), so GET /products/<variation_id> works and answers with
      // type "variation", parent_id, and the variation's own price/stock fields. That is the
      // cheapest correct call given we only hold the variation id (no parent id needed upfront).
      const p = await this.request(
        "GET",
        `/products/${encodeURIComponent(item.externalId)}`,
        undefined,
        wooProductSchema,
      );
      let product = this.toProduct(p, currency);
      if (p.type === "variation" && p.manage_stock === "parent" && p.parent_id) {
        // Stock is managed at the parent level; the variation carries no quantity of its own.
        try {
          const parent = await this.request(
            "GET",
            `/products/${p.parent_id}`,
            undefined,
            wooProductSchema,
          );
          product = {
            ...product,
            stock: {
              managed: parent.manage_stock === true,
              ...(typeof parent.stock_quantity === "number"
                ? { quantity: parent.stock_quantity }
                : {}),
              inStock: product.stock.inStock,
            },
          };
        } catch {
          // Parent unreachable: fall back to the variation's own stock_status view.
        }
      }
      const enough =
        product.stock.inStock &&
        (!product.stock.managed || (product.stock.quantity ?? 0) >= item.quantity);
      results.push({
        itemId: item.itemId,
        externalId: item.externalId,
        available: p.status === "publish" && enough,
        ...(product.stock.quantity !== undefined ? { quantity: product.stock.quantity } : {}),
        ...(product.price ? { price: product.price } : {}),
      });
    }
    return results;
  }

  /**
   * Maps a catalog externalId to Woo order line targets. Quote lines carry only the id, so a
   * variation is detected with one GET /products/<id> (type "variation" + parent_id) and emitted
   * as { product_id: parent, variation_id: id }, which makes the Woo order show the exact
   * variant. On lookup failure we fall back to product_id alone: WooCommerce itself normalizes a
   * variation id passed as product_id (WC_Order_Item_Product::set_product), and order creation
   * must never fail because of a metadata lookup.
   */
  private async resolveLineTarget(
    externalId: string,
  ): Promise<{ product_id: number; variation_id?: number }> {
    try {
      const p = await this.request(
        "GET",
        `/products/${encodeURIComponent(externalId)}`,
        undefined,
        z.object({
          id: z.number(),
          type: z.string().optional().default("simple"),
          parent_id: z.number().optional().default(0),
        }),
      );
      if (p.type === "variation" && p.parent_id) {
        return { product_id: p.parent_id, variation_id: p.id };
      }
    } catch {
      // Fall through: send the id as product_id and let Woo resolve it.
    }
    return { product_id: Number(externalId) };
  }

  async createOrder(input: PaidOrderInput): Promise<ConnectorOrderResult> {
    const missing = input.lines.filter((l) => !l.externalId);
    if (missing.length) {
      throw new AgentPOSError(
        "CONFIG_INVALID",
        "Every line needs a WooCommerce product id (externalId)",
        {
          hint: "Re-scan with the connector enabled so catalog items carry their WooCommerce ids.",
          details: { items: missing.map((l) => l.itemId) },
        },
      );
    }
    // Resolve each distinct externalId once; variations become product_id + variation_id pairs.
    const targets = new Map<string, { product_id: number; variation_id?: number }>();
    for (const line of input.lines) {
      const id = line.externalId!;
      if (!targets.has(id)) targets.set(id, await this.resolveLineTarget(id));
    }
    const [first = "", ...rest] = (input.shipping?.name ?? input.buyer?.name ?? "").split(" ");
    const last = rest.join(" ");
    const address = input.shipping
      ? {
          first_name: first,
          last_name: last,
          address_1: input.shipping.line1,
          address_2: input.shipping.line2 ?? "",
          city: input.shipping.city,
          state: input.shipping.region ?? "",
          postcode: input.shipping.postalCode,
          country: input.shipping.country,
          phone: input.shipping.phone ?? "",
        }
      : undefined;
    const body = {
      status: "processing",
      set_paid: true,
      payment_method: "agentpos",
      payment_method_title: `Stablecoin (${input.payment.asset} on Stellar) via AgentPOS`,
      transaction_id: input.payment.txHash,
      created_via: "agentpos",
      customer_note: `Paid by an AI agent via AgentPOS. Total ${formatUsdc(input.totalUsdc)} ${input.payment.asset}. tx ${input.payment.txHash}`,
      billing: {
        ...(address ?? { first_name: first, last_name: last }),
        email: input.buyer?.email ?? "",
      },
      ...(address ? { shipping: address } : {}),
      line_items: input.lines.map((l) => {
        const target = targets.get(l.externalId!) ?? { product_id: Number(l.externalId) };
        return {
          product_id: target.product_id,
          ...(target.variation_id !== undefined ? { variation_id: target.variation_id } : {}),
          quantity: l.quantity,
        };
      }),
      meta_data: [
        { key: "_agentpos_order_id", value: input.orderId },
        { key: "_agentpos_tx_hash", value: input.payment.txHash },
        { key: "_agentpos_network", value: input.payment.network },
        { key: "_agentpos_asset", value: input.payment.asset },
        { key: "_agentpos_amount_minor", value: input.payment.amountMinor.toString() },
        { key: "_agentpos_payer", value: input.payment.payer ?? "" },
      ],
    };
    const order = await this.request("POST", "/orders", body, wooOrderSchema);
    return {
      externalOrderId: String(order.id),
      adminUrl: `${this.base}/wp-admin/post.php?post=${order.id}&action=edit`,
    };
  }

  async getOrderStatus(externalOrderId: string): Promise<{ status: string; raw?: unknown }> {
    const order = await this.request(
      "GET",
      `/orders/${encodeURIComponent(externalOrderId)}`,
      undefined,
      wooOrderSchema,
    );
    return { status: order.status, raw: order };
  }
}
