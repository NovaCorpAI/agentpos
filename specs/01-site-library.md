# SPEC 01: Site library + CLI (`@agentgate/site`)

## Objetivo

De "tengo un sitio que vende en fiat" a "mi sitio es comprable por agentes
y las órdenes llegan a mi admin" en <15 minutos, sin conocimiento de
blockchain ni de protocolos agénticos.

## Dos modos de ejecución (misma librería)

- **Middleware:** el sitio es Node (Express, Hono, Next.js). Se monta en
  `/agentgate/*` y `/.well-known/ucp`. Comparte proceso.
- **Sidecar:** el sitio NO es Node (WooCommerce/PHP, Shopify, estático,
  Django...). `npx agentgate serve` levanta un proceso aparte en el mismo
  servidor (o en un contenedor al lado) y el vendedor agrega una regla de
  reverse proxy para `/agentgate/*` y `/.well-known/ucp`. El CLI imprime
  el snippet exacto para nginx, Caddy, Apache y Cloudflare.
  Ambos modos comparten storage local (SQLite por defecto, Postgres opcional).

## Experiencia CLI (`npx agentgate ...`)

1. `init`: URL base del sitio, idioma (en/es), plataforma detectada
   (Shopify / WooCommerce / custom, por fingerprint del HTML y
   confirmación), modo (middleware/sidecar). Credenciales del connector
   (SPEC 08) se guardan cifradas en `~/.agentgate/<site>/` con passphrase;
   nunca salen del servidor.
2. `scan`: corre el scanner (SPEC 05) sobre el propio dominio. Salida:
   `agentgate.catalog.draft.json` + tabla en terminal "esto entendí".
3. `confirm`: revisión interactiva campo por campo o edición del draft.
   El precio en USDC lo pone o confirma el humano (sugerencia por tipo de
   cambio del precio fiat, siempre editable). Pasa a `confirmed`.
4. Wallet (SPEC 07): default VINCULAR una existente (dirección pública +
   firma de nonce vía dashboard/Wallets Kit, o CLI con XDR). Fallback:
   generar keypair local cifrado. Trustline USDC: XDR para firmar
   client-side; en testnet friendbot fondea.
5. `publish`: valida (zod), screening de la address, verificación de
   dominio (TXT DNS o `/.well-known/agentgate.txt`), genera las superficies
   (SPEC 09) vía core/adapter, marca `published`, registra opcionalmente en
   el hosted y en índices del ecosistema, y verifica end-to-end con una
   compra de prueba en testnet contra la propia tienda.
6. `status`: órdenes recientes, pagos, saldo, últimos errores, lag del
   connector.
7. `serve`: modo sidecar.

## Runtime (lo que expone la librería)

- **Surfaces** (SPEC 09): `/.well-known/ucp`, `/agentgate/feed`,
  `/agentgate/mcp`, `/agentgate/catalog`, discovery x402.
- **Checkout** (SPEC 08): `POST /agentgate/cart`, `POST /agentgate/quote`,
  `POST /agentgate/checkout` (responde 402 con términos x402; con
  `PAYMENT-SIGNATURE` válida -> verify -> settle -> orden -> 200 con
  recibo), `GET /agentgate/orders/:id`.
- **Sync:** re-scan programado (cron configurable) que detecta cambios de
  precio/stock/productos y genera un nuevo draft; nunca publica solo.
  Con connector activo, stock y precio se leen de la plataforma en tiempo
  real en `quote`, no del scan.
- Errores SIEMPRE `{ code, message, hint }`.

## API pública (index.ts)

`createAgentGate(config)`, `agentgate.middleware()` (Express/Hono/Next),
`agentgate.serve(port)`, tipos `SiteConfig`, `CatalogItem`, `Order`,
`PriceUSDC` (branded int, 7 dec). CLI en `bin/`.

## Tests

- Unit: config parsing, money, storage adapter, generación de superficies
  (snapshot contra fixtures de cada spec vigente).
- E2e testnet (CI): init -> scan sobre demo-store -> confirm (auto con
  fixture) -> publish -> compra real por script agente -> assert orden en
  Woo + tx hash.

## Fuera de alcance v1

Multi-asset (solo USDC), esquema upto, webhooks salientes a terceros,
plugin PHP nativo (fase Build; el sidecar cubre Woo en v1).
