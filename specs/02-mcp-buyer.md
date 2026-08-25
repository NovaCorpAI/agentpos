# SPEC 02: Servidor MCP comprador (`@agentgate/mcp-buyer`)

## Objetivo

Que cualquier agente (Claude u otro runtime MCP) descubra, evalúe y compre
en tiendas agénticas, siempre dentro de un mandato humano. Es el cliente de
referencia; los sitios AgentGate son estándar y cualquier otro cliente
x402/UCP/ACP puede comprarles.

## Herramientas MCP

1. `search_offers({ query, maxPriceUsdc?, sellers?, network? })`
   Busca en: (a) el registry opt-in de sitios AgentGate, (b) índices x402
   del ecosistema vía adapter, (c) URLs de tiendas dadas explícitamente
   por el humano (lee su `/.well-known/ucp` o feed). Devuelve lista
   estructurada: item, description, attributes, price, seller (flag
   verified, domain), site url. Determinista, sin prosa.
2. `get_site({ url })` -> capacidades del sitio (superficies que expone,
   payment handlers, políticas de envío/cancelación si las declara).
3. `create_cart({ site, items[] })` -> cart id + quote (total, expiración,
   stock reservado sí/no).
4. `buy({ cartId, buyerContact?, shipping?, profile? })`
   Flujo: verifica mandato -> checkout -> recibe 402 -> firma auth entry
   -> reintenta con `PAYMENT-SIGNATURE` -> devuelve recibo
   { orderId, txHash, amountUsdc, ledger, ts, sellerOrderRef }.
   Si excede mandato: `MANDATE_EXCEEDED` con detalle, NUNCA paga.
5. `get_order({ site, orderId })` -> estado de la orden en el sitio.
6. `get_spending_log({ since? })` -> registro auditable de gastos.
7. `list_profiles()` (SPEC 07).

## Mandato humano (config del server, no del agente)

`mandate.json` local del usuario: { maxPerTx, maxTotal, period,
allowedSellers?: 'verified-only' | list, requireConfirmAboveUsdc?,
allowPhysicalGoods?: boolean, shippingAddressLocked?: boolean }.
Si `requireConfirmAboveUsdc` aplica: la tool devuelve
`CONFIRMATION_REQUIRED` con la ficha del carrito; el humano confirma fuera
de banda (re-call con token de confirmación). El agente jamás puede
modificar el mandato ni la dirección de envío bloqueada.

## Wallet (ver SPEC 07)

Spending wallet local del comprador (keypair cifrado, passphrase), fondeada
por el humano como tarjeta prepago y acotada por el mandato. Perfiles
múltiples en `~/.agentgate/profiles/<name>.json`. `signerMode:
'local' | 'remote-approval'` reservado (remote = fase Build).
Testnet default; mainnet requiere flag explícito + gate G2.

## Errores machine-readable (catálogo cerrado)

INSUFFICIENT_FUNDS, MANDATE_EXCEEDED, CONFIRMATION_REQUIRED,
SELLER_UNVERIFIED, SITE_UNREACHABLE, CART_EXPIRED, OUT_OF_STOCK,
PAYMENT_REJECTED, ORDER_NOT_CREATED (pago liquidado pero connector falló:
incluye txHash y contacto del vendedor), SPEC_MISMATCH. Cada uno con hint.

## Tests

Unit de mandato (tabla de casos, incl. bienes físicos y dirección
bloqueada). E2e testnet: search -> create_cart -> buy contra la demo-store
del SPEC 01; assert orden en Woo. Fixture de agente: script que usa el
MCP real.
