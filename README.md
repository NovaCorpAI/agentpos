# AgentPOS

**The point of sale for AI agents.** Turn any store that already sells in fiat into an endpoint
agents can buy from — on the store's own domain, with the money going straight to the merchant.

```bash
npx agentpos init      # config + wallet link (public address only, never keys)
npx agentpos scan      # reads YOUR site and proposes a catalog — nothing is published
npx agentpos confirm   # you review every item and set every price
npx agentpos publish   # verifies the payment rail, exposes the catalog
npx agentpos serve     # sidecar on :8402 — your store now sells to agents
```

An AI agent can then discover the store (`/openapi.json`, `/llms.txt`, `/.well-known/ucp`, MCP),
quote a cart, pay the `402 Payment Required` challenge in USDC on Stellar, and the order lands in
the merchant's own admin (WooCommerce today, generic hook for custom stacks, Shopify next) —
**only after the payment settled on-chain**, with the transaction hash attached.

Proven in production: real mainnet sales, settled end to end, with verifiable hashes.

## What makes it different

**It is not a marketplace, on purpose.** The usual answer to agentic commerce is a new central
bazaar. AgentPOS does the opposite: it upgrades the store you already have. No commission, no
listing, no funds ever passing through us — the merchant is always the merchant of record, on
their own domain, receiving USDC directly in their own wallet.

**Zero custody, enforced.** The sidecar refuses to start if a private key appears in its
configuration. Payments move buyer → merchant inside a single transaction; nothing we run can
hold them.

**Standards, not lock-in.** Catalog and checkout speak UCP, ACP, x402 v2 and MCP through a
pinned adapter layer, validated against the official schemas. Agents authenticate with RFC 9421
HTTP Message Signatures. Any compliant client can buy; any store can leave.

**A trust layer merchants actually control:**

- **Policy** (`@agentpos/policy`) — what may be sold to agents, how much, to where.
- **Human approvals** (`@agentpos/approvals`) — orders over a threshold wait for a person;
  the agent is never charged while a human decides, and silence rejects.
- **Know Your Agent** (`@agentpos/identity`) — Ed25519-signed requests and owner attestations
  ("this key acts for me"), with revocation that takes effect on the next request.
- **Verifiable receipts** (`@agentpos/receipts`) — every sale *and every refusal* leaves a
  signed, hash-chained receipt anyone can verify offline: what was offered, what the policy
  said, who approved, who bought, what settled. A merchant cannot rewrite its own history.

The receipt and attestation formats are specified for third parties in
[`specs/extensions/agent-commerce-receipts.md`](specs/extensions/agent-commerce-receipts.md),
written as an extension draft for the x402 ecosystem.

## Try it as an agent, right now, without a wallet

```bash
npx agentpos-buyer demo https://<any-agentpos-store> --dry-run
```

The reference buying agent discovers the store the way a stranger would, quotes a cart, and
stops before payment. Drop `--dry-run` (after `agentpos-buyer init`) to buy for real — within a
human-set mandate: spending caps, site allowlists, and confirmation thresholds the agent cannot
cross.

## Monorepo

| Package | What it is |
| --- | --- |
| `packages/site` | The library: scanner, surfaces, checkout, storage, CLI. Runs as middleware or standalone sidecar. Zero native dependencies (`node:sqlite`). |
| `packages/core` | Types, config, money (integer minor units, never floats), protocol adapters, conformance validation. |
| `packages/scanner` | Reads *your own* site (sitemap, schema.org, connector) into a draft catalog. Never third-party sites. |
| `packages/connectors` | WooCommerce REST, generic `onOrder` hook. Own HTTP clients, no SDK lock-in. |
| `packages/policy` · `approvals` · `identity` · `receipts` | The trust layer (see above). |
| `packages/mcp-buyer` | The buyer side: MCP server + reference agent under a human mandate. |
| `apps/facilitator` | A minimal self-hostable x402 facilitator for Stellar, on the official SDKs. |
| `apps/demo-store` | WooCommerce in Docker for e2e and demos. |

## Development

Node ≥ 22.5, pnpm 11.

```bash
pnpm install
pnpm build && pnpm test && pnpm lint
pnpm demo:up          # WooCommerce demo store in Docker
pnpm e2e:testnet      # full loop against real Stellar testnet
pnpm gate:check       # the production gate: 10 checks, all must be green
```

Every payment-path change must keep `gate:check` at 100%: exact amount/asset/destination
verification, idempotency by tx hash, replay rejection, quote TTLs, sad paths with defined
behavior, rate limits, secret scanning of the full git history.

## Documentation

Everything user-facing is in [`docs/`](docs/README.md), in English and Spanish:

| Guide | What it covers |
| --- | --- |
| [Merchant quickstart](docs/quickstart-merchant.en.md) ([ES](docs/quickstart-merchant.es.md)) | WooCommerce store to agent-buyable store in under 30 minutes: keys, sidecar (node or docker), scan/confirm/publish, verification checklist, what it costs. |
| [Buyer quickstart](docs/quickstart-buyer.en.md) ([ES](docs/quickstart-buyer.es.md)) | The buying agent: mandate, funding, demo purchase, MCP client, the buyer web space with WhatsApp and the signing bridge. |
| [Operations](docs/operations.en.md) ([ES](docs/operations.es.md)) | Running a live store: dashboard, reconciliation CSV, order states, held orders, stuck settlements, facilitator failover, token rotation, receipts. |
| [FAQ](docs/faq.en.md) ([ES](docs/faq.es.md)) | Custody, wrong amounts, pausing agentic sales, catalog exposure, taxes, what happens if we disappear. |

Also: the full-reference [quickstart](docs/quickstart.en.md), the assisted
[onboarding script](docs/onboarding.en.md), and the operational
[runbook](docs/RUNBOOK.md).

## What is open and what is not

Everything in this repo is **Apache-2.0, forever**: the sidecar, the CLI, the connectors, the
trust layer, the buyer, the facilitator, the formats and their SPECs. The planned paid layer
(AgentPOS Cloud: managed dashboards, long-term receipt archival, chain reconciliation) is a
hosted service built *on top of* these formats — never a gate in front of them. A store that
never pays us anything is a fully functional, fully discoverable store.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Short version: conventional commits, small PRs, one
topic per PR, tests green, and the non-negotiable guardrails in `CLAUDE.md` (zero custody, no
marketplace, no order without settled payment) are not up for debate.

---

Built by [NovaCorpAI](https://agentgate.novacorplabs.com) · Apache-2.0
