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

Reconciliation export: `GET /agentpos/dashboard/export.csv?from=YYYY-MM-DD&to=YYYY-MM-DD`
(default: last 30 days) returns one CSV row per order (date, ids, status, items, gross USDC,
rail, asset, tx hash, settled at, buyer email) with localized headers (EN/ES per `locale`),
RFC 4180 quoting and a UTF-8 BOM so Excel opens it directly. The dashboard's Metrics tab links
it ("Exportar CSV").

Storage: `node:sqlite` in `.agentpos/agentpos.sqlite` (no native dependencies). Secrets stay in
`.env` on the merchant's server. See `docs/quickstart.en.md` / `docs/quickstart.es.md`.
