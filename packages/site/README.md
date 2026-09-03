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

Storage: `node:sqlite` in `.agentpos/agentpos.sqlite` (no native dependencies). Secrets stay in
`.env` on the merchant's server. See `docs/quickstart.en.md` / `docs/quickstart.es.md`.
