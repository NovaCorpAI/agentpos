# Adapter versions (guardrail 3)

Single source of truth: `packages/core/src/adapter/versions.ts`. This file is the human log.
Official schemas are vendored under `packages/core/schemas/` and enforced by
`packages/core/src/adapter/conformance.ts` (tests, CI and `agentpos publish`).

| Protocol    | Pinned                                                                                                                                          | Checked    | Source                                                                                     | Status in v1                                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| x402        | wire V2, SDK `@x402/core` + `@x402/stellar` 2.28.0, scheme `exact`                                                                              | 2026-08-25 | github.com/x402-foundation/x402                                                            | End-to-end (checkout + settle), proven on testnet against the real facilitator                                                                                                     |
| Facilitator | Built on Stellar, `channels.openzeppelin.com/x402[/testnet]`, CAIP-2 `stellar:testnet` / `stellar:pubnet`, API key per network                  | 2026-08-25 | developers.stellar.org/docs/build/agentic-payments/x402/built-on-stellar                   | Used as-is, never reimplemented                                                                                                                                                    |
| UCP         | release `2026-08-25`; business profile at `/.well-known/ucp` validated against `profile.json#/$defs/business_schema` (vendored schema tree)     | 2026-08-29 | github.com/Universal-Commerce-Protocol/ucp (branch `release/2026-08-25`, `source/schemas`) | Schema-valid profile with service `com.novacorplabs.agentpos` and handler `org.x402.stellar`; NO `dev.ucp.shopping` capabilities claimed until UCP checkout semantics ship (Build) |
| ACP         | `2026-04-17` (still the latest release); `/agentpos/feed` = `ProductsResponse` validated against `spec/2026-04-17/json-schema/schema.feed.json` | 2026-08-29 | github.com/agentic-commerce-protocol/agentic-commerce-protocol                             | Feed only, fiat prices in ISO 4217 minor units (schema requirement); checkout + delegated payment are Build slots                                                                  |

Our own identifiers (published at agentposhq.com; the earlier host agentpos.novacorplabs.com never
existed in DNS, corrected 2026-09-25): service `com.novacorplabs.agentpos`
(`/schemas/agentpos-service.openapi.json`), payment handler `org.x402.stellar` id `x402-stellar`
(`/schemas/x402-stellar-handler.json`) and, for stores that take cards in Chile, payment handler
`cl.transbank.webpay` id `cl-transbank-webpay` (`/schemas/cl-transbank-webpay-handler.json`)
(`/schemas/x402-stellar-handler.json`).

## Change log

- 2026-08-25: initial pins (Phase 0). x402 Foundation announced spec v1.0 target for Q3 2026;
  weekly watch issue must diff headers, discovery extension and facilitator `/supported`.
- 2026-08-25: facilitator requires a per-network API key (Bearer). `/supported` returns 401
  without it. Testnet keys are issued without login; mainnet keys via GitHub OAuth. Every
  seller running the site library needs their own key (it is free); the CLI must guide this.
- 2026-08-25 (adapter 0.2.0): UCP and ACP surfaces rewritten to the official shapes and
  validated with ajv against vendored schemas. Findings: UCP registries are keyed by
  reverse-domain names with `YYYY-MM-DD` versions and payment handlers need an `id`; the ACP feed
  price must be an ISO 4217 currency in minor units (USDC is not ISO 4217), so the feed carries
  the merchant's fiat source price and USDC terms live in the UCP handler config and `/catalog`.

- 2026-08-29: el facilitador rechaza toda verificacion en mainnet con
  `unexpected_verify_error` (testnet OK con el mismo codigo). Bloquea G2 por causa externa.
- 2026-08-29 (G3, correccion): **el pin de UCP estaba mal**. `2026-01-01` nunca
  fue un snapshot publicado y sus URLs de esquema respondian 404. Los releases
  reales son `2026-01-11`, `2026-01-23`, `2026-04-08` y `2026-08-25`. Se
  re-vendorizaron los esquemas desde `release/2026-08-25` y nuestro perfil de
  negocio valida **sin cambios** contra ellos, asi que la correccion es de
  declaracion, no de forma. ACP sigue en `2026-04-17` (verificado contra el
  listado de `spec/` del repo: no hay release posterior).
  Para que esto no vuelva a depender de la memoria de nadie:
  `pnpm --filter @agentpos/core vendor:schemas` reporta el drift y sale con
  codigo != 0; con `-- --write` actualiza los archivos vendorizados.
- 2026-08-29 (G3): cada tienda publica ahora `{origin}/openapi.json` (OpenAPI
  3.1 con `x-payment-info` en el checkout pagado y `security: []` en todo lo
  gratis, segun el contrato de descubrimiento de x402scan) y `{origin}/llms.txt`.
  Directorios del ecosistema investigados y documentados en `docs/ecosystem.md`;
  hallazgo principal: **ninguno indexa Stellar todavia**.

## Weekly routine

1. `curl -H "Authorization: Bearer $KEY" https://channels.openzeppelin.com/x402/testnet/supported`
   and compare kinds/extensions.
2. `npm view @x402/stellar version`; read the changelog if it moved.
3. Re-download `source/schemas/**` (UCP) and `spec/<latest>/json-schema/schema.feed.json` (ACP);
   run `pnpm --filter @agentpos/core test` (conformance suite). Open a PR in `wt-core` if the
   pinned version or shapes changed.
