/**
 * OpenAPI discovery document (G3, SPEC 09).
 *
 * The ecosystem's crawlers treat an OpenAPI document at `{origin}/openapi.json` as the canonical
 * machine-readable contract, with the runtime 402 challenge as the tie-breaker. Publishing one is
 * what makes a store findable by agents that were never told it exists, which is the whole point
 * of the discoverability gate.
 *
 * Two conventions matter and are easy to get wrong:
 *  - `x-payment-info.price.amount` is decimal USD, while the runtime x402 `accepts[].amount` is in
 *    the asset's atomic units. Emitting dollars at runtime is the most common listing failure.
 *  - Endpoints that are neither paid nor identity-gated MUST carry `security: []`. Without it a
 *    crawler cannot tell a free endpoint from a misconfigured paid one, and probes it in vain.
 *
 * Honesty rule, as in the UCP adapter: we describe only what the sidecar actually serves. Routes
 * that a given store has turned off are omitted rather than advertised.
 */
import { ADAPTER_VERSION, PROTOCOL_VERSIONS } from "./versions.js";

export interface StoreOpenApiInput {
  siteUrl: string;
  /** Path prefix of the AgentPOS routes, e.g. "/agentpos". */
  basePath: string;
  displayName: string;
  /** CAIP-2 network the checkout settles on. */
  network: string;
  asset: string;
  assetAddress: string;
  /** Decimal USD price range across the published catalog, for the dynamic pricing declaration. */
  priceRangeUsd?: { min: string; max: string };
  /** How many items are currently published, so an agent can tell an empty store from a broken one. */
  publishedItems?: number;
  /** Optional merchant contact; lets the directories verify origin ownership. */
  contactEmail?: string | undefined;
  /** Whether this store serves per-order receipts (M4). */
  receipts?: boolean;
  /** Whether this store parks orders for human approval (M2). */
  approvals?: boolean;
}

type Operation = Record<string, unknown>;

const jsonResponse = (description: string, schema: Record<string, unknown>) => ({
  description,
  content: { "application/json": { schema } },
});

/** Free and public: declared explicitly so crawlers skip it instead of probing for a 402. */
function freeOperation(op: Operation): Operation {
  return { ...op, security: [] };
}

