# @agentpos/merchant-web

The seller's space: a single web page where a store owner connects their store in four guided
steps, without reading docs. Step 1 "Tu tienda" (store URL, name, WooCommerce REST keys with a
live probe), step 2 "Tu wallet" (public address only; a pasted secret is refused instantly),
step 3 "Revisa y descarga" (generated `agentpos.config.json` and `.env`, testnet by default),
step 4 "Instala y vende" (proxy rules, install commands, the panel key and the same verification
checklist a real buying agent runs). Spanish first with an English toggle, mirroring
`docs/onboarding.es.md`.

## Stateless, on purpose

There are no accounts, no database and no server-side storage of any kind. Wizard state lives in
the merchant's browser while they fill the form; the result lives in the two files they download
(`agentpos.config.json` and `.env`). The server endpoints act on each request and forget it:

- The WooCommerce keys are used for exactly one probe against the merchant's own store and come
  back inside the generated `.env`. They are never written, logged or forwarded anywhere else.
- The wallet field accepts only a PUBLIC Stellar address (`G...`). Anything starting with `S` is
  refused with `SECRET_IN_CONFIG` and is never echoed back, not even inside the error.
- `MERCHANT_API_TOKEN` (the store owner's key for the read-only merchant API that AgentPOS Cloud
  reads) is minted per request with 32 bytes of `randomBytes`, base64url. It goes into the
  generated `.env`, is returned once as `merchantApiToken` so the wizard can show and explain it,
  and is never stored or logged here. The verification call that uses it is a POST, so the key
  never appears in a URL.

## Published on the internet

This app runs at `https://conecta.agentposhq.com` (see `deploy/`), which changes the threat
model: three of its endpoints fetch a URL that whoever calls them chose.

**Outbound guard (`src/ssrf.ts`).** Every outbound fetch in this app goes through
`createGuardedFetch`, one instance per inbound request. It accepts only `http`/`https`, refuses
credentials inside the URL, allows only ports 80, 443, 8080 and 8443, resolves the hostname and
refuses loopback, this-network, private, carrier-NAT, link-local, unique-local, multicast,
benchmark, documentation and reserved addresses in IPv4 and IPv6 (including the IPv4-mapped,
NAT64 and IPv4-compatible forms), follows redirects itself and refuses any that leaves the
original host, caps each response at 512 KiB and each hop at 10s, and caps one inbound request
at 8 outbound requests. A refusal is a typed `CONFIG_INVALID` whose message the merchant can
act on ("Esa dirección no es pública"), with the machine-readable family in `details.reason`.
A DNS failure is deliberately not a refusal: it surfaces as "the store did not answer".

**Rate limits (`src/limits.ts`).** Per client address, on the endpoints that fetch:
`/api/validate-woo` 20/min (burst 10) and `/api/verify` 10/min (burst 5), answered with 429,
`Retry-After` and a typed `RATE_LIMITED` body. The bucket is `TokenBucketLimiter` from
`@agentpos/site`, the same one the store library uses. The client address is the **last**
`x-forwarded-for` entry (the one our own Caddy wrote); reading the first would let anyone reset
their own limit with a made-up header.

**Body and field limits.** 64 KiB per request on `/api/*` (413), plus a maximum length on every
field: URLs 2048, display name 120, Stellar address 120, WooCommerce keys 256, panel key 512.

**Logs.** No merchant input is ever logged, at any level: not the WooCommerce keys, not the
wallet address, not the generated `MERCHANT_API_TOKEN`. There is a test that asserts it on the
happy path and on every error path.

## Endpoints

| Endpoint                    | What it does                                                                                                                                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                     | The wizard page (self-contained HTML, no CDN, no framework).                                                                                                                                                                 |
| `GET /health`               | Liveness for the container healthcheck: `{ ok, service, stateless }`. Says nothing about any merchant, because it knows nothing about any merchant.                                                                          |
| `POST /api/validate-wallet` | `{ address }` → validates via `StrKey`; refuses secrets.                                                                                                                                                                     |
| `POST /api/validate-woo`    | One-shot `GET /wp-json/wc/v3/products?per_page=1` with the given keys (10s timeout). Rate limited.                                                                                                                           |
| `POST /api/generate`        | Returns `agentpos.config.json` (built through `siteConfigSchema`, valid by construction) and `.env` (with a fresh `MERCHANT_API_TOKEN`), plus nginx/Caddy snippets, the next commands and `merchantApiToken`.                |
| `GET /api/verify?domain=`   | Checks `/agentpos/health`, `/openapi.json`, `/.well-known/ucp` and `/llms.txt`, the same discovery the reference buying agent performs. Rate limited.                                                                        |
| `POST /api/verify`          | `{ domain, merchantApiToken? }`: the same checks, plus the panel check when a key is given (`/agentpos/api/merchant/summary` must answer 200 with the key and 401 without it; a 404 means the store runs an older AgentPOS). |

Every error is typed: `{ error: { code, message, hint, retryable } }`.

## Run

```bash
pnpm --filter @agentpos/merchant-web dev    # http://localhost:8410 (PORT to change)
pnpm --filter @agentpos/merchant-web test
```

## Deploy

`deploy/` holds the production assets for `https://conecta.agentposhq.com`: a multi-stage
Dockerfile (node:22-alpine, non-root), a compose service on the shared external `edge` network
with no host port, the Caddy block (also checked in at `apps/facilitator/deploy/Caddyfile`) and
the operator sequence with its post-deploy checks. `PORT` is the only variable this app reads.
See `deploy/README.md`.
