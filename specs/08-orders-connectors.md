# SPEC 08: Órdenes, checkout y connectors (`@agentpos/connectors`)

## Objetivo

Que un pago on-chain se convierta en una orden REAL en el sistema que el
vendedor ya usa, con stock descontado y datos de entrega, sin que el
vendedor cambie su operación. Sin esto, el pago llega y la tienda no se
entera: es la parte difícil del producto y va en v1.

## Máquina de estados de la orden

```
cart (TTL 15 min, reserva opcional)
  -> quote (total USDC, expira con el cart)
  -> checkout: 402 x402 con términos (payTo, amount, asset USDC, network,
     memo = order id provisional)
  -> PAYMENT-SIGNATURE recibida -> verify (facilitador)
  -> settle (facilitador) -> tx_hash                      [punto de no retorno]
  -> orden `paid` local -> connector.createOrder()
       ok  -> `paid` con external_order_id -> 200 + recibo al agente
       err -> `paid` + connector_error -> 200 + recibo con
              ORDER_NOT_CREATED (el pago existe; reintento automático con
              backoff; alerta al vendedor; botón reintentar en dashboard)
  -> `fulfilled` / `cancelled` los marca la plataforma; se leen por sync
cart expirado sin pago -> `expired`, libera reserva
```

Guardrail 6: nunca crear orden sin settle. Idempotencia por tx_hash y por
memo. Si llega un pago sin cart vigente (agente lento, cart expiró), se
registra como `unmatched_payment` y se notifica; nunca se descarta.

## Interfaz `OrderConnector` (core)

```
interface OrderConnector {
  platform: 'shopify' | 'woocommerce' | 'generic'
  listProducts(cursor?)                    // para scanner (fuente 1)
  getAvailability(items[])                 // stock y precio en tiempo real
  reserve?(items[], ttl)                   // opcional; si no existe, no se reserva
  release?(reservationId)
  createOrder(order: PaidOrder)            // devuelve external_order_id
  getOrderStatus(external_order_id)
}
```

Todo error `{ code, message, hint }` con `retryable: boolean`.

## Connector WooCommerce (v1, prioritario)

- WooCommerce REST API v3 con consumer key/secret (guardados cifrados en el
  servidor del vendedor).
- `createOrder`: `POST /wp-json/wc/v3/orders` con `set_paid: true`,
  `payment_method: "agentpos"`, `payment_method_title: "Stablecoin (USDC on
Stellar)"`, `transaction_id: tx_hash`, `meta_data` con amount_usdc,
  network, ledger, memo, agente. Línea de items por product_id/variation_id.
  Billing/shipping desde `buyerContact`/`shipping`.
- Stock: Woo descuenta al crear la orden; `reserve` v1 = no-op (ventana de
  15 min aceptada como riesgo documentado; reserva real en Build vía
  plugin PHP).
- Sidecar es el modo por defecto (Woo es PHP).

## Connector Shopify (v1, segundo)

- Admin API GraphQL, versión trimestral fijada en adapter. Custom app con
  scopes `read_products, write_orders, read_inventory`.
- `createOrder`: `orderCreate` con `financialStatus: PAID`,
  `transactions[{ kind: SALE, status: SUCCESS, gateway: "agentpos_usdc_stellar",
amount }]`, `customAttributes` con tx_hash/network/memo, `sourceName:
"agentpos"`. Verificar en la versión vigente el soporte de gateway
  custom en `orderCreate`; fallback: `draftOrderCreate` + `draftOrderComplete`
  con `paymentPending: false`.
- `reserve`: `inventoryAdjustQuantities` o reserva vía draft order.
- Dev store para e2e nightly.

## Connector genérico (hook)

```
createAgentPOS({ connector: {
  platform: 'generic',
  listProducts: async () => [...],          // opcional (si no, solo scan)
  getAvailability: async (items) => [...],
  createOrder: async (paidOrder) => ({ externalOrderId }),
}})
```

Para stacks custom. Documentado con ejemplos Express y Next.

## Datos del comprador

`buyerContact` (email obligatorio para bienes físicos, opcional para
digitales/servicios) y `shipping` (obligatorio si el item es `physical`).
Validación zod; el sitio decide qué campos exige vía manifiesto (SPEC 09).

## Tests

- Máquina de estados: tabla de casos incl. settle ok + connector falla,
  pago tardío con cart expirado, doble entrega del mismo tx_hash.
- Woo: e2e contra apps/demo-store en CI (orden visible vía REST y admin).
- Shopify: e2e nightly contra dev store.
- Genérico: unit con hook mock.
