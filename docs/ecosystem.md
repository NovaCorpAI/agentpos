# Ecosystem discovery (G3)

How an agent that was never told a store exists finds it, and what each directory in the x402
ecosystem actually requires. Researched 2026-08-29 against the live sites and APIs, not from
memory: every claim below has a URL you can re-check.

## The headline finding: none of them index Stellar yet

All four directories investigated cover Base and Solana, some also Polygon, Arbitrum and
Avalanche. **None lists a Stellar network.** From `GET https://x402-list.com/api/v1/networks`
(2026-08-29):

| CAIP-2 | Network | Services |
| --- | --- | --- |
| `eip155:8453` | Base | 541 |
| `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | Solana | 205 |
| `eip155:137` | Polygon | 53 |
| `eip155:42161` | Arbitrum One | 36 |
| `eip155:84532` | Base Sepolia | 7 |
| `eip155:43114` | Avalanche | 7 |
| plus four testnets with 1 service each | | |

x402scan states its scope plainly in its own `llms.txt`: it "indexes x402 servers, transactions,
buyers, merchants, and facilitators **across Base and Solana**".

What this means for us, stated without spin: **being listed is currently a partial win at best.**
A submission can be accepted on the strength of a valid 402 challenge, but the network will not be
recognised, on-chain settlement verification will not run against Stellar, and the "verified"
badges that depend on a settlement probe are out of reach until these indexes add it.

Two consequences worth acting on:

1. Discoverability that we control matters more than directory listings for now: the OpenAPI
   document, `llms.txt`, the UCP manifest and the MCP endpoint that every AgentGate store serves.
   Those work regardless of which directory has caught up.
2. Asking the directories to add Stellar is itself a task, and a reasonable one to raise alongside
   the extension draft. Built on Stellar is a live facilitator with real settlement; the gap is
   indexer coverage, not protocol support.

## What every AgentGate store publishes

Served by the sidecar, no configuration required:

| Location | What it is |
| --- | --- |
| `{origin}/openapi.json` | OpenAPI 3.1 with `x-payment-info` on the paid checkout and `security: []` on everything free. This is the canonical discovery format for the ecosystem's crawlers. |
| `{origin}/llms.txt` | The same facts as plain text, in the order an agent has to act on them. |
| `{origin}/.well-known/ucp` | UCP business profile (see `docs/adapter-versions.md` for the pinned release). |
| `{base}/feed` | ACP product feed. |
| `{base}/mcp` | MCP endpoint. |
| `{base}/health` | Facilitator reachability and stuck orders. |

Two conventions the crawlers care about, and that are easy to get wrong:

- `x-payment-info.price.amount` is **decimal USD**. The runtime x402 `accepts[].amount` is in
  **atomic units**. Mixing them is the most common listing failure ("Malformed Runtime Amount").
  Our adapter emits both, from the same source, in the right units; `packages/site/src/discovery.test.ts`
  asserts it.
- An endpoint that is neither paid nor identity-gated **must** carry `security: []`. Without it a
  crawler cannot distinguish a free endpoint from a misconfigured paid one and probes it in vain.

## Directory by directory

### x402-list.com

- **What it is:** an agent-first open directory of x402 services, with uptime monitoring and
  on-chain settlement verification. 575 services at the time of writing.
- **Submission:** open. Web form at `https://x402-list.com/submit`, or
  `POST https://x402-list.com/api/v1/submit`. Every submission is reviewed by a human; pending
  submissions older than 7 days are auto-rejected.
- **Body** (`ServiceSubmissionRequest`, from `https://x402-list.com/api/v1/openapi.json`):
  `url`, `email`, `service_name`, `description`, `website_url`, `category`, `endpoints[]`, and
  optional `notes`. Categories: AI, Blockchain, Compute, Content, Data, Finance, Other,
  Verification.
- **Costs and rejections:** free on your own domain. $1 USDC on Base for services on a free
  compute host (`*.vercel.app`, `*.workers.dev`, `*.pages.dev`, `*.netlify.app`, and similar).
  Static-only hosting (`github.io`, `gitlab.io`, `surge.sh`) and dev tunnels (ngrok,
  trycloudflare) are rejected at any price. One submission per email per 7 days.
