# @agentgate/site

The library that turns a site into an agent-buyable store (SPEC 01, 08, 09).

```
npx @agentgate/site init      # config + wallet
npx @agentgate/site scan      # read your own site -> draft (nothing published)
npx @agentgate/site confirm   # you set every price
npx @agentgate/site publish   # verify the payment rail, expose the catalog
npx @agentgate/site serve     # sidecar on :8402 (reverse-proxy /.well-known/ucp and /agentgate/*)
npx @agentgate/site status    # orders, tx hashes, connector errors (--retry)
npx @agentgate/site approvals # orders parked for your decision (M2)
npx @agentgate/site agents    # who may buy: register | revoke (M3)
```

Programmatic use (Node sites):

```ts
import { createAgentGate } from "@agentgate/site";

const gate = await createAgentGate({ cwd: process.cwd() }); // agentgate.config.json + .env
await gate.serve(8402); // or:
app.all("/agentgate/*", (c) => gate.fetch(c.req.raw)); // any fetch-compatible framework
```

Custom stacks pass hooks instead of a platform:

```ts
const gate = await createAgentGate({
  site: { siteUrl, displayName, payTo, platform: "generic" },
  hooks: {
    listProducts: async () => [...],                 // optional, feeds the scanner
    getAvailability: async (items) => [...],        // optional, live stock
    createOrder: async (paid) => ({ externalOrderId: "..." }), // called ONLY after settlement
  },
});
```

Surfaces: `/.well-known/ucp`, `/agentgate/catalog`, `/agentgate/feed`, `/agentgate/mcp`,
`POST /agentgate/cart`, `POST /agentgate/checkout?cart=`, `/agentgate/orders/:id`,
`/agentgate/approvals/:id`, `/agentgate/health`.

Trust layer, all optional and off by default: `policy` (what may be sold and up to how much),
`approvals` (park large orders for a human; the agent is never charged while you decide) and
`identity` (require agents to sign their requests, and their owners to vouch for them). See
`@agentgate/policy`, `@agentgate/approvals` and `@agentgate/identity`.

Storage: `node:sqlite` in `.agentgate/agentgate.sqlite` (no native dependencies). Secrets stay in
`.env` on the merchant's server. See `docs/quickstart.en.md` / `docs/quickstart.es.md`.
