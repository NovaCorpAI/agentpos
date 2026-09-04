# @agentpos/merchant-web

The merchant onboarding wizard: a single web page where a store owner produces a valid AgentPOS
configuration and verifies their deployment, without reading docs. It walks the same steps as
`docs/onboarding.es.md` (store basics, wallet, WooCommerce keys, generated files, verification),
in Spanish first with an English toggle.

## Stateless, on purpose

There are no accounts, no database and no server-side storage of any kind. Wizard state lives in
the merchant's browser while they fill the form; the result lives in the two files they download
(`agentpos.config.json` and `.env`). The server endpoints act on each request and forget it:

- The WooCommerce keys are used for exactly one probe against the merchant's own store and come
  back inside the generated `.env`. They are never written, logged or forwarded anywhere else.
- The wallet field accepts only a PUBLIC Stellar address (`G...`). Anything starting with `S` is
  refused with `SECRET_IN_CONFIG` and is never echoed back, not even inside the error.

## Endpoints

| Endpoint | What it does |
| --- | --- |
| `GET /` | The wizard page (self-contained HTML, no CDN, no framework). |
| `POST /api/validate-wallet` | `{ address }` → validates via `StrKey`; refuses secrets. |
| `POST /api/validate-woo` | One-shot `GET /wp-json/wc/v3/products?per_page=1` with the given keys (10s timeout). |
| `POST /api/generate` | Returns `agentpos.config.json` (built through `siteConfigSchema`, valid by construction) and `.env`, plus nginx/Caddy snippets and the next commands. |
| `GET /api/verify?domain=` | Checks `/agentpos/health`, `/openapi.json`, `/.well-known/ucp` and `/llms.txt`, the same discovery the reference buying agent performs. |

Every error is typed: `{ error: { code, message, hint, retryable } }`.

## Run

```bash
pnpm --filter @agentpos/merchant-web dev    # http://localhost:8410 (PORT to change)
pnpm --filter @agentpos/merchant-web test
```
