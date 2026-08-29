# Quickstart: de WooCommerce a tienda comprable por agentes en 15 minutos (testnet)

AgentGate corre junto a tu sitio, lee tu catálogo, lo publica en los formatos que los agentes
de IA entienden, cobra USDC sobre Stellar y crea la orden en tu WooCommerce. Sin marketplace y
sin custodia: los pagos llegan directo a tu wallet y tú sigues siendo el vendedor de registro.

## Qué necesitas

- Node.js 22.5 o superior en el servidor (o en cualquier máquina que llegue a tu tienda).
- Una tienda WooCommerce con HTTPS y una clave REST: WooCommerce > Ajustes > Avanzado >
  API REST > Añadir clave, permisos **Lectura/Escritura**.
- Una dirección Stellar que controles (Freighter, Lobstr, xBull...) para recibir los pagos.
- Una API key gratuita del facilitador para testnet: https://channels.openzeppelin.com/testnet/gen
  (se muestra una sola vez; guárdala).

## 1. Instalar e inicializar

```bash
mkdir agentgate-sidecar && cd agentgate-sidecar
npx @agentgate/site init
```

Responde: URL del sitio, nombre de la tienda, `WooCommerce`, URL de la tienda, tu dirección
Stellar. El comando escribe `agentgate.config.json` y un `.env` con los campos vacíos. Complétalo:

```
AGENTGATE_NETWORK=testnet
AGENTGATE_FACILITATOR_API_KEY=<de channels.openzeppelin.com>
AGENTGATE_WOO_CONSUMER_KEY=ck_...
AGENTGATE_WOO_CONSUMER_SECRET=cs_...
```

## 2. Escanear

```bash
npx @agentgate/site scan
```

AgentGate lee los productos por la API de WooCommerce y por tu sitemap, e imprime "esto
entendí": una línea por producto con el precio de origen y un precio sugerido en USDC (1:1 en
tiendas en USD; en otras monedas lo defines tú). Todavía no se publica nada.

## 3. Confirmar

```bash
npx @agentgate/site confirm        # interactivo, producto por producto
npx @agentgate/site confirm --all  # acepta todos los precios sugeridos (tiendas en USD)
```

Tú decides qué productos pueden comprar los agentes y a qué precio en USDC, siempre.

## 4. Publicar y servir

```bash
npx @agentgate/site publish
npx @agentgate/site serve --port 8402
```

`publish` valida el facilitador con tu key y marca como publicados los productos confirmados.
`serve` levanta el sidecar. Redirige dos rutas de tu dominio hacia él (reverse proxy):

```
/.well-known/ucp   -> http://127.0.0.1:8402/.well-known/ucp
/agentgate/*       -> http://127.0.0.1:8402/agentgate/*
```

Ejemplo nginx:

```nginx
location /.well-known/ucp { proxy_pass http://127.0.0.1:8402; }
location /agentgate/      { proxy_pass http://127.0.0.1:8402; }
```

## 5. Qué ven los agentes

| URL                                                  | Para qué                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `https://tu-sitio/.well-known/ucp`                   | Manifiesto UCP de descubrimiento con el handler de pago `x402-stellar`                           |
| `https://tu-sitio/agentgate/catalog`                 | Productos publicados, precios en USDC, búsqueda con `?q=`                                        |
| `https://tu-sitio/agentgate/feed`                    | Feed de productos ACP                                                                            |
| `https://tu-sitio/agentgate/mcp`                     | Servidor MCP: `search_items`, `get_item`, `create_cart`, `get_order`, `get_payment_instructions` |
| `POST https://tu-sitio/agentgate/cart`               | Cotización para `{ items, buyer, shipping }`                                                     |
| `POST https://tu-sitio/agentgate/checkout?cart=<id>` | Checkout x402: 402 con términos, luego pago                                                      |
| `https://tu-sitio/agentgate/orders/<id>`             | Estado de la orden, hash de la transacción, número de orden en WooCommerce                       |

Cuando un agente paga, el facilitador liquida en Stellar y la orden aparece en WooCommerce en
estado **Procesando**, pagada con `payment_method = agentgate`, `transaction_id = <hash Stellar>`
y metadatos `_agentgate_*`. La despachas como cualquier otra orden.

## Poner reglas a las ventas agénticas (opcional)

