# Arquitectura

## Principio rector

Somos la capa de EXPERIENCIA sobre primitivos ajenos. Reutilizamos: x402 y
`@x402/stellar`, el facilitador público Built on Stellar, UCP y ACP como
formatos de discovery y checkout, Stellar Wallets Kit, y las APIs de las
plataformas de e-commerce. Construimos lo que nadie hace: escaneo del sitio
propio, catálogo agéntico, adaptador multi-protocolo, checkout x402 sobre
órdenes reales, connectors, MCP comprador con mandato, dashboard.

## Diagrama lógico

```
[Sitio del vendedor: vende en fiat hoy]
  +- @agentpos/site  (corre en SU servidor: middleware Node o sidecar)
      |- scanner .......... sitemap + schema.org + paginas / OpenAPI -> catalogo DRAFT
      |                      -> humano confirma -> CONFIRMED -> se publica
      |- surfaces ......... /.well-known/ucp (UCP) | /agentpos/feed (ACP)
      |                      | /agentpos/mcp (MCP) | discovery x402
      |- checkout ......... cart -> quote -> 402 (x402 exact, USDC) -> pago -> orden
      +- connector ........ Shopify | WooCommerce | hook onOrder -> orden real
                                                     en el sistema del vendedor
  Facilitador "Built on Stellar" (verify/settle)              [NO nuestro]
  Stellar (USDC, testnet -> mainnet)

[Agente comprador]
  +- @agentpos/mcp-buyer  (search / quote / buy dentro de mandato humano)
      consume: sitios AgentPOS + cualquier sitio UCP/ACP/x402 via adapter
  (o cualquier cliente x402/UCP/ACP de terceros: el sitio es estandar)

[Plano de datos hosted, OPCIONAL]
  indexer (eventos Stellar -> Supabase)   [RPC retiene solo 7 dias]
  dashboard (Next 15: ordenes, ingresos, wallets, verificacion, screening)
  registry (directorio opt-in de sitios autopublicados; NO marketplace)
```

## Decisiones y sus porqués

- **Self-hosted first.** La librería funciona completa sin nuestra nube:
  catálogo, checkout, pago y orden viven en el servidor del vendedor. El
  hosted agrega verificación, screening, indexado y dashboard. Esto es lo
  que hace que no seamos un bazar: no hay lugar central por el que pase la
  venta.
- **Interop antes que protocolo propio.** No inventamos un formato. El
  sitio emite UCP (manifiesto en `/.well-known/ucp`), feed ACP y discovery
  x402. Todo contacto con esos specs pasa por `packages/core/src/adapter/`
  (un módulo por protocolo, versión fijada, `adapterVersion` en cada
  metadata emitida). v1 garantiza x402 + MCP nativo end-to-end; UCP y ACP
  se emiten para discovery y se llevan a conformance en fase Build.
- **Pago: x402 exact scheme, USDC sobre Stellar.** Facilitador Built on
  Stellar (`https://channels.openzeppelin.com/x402/testnet` y
  `https://channels.openzeppelin.com/x402`, redes CAIP-2 `stellar:testnet`
  y `stellar:pubnet`, fees patrocinadas, finalidad ~5 s; requiere API key
  gratuita por red, Bearer en verify/settle/supported). Headers x402 V2
  (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`). En el
  manifiesto UCP se declara un payment handler `x402-stellar`; en ACP se
  documenta como handler delegado propio. Verificar ambas rutas contra la
  versión vigente de cada spec antes de fijar (rutina semanal).
- **La orden es la unidad de venta, no el request.** Un pago sin orden en
  el sistema del vendedor es un pago perdido. Por eso los connectors son
  parte del núcleo v1: Shopify (Admin API GraphQL, orden con
  `financial_status: paid` y gateway custom), WooCommerce (REST API v3,
  orden `processing` con `payment_method: agentpos`), hook `onOrder` para
  stacks custom. Reserva de stock con TTL durante la ventana de pago.
- **Sin contratos Soroban propios en v1.** El flujo exact no los necesita.
  Auth-capture entra en fase Build cuando el ecosistema entregue la
  primitiva.
- **Sin facilitador propio, sin wallet propia, sin custodia, sin fiat.**
  Existe facilitador público; Wallets Kit cubre firmas client-side; el
  vendedor retira con sus medios (guías off-ramp, nunca procesamos fiat).
- **Descubrimiento sin bazar.** Cada sitio se autopublica. Opcionalmente
  se registra en índices existentes del ecosistema (extensión de discovery
  de x402 vía facilitador, x402scan, Agent.market) y en nuestro registry
  opt-in. El registry es un directorio de URLs verificadas, sin listados,
  sin comisión, sin merchant of record.
- **Indexer propio mínimo.** Cron worker sobre Horizon/RPC para las wallets
  vinculadas de sitios registrados. Alcance: nuestros sitios, no la red.

## Modelo de datos

Dos capas con el mismo esquema lógico:

- **Local (en el sitio):** `packages/site` persiste vía adapter de storage
  (SQLite por defecto, Postgres opcional). Fuente de verdad del catálogo y
  las órdenes de ese sitio.
- **Hosted (Supabase, RLS por merchant_id):** copia de lo que el sitio
  decide reportar + lo que el indexer observa on-chain.

Tablas:

- `merchants` (id, auth_user, display_name, domain, platform
  shopify|woocommerce|custom, verified_at)
- `wallets` (merchant_id, address unique, label, proof_sig, screened_at,
  status active|flagged|removed)
- `catalog_items` (merchant_id, external_id, type product|service|api,
  title, description_agent, attributes jsonb, price_usdc, currency_src,
  price_src, stock_mode tracked|untracked, status draft|confirmed|published,
  pay_to_wallet_id, source_evidence jsonb)
- `carts` (merchant_id, items jsonb, quote jsonb, expires_at)
- `reservations` (cart_id, item_id, qty, expires_at)
- `orders` (merchant_id, cart_id, external_order_id?, status
  pending_payment|paid|fulfilled|cancelled|expired, buyer_contact jsonb,
  shipping jsonb?, total_usdc, connector_result jsonb)
- `payments` (tx_hash unique, order_id, amount_usdc, ledger, ts, network)
- `mandates` (buyer-side: límites, allowlist, period)
- `fiscal_entries` (plugin: payment_id, country, rate, local_value, source)
- `audit_log` (append-only)

Dinero: enteros en unidades mínimas (USDC 7 decimales), tipos branded.

## Seguridad

- RLS en todo lo hosted; service role solo en indexer.
- zod en TODA frontera: CLI, HTTP, MCP, connectors, scanner output.
- Orden solo tras `settle` confirmado por el facilitador; idempotencia por
  tx_hash. Nunca crear orden con `verify` solo.
- Screening de direcciones al vincular, al publicar y semanal.
- El scanner solo lee el dominio donde corre la librería (consentimiento
  por instalación). Nunca sitios de terceros.
- Secrets de connectors (tokens Shopify/Woo) viven en el servidor del
  vendedor, cifrados en su config; nunca en nuestro hosted.
- gitleaks pre-commit; dependabot on.

## Qué observar del ecosistema (rutina semanal, issue recurrente)

- x402-foundation/x402: spec v1.0 (objetivo Q3 2026), extensiones,
  discovery. Releases de `@x402/stellar` y `@x402/core`.
- UCP (ucp.dev): versiones del manifiesto, payment handlers, capacidades.
- ACP (agentic-commerce-protocol): versión vigente (última fijada:
  2026-04-17), delegated payment.
- Shopify Admin API (versiones trimestrales), WooCommerce REST v3.
- RFPs del SCF y Stellarlight, hackathons, Meridian.
