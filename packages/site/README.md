# @agentgate/site

The library that turns a site into an agent-buyable store (SPEC 01, 08, 09).

```
npx @agentgate/site init      # config + wallet
npx @agentgate/site scan      # read your own site -> draft (nothing published)
npx @agentgate/site confirm   # you set every price
npx @agentgate/site publish   # verify the payment rail, expose the catalog
npx @agentgate/site serve     # sidecar on :8402 (reverse-proxy /.well-known/ucp and /agentgate/*)
npx @agentgate/site status    # orders, tx hashes, connector errors (--retry)
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
`POST /agentgate/cart`, `POST /agentgate/checkout?cart=`, `/agentgate/orders/:id`, `/agentgate/health`.

Storage: `node:sqlite` in `.agentgate/agentgate.sqlite` (no native dependencies). Secrets stay in
`.env` on the merchant's server. See `docs/quickstart.en.md` / `docs/quickstart.es.md`.