Puedes limitar qué te compran los agentes desde `agentgate.config.json`, en el bloque `policy`.
Las reglas se evalúan al cotizar y **otra vez** antes de cobrar, porque tu situación pudo cambiar:

```json
{
  "policy": {
    "status": "active",
    "maxOrderUsdc": "200",
    "maxPeriodUsdc": "1000",
    "period": "daily",
    "maxQuantityPerItem": 5,
    "excludedItems": ["edicion-limitada"],
    "allowedShippingCountries": ["CL", "AR"],
    "approvalThresholdUsdc": "100"
  }
}
```

- `status: "suspended"` corta todas las ventas a agentes sin tocar tu catálogo.
- `excludedItems` son productos que sigues vendiendo a personas, pero no a agentes.
- Sobre `approvalThresholdUsdc` la orden queda **pendiente de tu aprobación y no se cobra**.
- El acumulado del período cuenta lo ya vendido más lo pendiente de aprobar, para que una ráfaga
  de órdenes sin aprobar no supere tu límite entre todas.

Cada rechazo llega al agente con un código que puede entender (`POLICY_ORDER_LIMIT`,
`POLICY_PERIOD_LIMIT`, `POLICY_ITEM_EXCLUDED`, `POLICY_SHIPPING_COUNTRY`...) y un mensaje que le
dice qué hacer.

## Aprobar órdenes grandes a mano (opcional)

Cuando una orden supera `approvalThresholdUsdc`, en vez de rechazarla el sidecar la **deja en
espera** y te avisa. El agente recibe un `202` con una URL para consultar, y **no se le cobra nada**
mientras decides.

```json
{
  "approvals": {
    "enabled": true,
    "ttlMinutes": 30,
    "webhookUrl": "https://tu-sistema.cl/hooks/agentgate",
    "whatsapp": { "from": "whatsapp:+14155238886", "to": "whatsapp:+56912345678" }
  }
}
```

En `.env`:

```
AGENTGATE_APPROVAL_SECRET=<clave larga y aleatoria>
AGENTGATE_APPROVAL_WEBHOOK_SECRET=<clave del webhook>
AGENTGATE_TWILIO_ACCOUNT_SID=AC...
AGENTGATE_TWILIO_AUTH_TOKEN=...
```

Decidir desde la terminal:

```bash
npx @agentgate/site approvals                       # lista lo que espera tu decisión
npx @agentgate/site approvals approve <id>
npx @agentgate/site approvals reject <id> -r "sin stock"
```

Tres garantías que conviene que sepas:

- **El silencio rechaza, nunca aprueba.** Si no decides antes del TTL, la orden se rechaza sola y
  la cotización se libera.
- **Apruebas exactamente lo que viste.** Ítems, cantidades, montos, destino y datos de envío quedan
  firmados en una foto inmutable. Si algo cambia después, la aprobación se invalida y el agente
  debe recotizar.
- **Nadie puede aprobar por ti.** Las resoluciones por HTTP van firmadas con tu clave secreta;
  sin firma válida, la respuesta es 401. Aprobar dos veces no cambia la primera decisión.

## Decidir quién puede comprar (opcional)

Por defecto compra cualquiera que tenga una billetera, que es lo que la mayoría de las tiendas
quiere. Si necesitas saber quién está al otro lado, el sidecar puede exigir que los agentes
**firmen sus peticiones** y que traigan una **atestación de su dueño** ("esta llave actúa por mí").

```json
{ "identity": { "mode": "identified" } }
```

| Modo | Qué significa |
| --- | --- |
| `open` (por defecto) | Compra cualquiera. Si llega una firma, igual se verifica y se registra. |
| `identified` | Lo mismo, pero queda registrado en cada orden quién compró. |
| `verified-only` | Solo compran agentes con una atestación vigente y no revocada de su dueño. |

En todos los modos, una firma que llega **se verifica**: una identidad a medias es peor que
ninguna. Lo que cambia el modo es qué pasa cuando no hay identidad.

El registro se maneja desde la terminal:

```bash
npx @agentgate/site agents                                  # quiénes pueden comprar
npx @agentgate/site agents register ./attestation.json      # respaldado por su dueño
npx @agentgate/site agents revoke GAGENT... -r "llave perdida"
```

Dos cosas que conviene saber:

- **La revocación es inmediata.** El registro se lee en cada petición y otra vez al momento de
  pagar, así que una llave revocada después de cotizar no alcanza a completar la compra.
