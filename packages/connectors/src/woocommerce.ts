/**
 * WooCommerce connector (SPEC 08): REST API v3 over HTTPS with consumer key/secret.
 * Orders are created ONLY from a PaidOrderInput, i.e. after on-chain settlement.
 */
import { z } from "zod";
import { AgentGateError, formatUsdc } from "@agentgate/core";
import type {
  AvailabilityResult,
  ConnectorOrderResult,
  ConnectorProduct,
  OrderConnector,
  PaidOrderInput,
} from "@agentgate/core";
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
  manage_stock: z.boolean().optional().default(false),
  stock_quantity: z.number().nullable().optional(),
  stock_status: z.string().optional().default("instock"),
  images: z
    .array(z.object({ src: z.string() }))
    .optional()
    .default([]),
  attributes: z
    .array(z.object({ name: z.string(), options: z.array(z.string()).optional().default([]) }))
    .optional()
    .default([]),
  weight: z.string().optional(),
});
type WooProduct = z.output<typeof wooProductSchema>;

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
      throw new AgentGateError(
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
      throw new AgentGateError("INTERNAL", "WooCommerce store unreachable", {
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
    for (const a of p.attributes) if (a.options.length) attributes[a.name] = a.options.join(", ");
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
        managed: p.manage_stock,
        ...(typeof p.stock_quantity === "number" ? { quantity: p.stock_quantity } : {}),
        inStock: p.stock_status === "instock" || p.stock_status === "onbackorder",
      },
      physical: !(p.virtual || p.downloadable),
      attributes,
    };
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
      out.push(...batch.map((p) => this.toProduct(p, currency)));
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
      const p = await this.request(
        "GET",
        `/products/${encodeURIComponent(item.externalId)}`,
        undefined,
        wooProductSchema,
      );
      const product = this.toProduct(p, currency);
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

  async createOrder(input: PaidOrderInput): Promise<ConnectorOrderResult> {
    const missing = input.lines.filter((l) => !l.externalId);
    if (missing.length) {
      throw new AgentGateError(
        "CONFIG_INVALID",
        "Every line needs a WooCommerce product id (externalId)",
        {
          hint: "Re-scan with the connector enabled so catalog items carry their WooCommerce ids.",
          details: { items: missing.map((l) => l.itemId) },
        },
      );
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
      payment_method: "agentgate",
      payment_method_title: `Stablecoin (${input.payment.asset} on Stellar) via AgentGate`,
      transaction_id: input.payment.txHash,
      created_via: "agentgate",
      customer_note: `Paid by an AI agent via AgentGate. Total ${formatUsdc(input.totalUsdc)} ${input.payment.asset}. tx ${input.payment.txHash}`,
      billing: {
        ...(address ?? { first_name: first, last_name: last }),
        email: input.buyer?.email ?? "",
      },
      ...(address ? { shipping: address } : {}),
      line_items: input.lines.map((l) => ({
        product_id: Number(l.externalId),
        quantity: l.quantity,
      })),
      meta_data: [
        { key: "_agentgate_order_id", value: input.orderId },
        { key: "_agentgate_tx_hash", value: input.payment.txHash },
        { key: "_agentgate_network", value: input.payment.network },
        { key: "_agentgate_asset", value: input.payment.asset },
        { key: "_agentgate_amount_minor", value: input.payment.amountMinor.toString() },
        { key: "_agentgate_payer", value: input.payment.payer ?? "" },
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
