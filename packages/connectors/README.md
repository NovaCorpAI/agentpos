# @agentpos/connectors

Turns a settled on-chain payment into a real order in the merchant's system (SPEC 08).

- `WooCommerceConnector` (REST API v3, consumer key/secret, HTTPS required): lists products for
  the scanner, checks live stock and price, creates a paid order with `transaction_id` and
  `_agentpos_*` metadata, reads order status.
- Variable products are supported: the connector expands each WooCommerce variable product
  into one catalog item per purchasable variation (own id, SKU, price and stock; parent
  attributes plus the selected option values; `parent_id`/`parent_sku` kept in the item
  attributes for traceability). Orders for a variation set `product_id` (parent) plus
  `variation_id`, so the Woo order shows the exact variant. Non-purchasable or non-published
  variations are skipped. Free-text personalization (e.g. engraving text) is a separate
  upcoming core feature, not part of the connector.
- `GenericConnector`: pass `createOrder` (and optionally `listProducts`, `getAvailability`,
  `getOrderStatus`) for custom stacks.
- Shopify: Phase 2.

Connectors never see private keys. `createOrder` is only ever called after the facilitator
settles the payment (guardrail 6).
