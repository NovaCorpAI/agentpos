# @agentpos/site

The library that turns a site into an agent-buyable store (SPEC 01, 08, 09).

```
npx @agentpos/site init      # config + wallet
npx @agentpos/site scan      # read your own site -> draft (nothing published)
npx @agentpos/site confirm   # you set every price
npx @agentpos/site publish   # verify the payment rail, expose the catalog
npx @agentpos/site serve     # sidecar on :8402 (reverse-proxy /.well-known/ucp and /agentpos/*)
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
`POST /agentpos/cart`, `POST /agentpos/checkout?cart=`, `/agentpos/orders/:id`,
`/agentpos/approvals/:id`, `/agentpos/orders/:id/receipt`, `/agentpos/receipts/:hash`,
`/agentpos/health`.

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