- **Machine-readable:** `GET /api/v1/services`, OpenAPI at `/api/v1/openapi.json`, full catalogue
  at `/llms-full.txt`, MCP at `https://mcp.x402-list.com/mcp` or `npx -y x402-list-mcp`.
  Rate limit 200 req/min; above 2,000 req/day it is metered.
- **Our status:** ready to submit from a custom domain (so free). Network will not be recognised
  until Stellar is added.

### x402scan.com

- **What it is:** explorer and registry for x402 across Base and Solana, with a public API
  (`/api/x402`) where most read endpoints are themselves x402-paid (~$0.01–0.02).
- **Listing:** register a resource at `https://www.x402scan.com/resources/register`. Registry
  writes are free but use **SIWX wallet authentication**, so a wallet the merchant controls has to
  sign in. There is no email-based path.
- **Discovery contract:** `https://www.x402scan.com/discovery/spec.md`. OpenAPI at
  `{origin}/openapi.json` is the canonical source; the runtime 402 is the tie-breaker. It requires
  `openapi`, `info.title`, `info.x-guidance`, `info.version`, `paths`; `responses.402` and
  `x-payment-info` on paid operations; `security: []` on free ones. `info.contact.email` is
  recommended and is how origin ownership gets verified.
- **Our status:** our OpenAPI document was written against this contract. Registration needs the
  founder's wallet (SIWX) and a live public store, so it waits on G2.

### masterkey.sh

- **What it is:** a broad API directory (~1,800 services across 30+ categories), organised by
  function rather than by chain.
- **Listing:** **no public submission process found.** `https://masterkey.sh/llms.txt` answers
  `401`, and the browsable directory exposes no submission form, contact address or API
  documentation. Recorded here as "unknown", not as "not possible" — the honest state is that we
  could not determine it from public sources on 2026-08-29.
- **Next step:** find a contact through the x402 community channels rather than guessing at an
  endpoint.

### agentic.market

- **What it is:** a browsable catalogue of callable x402 services, Coinbase-adjacent (its docs
  link to `docs.cdp.coinbase.com/x402`).
- **Listing:** the public API is **read-only**: `GET https://api.agentic.market/v1/services` and
  `/v1/services/search?q=`. No submission endpoint is documented in `llms.txt` or on the site.
  Indexing appears to be curated or derived from other sources.
- **Our status:** nothing to submit. Being discoverable through the mechanisms above is the only
  lever we have here.

## Submission checklist (when a public store is live)

1. `curl https://<store>/openapi.json` returns 200 and validates as OpenAPI 3.1.
2. `curl -X POST https://<store>/agentgate/checkout?cart=<id>` returns **402**, not 400 — request
   validation must not run before the payment challenge.
3. `pnpm --filter @agentgate/site gate:check` green, and `/agentgate/health` reports `ok: true`.
4. Submit to x402-list.com with `category: "Other"` (there is no Commerce category), the store's
   own domain as `url`, and `endpoints: ["/agentgate/catalog", "/agentgate/checkout"]`.
5. Register on x402scan with the merchant's wallet (SIWX).
6. Record the outcome, including rejections and their reasons, back into this file.

## An index of AgentGate stores is opt-in, and is not a marketplace

The "For agents" page on `agentgate.novacorplabs.com` lists stores that have **explicitly asked**
to appear. That is a discovery index, not a central listing: no commission, no funds routed
through us, no store listed without its own request. A merchant appearing there is still the
merchant of record and still sells from its own domain (guardrail 7). A store that never opts in
is fully functional and fully discoverable through its own `openapi.json`, `llms.txt` and UCP
manifest — the index is a convenience, never a gate.

## Re-checking

The ecosystem moves fast enough that this file has a shelf life.

- Vendored protocol schemas: `pnpm --filter @agentgate/core vendor:schemas` reports drift and
  exits non-zero; `-- --write` updates them. Then update `packages/core/src/adapter/versions.ts`
  and `docs/adapter-versions.md`.
- Directory facts above: re-read each `llms.txt` and OpenAPI document; they are the parts most
  likely to have changed.