- **Esto no es KYC.** Sabes qué llave actúa por qué dueño, nada más: sin documentos, sin datos
  personales. Reduce el anonimato, no lo elimina.

Los agentes firman con [RFC 9421 HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421.html),
el estándar que usa el ecosistema x402, así que cualquier cliente compatible funciona sin
aprender nada propio de AgentGate. El perfil completo está en `packages/identity/SPEC.md`.

## Guardar prueba de cada venta (activo por defecto)

Cada orden deja un **comprobante firmado**, encadenado al anterior: qué se ofreció, a qué precio,
qué dijeron tus reglas, quién aprobó, quién compró y el hash de la transacción. Los rechazos
también dejan comprobante, porque "eso no lo vendimos" también es algo que puedes necesitar
mostrar.

```bash
npx @agentgate/site receipts                 # comprobantes recientes, altura de la cadena, llave
npx @agentgate/site receipts verify          # esta intacta la cadena?
npx @agentgate/site receipts export --from 2026-08-01 --to 2026-08-31 -o agosto.json
```

El comprador recibe su copia en `GET /agentgate/orders/<orderId>/receipt` y puede verificarla sin
preguntarte nada.

Tres cosas que conviene saber:

- **Un comprobante nunca te va a costar una venta.** Si no se puede escribir, la orden igual se
  completa y el hueco aparece en `receipts verify`.
- **Alterar un comprobante se nota.** Si lo cambias se rompe su hash; si lo vuelves a firmar, el
  siguiente sigue apuntando al hash viejo.
- **Respalda la llave de firma** (`.agentgate/receipt-signer.json`) junto con tu base de datos. No
  guarda dinero y jamas debe recibirlo. Si la pierdes, los comprobantes antiguos siguen siendo
  verificables, pero la cadena parte de nuevo con otra llave.

Para desactivarlo: `{ "receipts": { "enabled": false } }`.

## Ver el estado

```bash
npx @agentgate/site status          # productos, órdenes recientes, errores del conector
npx @agentgate/site status --retry  # reintenta crear en WooCommerce las órdenes que fallaron tras el pago
```

## Probarlo con un agente real (testnet)

El repositorio incluye un script end-to-end que hace de agente: escanea, publica, crea un
carrito, paga a través del facilitador real y verifica la orden en WooCommerce:

```bash
pnpm demo:up              # WooCommerce local con productos de ejemplo
pnpm e2e:testnet          # requiere AGENTGATE_FACILITATOR_API_KEY en .env
```

## Qué facilitador usar, y quién paga las comisiones de red

Un pago x402 en Stellar lo liquida un **facilitador**: un servicio que revisa la transacción
firmada por el comprador y la envía a la red, pagando la (mínima) comisión de red. Tu tienda
habla con uno a través de dos variables:

```
AGENTGATE_FACILITATOR_URL=...
AGENTGATE_FACILITATOR_API_KEY=...
```

Puedes apuntarlas a cualquier facilitador. Dos que conviene conocer:

- **Built on Stellar (hospedado).** `https://channels.openzeppelin.com/x402` para mainnet,
  `.../x402/testnet` para testnet. Keys en https://channels.openzeppelin.com/gen. Él pone las
  comisiones. Al 2026-08-29 su verificación en mainnet falla para todos los integradores que
  conocemos (reportado); testnet funciona.
- **El tuyo.** `apps/facilitator` en este repo es un facilitador mínimo sobre los SDK oficiales.
  Si lo corres, **las comisiones las pagas tú**, desde una cuenta aparte que guarda XLM y nada
  más. Costo medido: unos 0,0023 XLM por venta. Se niega a arrancar sin lista de activos
  permitidos, sin API keys y (en mainnet) sin un RPC explícito.
  `pnpm --filter @agentgate/facilitator keygen` crea la cuenta de comisiones sin imprimir jamás
  su secreto. Guía completa en `apps/facilitator/README.md`.

Uses el que uses, el dinero sigue yendo comprador → tu billetera dentro de una sola transacción.
El facilitador nunca lo retiene, y nosotros tampoco. AgentGate no opera un facilitador para
comercios: el que corremos es para nuestras pruebas y nuestra tienda demo.

## Pasar a mainnet

Mainnet está bloqueado tras `AGENTGATE_ALLOW_MAINNET=true` y un facilitador que liquide
`stellar:pubnet`. Ver `plan/ROADMAP.md`, gate G2.
