# @agentpos/site

The library that turns a site into an agent-buyable store (SPEC 01, 08, 09).

```
npx @agentpos/site init      # config + wallet
npx @agentpos/site scan      # read your own site -> draft (nothing published)
npx @agentpos/site confirm   # you set every price
npx @agentpos/site publish   # verify the payment rail, expose the catalog
npx @agentpos/site serve     # sidecar on :8402; prints the proxy config for nginx | caddy |
                             # apache | cloudflare (--proxy <one> for just one)
npx @agentpos/site status    # orders, tx hashes, connector errors (--retry)
npx @agentpos/site approvals # orders parked for your decision (M2)
npx @agentpos/site agents    # who may buy: register | revoke (M3)
npx @agentpos/site receipts  # signed audit chain: verify | export (M4)
```

Programmatic use (Node sites):

```ts
import { createAgentPOS } from "@agentpos/site";

const gate = await createAgentPOS({ cwd: process.cwd() }); // agentpos.config.json + .env
await gate.serve(8402); // or:
app.all("/agentpos/*", (c) => gate.fetch(c.req.raw)); // any fetch-compatible framework
```

Custom stacks pass hooks instead of a platform:

```ts
const gate = await createAgentPOS({
  site: { siteUrl, displayName, payTo, platform: "generic" },
  hooks: {
    listProducts: async () => [...],                 // optional, feeds the scanner
    getAvailability: async (items) => [...],        // optional, live stock
    createOrder: async (paid) => ({ externalOrderId: "..." }), // called ONLY after settlement
  },
});
```

Discovery (served automatically, nothing to configure): `/openapi.json` and `/llms.txt` at the
site root, which is where the x402 directories and crawlers look. See `docs/ecosystem.md`.

Surfaces: `/.well-known/ucp`, `/agentpos/catalog`, `/agentpos/feed`, `/agentpos/mcp`,
`POST /agentpos/cart`, `POST /agentpos/checkout?cart=` (x402), `POST /agentpos/checkout/card?cart=`
and `/agentpos/checkout/card/return` (card rail, when `transbank` is configured), `/agentpos/orders/:id`,
`/agentpos/approvals/:id`, `/agentpos/orders/:id/receipt`, `/agentpos/receipts/:hash`,
`/agentpos/health`.

## Catalog search

`GET /agentpos/catalog` answers the whole published catalog, and takes filters so a buying agent
can ask for ONE variant instead of guessing from a text match. Variants are already separate
catalog items (a WooCommerce variable product publishes one item per variation, its options in
`attributes`), so the filters work on them directly. Everything is optional and everything
combines:

| Parameter                       | Form                         | Meaning                                                          |
| ------------------------------- | ---------------------------- | ---------------------------------------------------------------- |
| `q`                             | free text                    | title, description and attributes (accent- and case-insensitive) |
| `attr.<name>=<value>`           | repeatable                   | exact attribute match, ANDed across names                        |
| `minPriceUsdc` / `maxPriceUsdc` | decimal USDC, max 7 decimals | inclusive bounds, compared in minor units                        |
| `physical`                      | `true` \| `false`            | goods that need a shipping address, or digital ones              |
| `inStock`                       | `true` \| `false`            | stock as the catalog knows it; untracked items count as in stock |
| `limit` / `offset`              | integers                     | page size (default 200, max 500) and its start                   |

```
curl "https://shop.example/agentpos/catalog?attr.Passepartout=con&attr.Fondo=blanco&maxPriceUsdc=40&physical=true"
```

Attribute matching is exact on the value but forgiving on spelling: both sides are compared with
diacritics stripped and case folded, so `attr.tamano=30x40` finds `"Tamaño": "30x40"`. An unknown
attribute name simply matches nothing. A malformed value (a price that is not a decimal, an
inverted range, `physical=yes`, `limit=0`) answers `400 CONFIG_INVALID` with a hint naming the
accepted form; unknown parameters are ignored.

The answer keeps `items` unchanged and adds two blocks:

```jsonc
{
  "items": [/* unchanged */],
  "facets": {
    // what the agent can filter on next
    "Passepartout": [
      { "value": "con", "count": 4 },
      { "value": "sin", "count": 2 },
    ],
    "Fondo": [
      { "value": "blanco", "count": 3 },
      { "value": "Café", "count": 1 },
    ],
  },
  "page": { "limit": 20, "offset": 0, "returned": 6, "total": 6 },
}
```

`facets` counts the items matching everything in the request EXCEPT its attribute filters, which
is what lets an agent see that `Passepartout` can also be `sin` while it is already filtering on
`con`. Values are sorted by count descending then alphabetically, capped at 25 per attribute.

The MCP tool `search_items` takes the same filters as arguments (`attributes` as an object,
plus `minPriceUsdc`, `maxPriceUsdc`, `physical`, `inStock`, `limit`, `offset`) and returns the
same `items`, `facets` and `page`.

Order lifecycle: `pending_payment -> paid -> fulfilled | cancelled`, plus `expired` for a cart
that was never paid. While the sidecar runs, a sweep re-reads the platform status of paid orders
(`completed -> fulfilled`; `cancelled`, `refunded`, `failed -> cancelled`; anything else is left
alone) and expires unpaid orders whose cart is gone. A paid order is never expired by a timer.
`gate.sweepOrderLifecycle()` runs one pass by hand, `checkout.syncOrderStatus(orderId)` syncs one
order, and `statusSyncIntervalMs` (default 5 min) sets the sweep's clock.