export function buildStoreOpenApi(input: StoreOpenApiInput): Record<string, unknown> {
  const base = input.basePath;
  const siteUrl = input.siteUrl.replace(/\/+$/, "");
  const range = input.priceRangeUsd;

  const guidance = [
    `${input.displayName} sells real goods and services to agents over x402 on ${input.network}, settling in ${input.asset}.`,
    `Flow: GET ${base}/catalog to see what is for sale, POST ${base}/cart with the items you want, then POST ${base}/checkout?cart=<cartId> and pay the 402 challenge.`,
    `The price is per cart, not per call, so ${base}/checkout quotes dynamically from the cart.`,
    input.approvals
      ? "A cart the merchant flags for human review answers 202 with a polling URL and is NOT charged; poll it and retry the checkout once approved."
      : "",
    input.receipts
      ? `After settlement, GET ${base}/orders/{orderId}/receipt returns a signed receipt you can verify offline.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  const paths: Record<string, Record<string, Operation>> = {
    [`${base}/catalog`]: {
      get: freeOperation({
        operationId: "listCatalog",
        summary: "Catalog - items this store sells to agents",
        tags: ["Catalog"],
        parameters: [
          {
            name: "q",
            in: "query",
            required: false,
            description: "Free-text filter over titles and descriptions.",
            schema: { type: "string", maxLength: 200 },
          },
        ],
        responses: {
          200: jsonResponse("The published catalog with prices in the checkout asset.", {
            type: "object",
            properties: {
              adapterVersion: { type: "string" },
              site: {
                type: "object",
                properties: { name: { type: "string" }, url: { type: "string" } },
              },
              payment: {
                type: "object",
                properties: {
                  protocol: { type: "string" },
                  network: { type: "string" },
                  asset: { type: "string" },
                  assetAddress: { type: "string" },
                  checkout: { type: "string" },
                },
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    type: { type: "string" },
                    title: { type: "string" },
                    description: { type: "string" },
                    url: { type: "string" },
                    price: {
                      type: "object",
                      properties: {
                        amount: { type: "string" },
                        asset: { type: "string" },
                        minor: { type: "string" },
                      },
                      required: ["amount", "asset", "minor"],
                    },
                    physical: { type: "boolean" },
                  },
                  required: ["id", "title", "price"],
                },
              },
            },
            required: ["items"],
          }),
        },
      }),
    },
    [`${base}/cart`]: {
      post: freeOperation({
        operationId: "createCart",
        summary: "Cart - quote a set of items before paying",
        tags: ["Checkout"],
        description:
          "Creating a cart is free and reserves nothing. It returns the exact terms the 402 will demand, and the merchant policy outcome for those terms.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    minItems: 1,
                    items: {
                      type: "object",
                      properties: {
                        itemId: { type: "string", minLength: 1 },
                        quantity: { type: "integer", minimum: 1 },
                        note: {
                          type: "string",
                          minLength: 1,
                          maxLength: 500,
                          description:
                            "Free-text personalization for this line (engraving, dedication, chosen color). Passed verbatim to the merchant; never changes the price.",
                        },
                      },
                      required: ["itemId", "quantity"],
                    },
                  },
                  buyer: {
                    type: "object",
                    properties: {
                      email: { type: "string", format: "email" },
                      name: { type: "string" },
                    },
                    required: ["email"],
                  },
                  shipping: {
                    type: "object",
                    description: "Required for physical items.",
                    properties: {
                      name: { type: "string" },
                      line1: { type: "string" },
                      line2: { type: "string" },
                      city: { type: "string" },
                      region: { type: "string" },
                      postalCode: { type: "string" },
                      country: { type: "string", minLength: 2, maxLength: 2 },
                      phone: { type: "string" },
                    },
                    required: ["name", "line1", "city", "postalCode", "country"],
                  },
                },
                required: ["items"],
              },
            },
          },
        },
        responses: {
          201: jsonResponse("A quoted cart.", {
            type: "object",
            properties: {
              cartId: { type: "string" },
              expiresAt: { type: "string", format: "date-time" },
              quote: { type: "object" },
              checkout: { type: "string" },
              policy: { type: "object" },
              agent: { type: "object" },
            },
            required: ["cartId", "quote", "checkout"],
          }),
          403: jsonResponse("The merchant policy refuses this sale; the code says why.", {
            type: "object",
            properties: { error: { type: "object" } },
          }),
        },
      }),
    },
    [`${base}/checkout`]: {
      post: {
        operationId: "checkout",
        summary: "Checkout - pay for a quoted cart over x402",
        tags: ["Checkout"],
        description:
          "Answers 402 with the exact terms of the cart. Pay and repeat the request with the payment header; the order is created in the merchant's system only after settlement.",
        "x-payment-info": {
          price: range
            ? { mode: "dynamic", currency: "USD", min: range.min, max: range.max }
            : { mode: "dynamic", currency: "USD", min: "0.01", max: "10000.00" },
          protocols: [{ x402: { network: input.network, asset: input.assetAddress } }],
        },
        parameters: [
          {
            name: "cart",
            in: "query",
            required: true,
            description: `Cart id from POST ${base}/cart.`,
            schema: { type: "string", minLength: 1 },
          },
        ],
        responses: {
          200: jsonResponse("Payment verified; settlement runs immediately after this response.", {
            type: "object",
            properties: {
              orderId: { type: "string" },
              status: { type: "string" },
              order: { type: "string" },
            },
            required: ["orderId", "status"],
          }),
          ...(input.approvals
            ? {
                202: jsonResponse(
                  "The merchant parked this order for a human. Nothing was charged; poll the approval.",
                  {
                    type: "object",
                    properties: {
                      status: { type: "string" },
                      approvalId: { type: "string" },
                      poll: { type: "string" },
                      expiresAt: { type: "string", format: "date-time" },
                    },
                  },
                ),
              }
            : {}),
          402: { description: "Payment Required" },
          409: jsonResponse("The cart must be re-quoted (price or stock changed).", {
            type: "object",
            properties: { error: { type: "object" } },
          }),
        },
      },
    },
    [`${base}/orders/{orderId}`]: {
      get: freeOperation({
        operationId: "getOrder",
        summary: "Order - status, payment and the merchant's order id",
        tags: ["Orders"],
        parameters: [{ name: "orderId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: jsonResponse("The order as the merchant sees it.", {
            type: "object",
            properties: {
              orderId: { type: "string" },
              status: { type: "string" },
              total: { type: "string" },
              payment: { type: "object" },
              externalOrderId: { type: "string" },
            },
            required: ["orderId", "status"],
          }),
          404: jsonResponse("No such order.", { type: "object" }),
        },
      }),
    },
    [`${base}/health`]: {
      get: freeOperation({
        operationId: "health",
        summary: "Health - facilitator reachability and stuck orders",
        tags: ["Operations"],
        responses: {
          200: jsonResponse("Healthy.", {
            type: "object",
            properties: { ok: { type: "boolean" }, network: { type: "string" } },
            required: ["ok"],
          }),
          503: jsonResponse("Degraded; do not start a purchase.", { type: "object" }),
        },
      }),
    },
  };

  paths[`${base}/feed`] = {
    get: freeOperation({
      operationId: "productFeed",
      summary: "Product feed - ACP ProductsResponse",
      tags: ["Catalog"],
      description: `Agentic Commerce Protocol ${PROTOCOL_VERSIONS.acp.version} product feed, with fiat prices in ISO 4217 minor units.`,
      responses: { 200: jsonResponse("ACP ProductsResponse.", { type: "object" }) },
    }),
  };

  if (input.receipts) {
    paths[`${base}/orders/{orderId}/receipt`] = {
      get: freeOperation({
        operationId: "getOrderReceipt",
        summary: "Receipt - signed record of this sale, verifiable offline",
        tags: ["Orders"],
        parameters: [{ name: "orderId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: jsonResponse("The receipt chain for this order, with its verification result.", {
            type: "object",
            properties: {
              receipts: { type: "array", items: { type: "object" } },
              verification: { type: "object" },
            },
            required: ["receipts"],
          }),
          404: jsonResponse("No receipt for that order yet.", { type: "object" }),
        },
      }),
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: `${input.displayName} (AgentPOS store)`,
      version: ADAPTER_VERSION,
      description: `An agent-buyable storefront. Payments over x402 ${PROTOCOL_VERSIONS.x402.protocol} on ${input.network}, settled in ${input.asset}. The merchant is the merchant of record; AgentPOS takes no commission and holds no funds.`,
      "x-guidance": guidance,
      ...(input.contactEmail ? { contact: { email: input.contactEmail } } : {}),
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
    },
    servers: [{ url: siteUrl }],
    "x-agentpos": {
      adapterVersion: ADAPTER_VERSION,
      network: input.network,
      asset: input.asset,
      assetAddress: input.assetAddress,
      manifest: `${siteUrl}/.well-known/ucp`,
      ucpVersion: PROTOCOL_VERSIONS.ucp.version,
      acpVersion: PROTOCOL_VERSIONS.acp.version,
      mcp: `${siteUrl}${base}/mcp`,
      ...(input.publishedItems !== undefined ? { publishedItems: input.publishedItems } : {}),
    },
    paths,
  };
}
