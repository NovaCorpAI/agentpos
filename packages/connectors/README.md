# @agentpos/connectors

Turns a settled on-chain payment into a real order in the merchant's system (SPEC 08).

- `WooCommerceConnector` (REST API v3, consumer key/secret, HTTPS required): lists products for
  the scanner, checks live stock and price, creates a paid order with `transaction_id` and
  `_agentpos_*` metadata, reads order status.
- `GenericConnector`: pass `createOrder` (and optionally `listProducts`, `getAvailability`,
  `getOrderStatus`) for custom stacks.
- Shopify: Phase 2.

Connectors never see private keys. `createOrder` is only ever called after the facilitator
settles the payment (guardrail 6).