Trust layer, all optional and off by default: `policy` (what may be sold and up to how much),
`approvals` (park large orders for a human; the agent is never charged while you decide) and
`identity` (require agents to sign their requests, and their owners to vouch for them), plus
`receipts` (a signed, chained record of every sale and every refusal, on by default). See
`@agentpos/policy`, `@agentpos/approvals`, `@agentpos/identity` and `@agentpos/receipts`.

Facilitator failover (operational continuity): configure an ordered facilitator list and the
store keeps selling when the primary is down. Env: `AGENTPOS_FACILITATOR_URL` /
`AGENTPOS_FACILITATOR_API_KEY` stay the primary; add `AGENTPOS_FACILITATOR_FALLBACK_URL` /
`AGENTPOS_FACILITATOR_FALLBACK_API_KEY` for the fallback. Or in `agentpos.config.json`:
`"facilitators": [{ "url": "...", "apiKey": "..." }, ...]` (the config file wins). Verify and
settle of one payment always use the same facilitator, and a settle is retried on the next one
only when the first attempt provably never connected; anything ambiguous goes through the
existing stuck-order path instead of risking a double settlement. `/agentpos/health` lists each
facilitator (host only) as `ok`/`degraded` and marks the active one. With a single facilitator
nothing changes.

Extra networks degrade on their own: each network a rail adds (Arc, for example) is checked
against its own facilitator at most once a minute, and the 402 offers it only while that
facilitator is up. An outage there leaves the store payable on its own network and never stops
the sidecar; the network comes back in the 402 once its facilitator answers again.
`/agentpos/health` lists them under `networks` as `ok`/`degraded`, without turning the store's
`ok` false.

Extra networks are also reconciled when their rail brings a `watcher` (`X402StoreNetwork.watcher`,
a `PaymentWatcher`): every 5 minutes under `serve()` (`reconcileIntervalMs`), the sidecar reads
what the merchant's wallet received there and compares it with the payments it recorded. A
payment still without an order after 2 minutes raises a critical `PAYMENT_WITHOUT_ORDER` alert,
once per transaction, listing the pending orders with the same total. It never creates an order
or moves funds. `createAgentPOS({ x402Networks })` takes the same networks as
`createAgentPOSApp`.

## Merchant API

Token-authenticated, READ-ONLY endpoints under `/agentpos/api/merchant/*` for the store owner's
own tooling, and the surface AgentPOS Cloud reads: the hosted dashboard consumes a store through
this API instead of touching its database, and self-hosted merchants get the same programmatic
access to their own data. Read-only is deliberate: prices, policies and rules live in the
merchant's `agentpos.config.json` on their machine, so nothing remote (our Cloud included) can
ever change what a store sells or for how much.

Set `MERCHANT_API_TOKEN` (min 24 chars, e.g. `openssl rand -hex 24`) in the sidecar's
environment; without it the routes are not mounted at all. The token belongs to the store owner:
treat it like a password.

```
curl -H "Authorization: Bearer <MERCHANT_API_TOKEN>" \
  https://shop.example/agentpos/api/merchant/summary
```

- `GET /api/merchant/summary` — store identity, order/receipt/catalog counts, facilitator
  health (hosts only) and adapter version: a dashboard front page in one call.
- `GET /api/merchant/orders?status=&from=&to=&limit=&cursor=` — paginated orders, oldest
  first, with payment, rail and tx hash per order. The cursor is opaque; keep the returned
  `nextCursor` to sync incrementally.
- `GET /api/merchant/orders/:id` — full detail, `connectorError` and `hold` included.
- `GET /api/merchant/receipts?limit=&cursor=` — the signed receipt chain (seq, hash, event,
  order id, timestamp); `GET /api/merchant/receipts/:seq` returns one full receipt with body,
  hash and signature.
- `GET /api/merchant/rules` — the same JSON the dashboard's Rules tab renders.
- `GET /api/merchant/export.csv?from=YYYY-MM-DD&to=YYYY-MM-DD` — the reconciliation export
  (default: last 30 days): one CSV row per order (date, ids, status, items, gross USDC, rail,
  asset, tx hash, settled at, buyer email), localized headers (EN/ES per `locale`), RFC 4180
  quoting and a UTF-8 BOM so Excel opens it directly. Bounds accept `YYYY-MM-DD` or a full ISO
  timestamp; a malformed or inverted range answers `400 CONFIG_INVALID`.

  ```
  curl -H "Authorization: Bearer $MERCHANT_API_TOKEN" \
    "https://shop.example/agentpos/api/merchant/export.csv?from=2026-09-01&to=2026-09-30" \
    -o conciliacion.csv
  ```

  This file carries buyer emails, order ids and transaction hashes, so it is served **only**
  here, behind the token. It is not on the public dashboard path and the dashboard page does not
  link it: the Metrics tab only prints the command above.

Wrong or missing token answers `401` with code `MERCHANT_UNAUTHORIZED`; the group is rate
limited (`rateLimit.merchantApiPerMinute`, default 120/min) with `429` + `Retry-After`. Logs
carry a sha256-8 hash of the token, never the token.

Storage: `node:sqlite` in `.agentpos/agentpos.sqlite` (no native dependencies). Secrets stay in
`.env` on the merchant's server. See `docs/quickstart.en.md` / `docs/quickstart.es.md`.
