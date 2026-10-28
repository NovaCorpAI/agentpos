# Guía de operación: una tienda que ya vende a agentes

Para una tienda en producción. Qué revisar cada día, qué significa cada estado de orden y qué
hacer cuando algo sale mal.

Relacionado: [inicio rápido del vendedor](quickstart-merchant.es.md) ·
[inicio rápido del comprador](quickstart-buyer.es.md) · [preguntas frecuentes](faq.es.md) ·
procedimientos alerta por alerta: [RUNBOOK.md](RUNBOOK.md) ·
En inglés: [operations.en.md](operations.en.md)

## La rutina diaria

```bash
npx @agentpos/site status          # artículos, últimas 20 órdenes, hashes, errores de conector
npx @agentpos/site status --retry  # lo mismo, y reintenta las órdenes que fallaron tras el pago
npx @agentpos/site receipts verify # la cadena firmada está intacta
npx @agentpos/site backup ./backups
curl -s https://TU-TIENDA/agentpos/health
```

`/agentpos/health` responde `200` cuando el facilitador está alcanzable y no hay órdenes pagadas
trabadas, y `503` en caso contrario. Trae `facilitator`, `facilitators` (una entrada por
facilitador configurado, solo el host), `orders.stuck` y la altura de la cadena de comprobantes.
Una tienda que también cobra en otra red (Arc, por ejemplo) agrega `networks`: una entrada por
red extra, `ok` o `degraded`. Una red degradada sale del pedido de pago hasta que su facilitador
vuelve, y no convierte la respuesta en `503`: la tienda sigue vendiendo en su propia red.
También al revés: si cae el facilitador de la red propia de la tienda, el cobro ofrece solo las
redes extra. Si ninguna red puede liquidar, el comprador recibe `FACILITATOR_UNAVAILABLE` con
`Retry-After: 60` y no se cobra nada.

## Leer el panel

`https://TU-TIENDA/agentpos/dashboard` es una sola página autocontenida que sirve tu propio
sidecar. Sin CDN, sin fuentes externas, sin analítica. Tres pestañas:

**Métricas** (desde `/agentpos/metrics`, solo agregados, ventanas de 7, 30 o 90 días):

| Dato | Qué cuenta |
| --- | --- |
| órdenes pagadas | órdenes con pago liquidado en la ventana |
| total vendido | suma en USDC |
| wallets pagadoras únicas | direcciones distintas que pagaron |
| agentes identificados | cuántas órdenes traían identidad de agente verificada |
| checkout a orden creada | latencia entre el pago y la orden apareciendo en WooCommerce |
| en revisión | órdenes pagadas cuyos términos liquidados no coincidieron con la cotización |
| por crear en plataforma | órdenes pagadas cuya orden de WooCommerce todavía no se crea |

**Catálogo** (desde `/agentpos/catalog`): tus artículos publicados tal como los recibe un agente.
Si está vacío, confirmaste precios pero no ejecutaste `publish`.

**Reglas** (desde `/agentpos/dashboard/rules`): los límites e interruptores que aplica la tienda.
Es de solo lectura por diseño: las reglas viven en `agentpos.config.json` en tu máquina, así que
nada remoto puede cambiar qué vendes ni a qué precio.

> **Quién lo puede ver.** Todo lo que hay en `/agentpos/dashboard` es público a propósito:
> agregados sin datos de compradores, tu catálogo publicado y las reglas que se aplican a los
> agentes. En métricas el CORS también está abierto a propósito. Nada que identifique a un
> comprador se sirve desde esta ruta. La exportación de conciliación, que sí lleva correos de
> compradores, vive detrás del token del comercio en `/agentpos/api/merchant/export.csv` (sección
> siguiente).

## CSV de conciliación

La exportación son datos privados del comercio, así que exige `MERCHANT_API_TOKEN` (ver
[Rotar el token de la API del comercio](#rotar-el-token-de-la-api-del-comercio)):

```bash
curl -H "Authorization: Bearer $MERCHANT_API_TOKEN" \
  "https://TU-TIENDA/agentpos/api/merchant/export.csv?from=AAAA-MM-DD&to=AAAA-MM-DD" \
  -o conciliacion.csv
```

Rango por defecto: últimos 30 días. Los límites aceptan `AAAA-MM-DD` (días completos) o una marca
de tiempo ISO completa; un rango mal formado o invertido responde `400` con código
`CONFIG_INVALID`, y un token ausente o equivocado responde `401` `MERCHANT_UNAUTHORIZED`.

Una fila por orden, comillas según RFC 4180, saltos CRLF y BOM UTF-8 para que Excel lo abra
directo. Los encabezados siguen tu `locale` (`en` o `es`); el orden de las columnas nunca cambia:

`fecha, orden, orden_externa, estado, items, monto_usdc, riel, activo, hash_transaccion,
liquidado_el, correo_comprador`

`riel` se deriva de la red del pago (hoy `x402-stellar`), así que sumar un segundo riel de pago más
adelante no cambia la forma del archivo.

La pestaña de Métricas del panel no descarga el archivo: te muestra este mismo comando para que lo
copies. El panel de AgentPOS Cloud sí puede descargarlo por ti, porque guarda ese token por tu
cuenta.

## Estados de una orden

| Estado | Qué significa |
| --- | --- |
| `pending_payment` | La orden existe porque un carrito pasó el checkout, pero nada se ha liquidado. Nadie fue cobrado. |
| `paid` | El pago se liquidó en la red. Recién desde aquí se crea la orden en WooCommerce, nunca antes. |
| `fulfilled` | Tu plataforma reporta la orden como completada. El despacho sigue viviendo en WooCommerce; el sidecar solo refleja lo que ella dice. |
| `cancelled` | Tu plataforma reporta la orden como cancelada, reembolsada o fallida. El registro del pago y su comprobante se conservan siempre. |
| `expired` | El carrito venció y nunca se pagó nada. Solo llegan aquí las órdenes sin pago. |

Cada pocos minutos el sidecar vuelve a leer el estado de las órdenes pagadas en tu plataforma y
lo refleja, de la más antigua a la más nueva. El mapeo es corto a propósito: `completed` pasa a
`fulfilled`, y `cancelled`, `refunded` o `failed` pasan a `cancelled`. Cualquier otro estado
(`processing`, `on-hold`, lo que invente un plugin) deja la orden tal cual: el sidecar nunca
adivina qué significa para tu plata un estado que no conoce. Una orden pagada jamás vence por
tiempo, diga lo que diga su carrito.

Dos campos importan tanto como el estado:

- `connectorError` (`{ code, message, attempts }`): pagada, pero WooCommerce rechazó crear la
  orden. La cola de reintentos sigue trabajando.
- `hold` (`{ reason: "PAYMENT_MISMATCH", details, at }`): pagada, pero los términos liquidados no
  coinciden con la cotización. **No se crea la orden en WooCommerce y la cola de reintentos no la
  toca.**

## Una orden en revisión: PAYMENT_MISMATCH

Qué pasó: el facilitador liquidó un pago cuyo destino, activo, monto o red no coincide con lo que
cotizó tu tienda. El pago queda registrado con su hash, la orden queda `paid` con la retención y
se levanta una alerta crítica.

1. `npx @agentpos/site status` e identifica la orden y su `txHash`. Abre el hash en
   `stellar.expert`.
2. Compara `hold.details.mismatch` con la cotización. Los dos casos típicos: se liquidó un monto
   menor (pago parcial) o el destino es otro (el dinero no llegó a tu wallet).
3. Dinero en la wallet correcta y solo difiere el monto: decide con el comprador (devolver la
   diferencia o pedir que complete).
4. Destino distinto: no despaches. Escala el caso.
5. **Nunca crees la orden a mano sin resolver la discrepancia primero**, y deja anotada la
   decisión. La retención y tu decisión ya están en la cadena de comprobantes.

## Pagada, pero sin orden en WooCommerce

El pago se liquidó y la plataforma rechazó la orden. AgentPOS reintenta solo, con espera creciente
(30 s, 1 m, 2 m, ... con tope de 30 minutos) y levanta `ORDER_NOT_CREATED`; si pasa una hora sin
orden, escala a `RETRY_LOOP_STALLED`.

1. `npx @agentpos/site status` muestra la cantidad de intentos y el último error;
   `/agentpos/health` muestra `orders.stuck`.
2. Causas habituales: credenciales REST rotadas o sin permiso de escritura (401/403, no se
   reintenta), tienda caída (5xx, sí se reintenta), producto borrado en WooCommerce.
3. Corrige la causa y fuerza una pasada: `npx @agentpos/site status --retry`.
4. Si la plataforma realmente no puede recibirla, crea la orden a mano con los datos de
   `/agentpos/orders/<id>` (comprador, despacho, hash) y anota el id externo en tu registro.

## Dinero recibido sin orden: PAYMENT_WITHOUT_ORDER

Solo en una tienda que también cobra en otra red (Arc, por ejemplo) cuyo riel trae un vigilante
de pagos. Cada 5 minutos AgentPOS lee lo que tu billetera recibió en esa red y lo compara con los
pagos que registró. Una transferencia que sigue sin orden después de 2 minutos levanta
`PAYMENT_WITHOUT_ORDER` (crítica), una sola vez por transacción, con la red, el hash, quién pagó,
el monto y `candidateOrders`: las órdenes que siguen esperando pago con el mismo total.

1. Abre el hash en el explorador de esa red y confirma que el dinero está en tu billetera.
2. Si calza con una candidata (mismo monto, el comprador que esperabas), la tienda liquidó el pago
   y después no alcanzó a registrarlo: despacha esa orden a mano y anota el hash.
3. Si no calza con ninguna orden, puede ser un ingreso ajeno a la tienda (una transferencia tuya,
   por ejemplo). Si vino de un comprador, reembólsalo. Una billetera dedicada solo a la tienda
   mantiene esta alerta útil.
4. `/agentpos/health` muestra la cuenta en `networks[].reconciliation.paymentsWithoutOrder`, y
   `error` cuando la última pasada no pudo leer la cadena.

## Pago rechazado: PAYMENT_DECLINED

El facilitador rechazó un pago firmado sin dar una razón documentada. En el Facilitator Service de
Circle (Arc, Base, Polygon) así se ve un control de cumplimiento ("screening") que no pasó: Circle
revisa al comprador y al comercio antes de liquidar y no publica un código para ese caso. **Nadie
fue cobrado** y no se creó ninguna orden. El agente recibe `PAYMENT_DECLINED` con la red; no
reintenta, y no lleva el pago a otra red salvo que su humano lo apruebe.

Recibes una alerta de advertencia con ese código, a lo más una vez por hora por red. Una alerta
tras un solo comprador suele ser por ese comprador. Si los compradores siguen siendo rechazados en
la misma red, el control puede ser por tu propia dirección ahí: deja de ofrecer esa red (quítala
de las redes de la tienda) y escribe al soporte del facilitador con tu dirección de comercio.

Los otros rechazos de un pago firmado también le llegan tipados al agente: `INSUFFICIENT_FUNDS`
(a su billetera no le alcanza), `PAYMENT_REJECTED` (una firma vencida, reintentable; o tu
configuración de pago en esa red, no reintentable), `PAYMENT_PENDING` (la liquidación sigue sin
resolverse: no pagar de nuevo) y `FACILITATOR_UNAVAILABLE` (reintentable, `Retry-After: 60`).
Ninguno genera alerta.

## Falló la liquidación

`SETTLEMENT_FAILED` (advertencia): el facilitador verificó el pago pero falló al liquidarlo.
**Nadie fue cobrado.** La orden queda `pending_payment` y el carrito sigue vigente hasta su TTL,
así que el agente simplemente puede intentar de nuevo.

Si se repite en varios carritos: revisa `/agentpos/health` (`facilitator`), tu API key (un `401`
significa que falta o es de la otra red) y el estado del propio facilitador.

Las alertas llegan como líneas JSON en el stderr del sidecar
(`{"event":"alert","code":...}`) y, si configuras `AGENTPOS_ALERT_WEBHOOK`, como un POST JSON
`{ source: "agentpos", code, severity, message, details, at }`.

## Respaldo de facilitador

El facilitador es el servicio que revisa la transacción firmada del comprador y la envía a la red.
Si el tuyo se cae, no hay ventas nuevas (las órdenes ya pagadas no se ven afectadas). Configura un
segundo y la tienda sigue vendiendo.

Por entorno:

```
AGENTPOS_FACILITATOR_URL=...                 # principal
AGENTPOS_FACILITATOR_API_KEY=...
AGENTPOS_FACILITATOR_FALLBACK_URL=...        # respaldo
AGENTPOS_FACILITATOR_FALLBACK_API_KEY=...
```

O en `agentpos.config.json` (tiene prioridad sobre el entorno, hasta cuatro entradas, la primera
es la principal):

```json
{ "facilitators": [{ "url": "https://principal.example", "apiKey": "..." }, { "url": "https://respaldo.example" }] }
```

La verificación y la liquidación de un mismo pago siempre usan el mismo facilitador. Una
liquidación se reintenta en el siguiente solo cuando el primer intento demostrablemente nunca
conectó; cualquier caso ambiguo se va al camino de órdenes trabadas descrito arriba en vez de
arriesgar un doble cobro. `/agentpos/health` lista cada facilitador por host como `ok` o
`degraded` y marca cuál está activo. Con un solo facilitador no cambia nada.

## Reglas para las ventas a agentes

Todas opcionales, todas en `agentpos.config.json`, todas evaluadas al cotizar **y otra vez** antes
de cobrar, porque tu situación puede haber cambiado en el intertanto:

```json
{
  "policy": {
    "status": "active",
    "maxOrderUsdc": "200",
    "maxPeriodUsdc": "1000",
    "period": "daily",
    "maxQuantityPerItem": 5,
    "maxQuantityPerOrder": 20,
    "excludedItems": ["edicion-limitada"],
    "allowedShippingCountries": ["CL", "AR"],
    "approvalThresholdUsdc": "100"
  }
}
```

- `status: "suspended"` detiene de inmediato toda venta a agentes sin tocar tu catálogo y sin
  afectar a tus clientes humanos.
- `period` es `hourly`, `daily` o `weekly`. El acumulador cuenta las órdenes liquidadas **más** las
  que esperan aprobación, así que una ráfaga de órdenes sin aprobar no puede pasarse en conjunto de
  tu límite.
- Los `excludedItems` se siguen vendiendo a humanos.
- Cada rechazo le llega al agente con un código sobre el que puede actuar: `POLICY_SUSPENDED`,
  `POLICY_ITEM_EXCLUDED`, `POLICY_ITEM_QUANTITY`, `POLICY_ORDER_QUANTITY`, `POLICY_ORDER_LIMIT`,
  `POLICY_PERIOD_LIMIT`, `POLICY_SHIPPING_COUNTRY`.

### Órdenes que te esperan

Sobre `approvalThresholdUsdc` la orden queda en espera en vez de ser rechazada: el agente recibe
un `202` con una URL para consultar y **no se le cobra** mientras decides.

```bash
npx @agentpos/site approvals                              # qué está esperando
npx @agentpos/site approvals approve <id>
npx @agentpos/site approvals reject <id> -r "sin stock"
```

Configuración y secretos:

```json
{ "approvals": { "enabled": true, "ttlMinutes": 30, "webhookUrl": "https://tu-sistema.example/hooks/agentpos", "whatsapp": { "from": "whatsapp:+14155238886", "to": "whatsapp:+56912345678" } } }
```

```
AGENTPOS_APPROVAL_SECRET=<cadena larga y aleatoria>
AGENTPOS_APPROVAL_WEBHOOK_SECRET=<secreto del webhook>
AGENTPOS_TWILIO_ACCOUNT_SID=AC...
AGENTPOS_TWILIO_AUTH_TOKEN=...
```

Tres garantías: **el silencio rechaza**, nunca aprueba (el TTL vence la solicitud y libera la
cotización); **apruebas exactamente lo que viste** (el detalle queda con hash, y cualquier cambio
anula la aprobación); **nadie puede aprobar por ti** (las resoluciones por HTTP deben ir firmadas
con `AGENTPOS_APPROVAL_SECRET`; sin él el sidecar responde `401` y solo la CLI local puede
decidir).

### Quién puede comprar

`{ "identity": { "mode": "open" | "identified" | "verified-only" } }`. En todos los modos, una
firma que llega se verifica; lo que cambia el modo es qué pasa cuando no hay identidad. Revocar es
inmediato, incluso para carritos ya cotizados:

```bash
npx @agentpos/site agents                                 # quién puede comprar
npx @agentpos/site agents register ./attestation.json
npx @agentpos/site agents revoke GAGENT... -r "llave perdida"
```

## Rotar el token de la API del comercio

`MERCHANT_API_TOKEN` es el token del dueño de la tienda para la API de solo lectura
(`GET /agentpos/api/merchant/summary | orders | orders/:id | receipts | receipts/:seq | rules |
export.csv`). Mínimo 24 caracteres; sin él esas rutas ni siquiera se montan, incluida la
exportación de conciliación. Trátalo como una contraseña: puede leer tus órdenes, incluidos los
correos de compradores.

**No hay comando de rotación**: rotar es editar el entorno y reiniciar.

```bash
openssl rand -hex 24                     # token nuevo
# ponlo en .env como MERCHANT_API_TOKEN=... y reinicia el sidecar:
#   node:    detén `agentpos serve` y vuelve a levantarlo
#   docker:  docker restart agentpos
curl -H "Authorization: Bearer <token nuevo>" https://TU-TIENDA/agentpos/api/merchant/summary
```

Actualiza a todos los que lo usan (AgentPOS Cloud, tus propias herramientas). El token viejo deja
de servir apenas reinicia el sidecar. Un token ausente o equivocado responde `401`
`MERCHANT_UNAUTHORIZED`; el grupo tiene límite de tasa (`rateLimit.merchantApiPerMinute`, 120/min
por defecto) con `429` y `Retry-After`. Los registros guardan un hash de 8 caracteres del token,
nunca el token.

## Comprobantes, y cómo cualquiera verifica uno

Cada venta **y cada rechazo** dejan un comprobante firmado, encadenado al anterior: qué se ofreció,
a qué precio, qué dijeron tus reglas, quién aprobó, quién compró y el hash de la transacción.
Eventos que se escriben: `order.settled`, `order.held`, `order.failed`, `policy.denied`,
`approval.requested`, `approval.resolved` (incluido el vencimiento que nadie decidió).

Dónde viven:

- La cadena está en tu base SQLite, `<dataDir>/agentpos.sqlite` (por defecto `.agentpos/`).
- La llave que firma es `<dataDir>/receipt-signer.json`, creada en el primer uso salvo que definas
  `AGENTPOS_RECEIPT_SECRET`. **Respáldala junto con la base de datos.** Solo firma declaraciones:
  no tiene fondos y nunca debe recibirlos. Si la pierdes, los comprobantes antiguos siguen siendo
  verificables, pero la cadena arranca de nuevo con otra llave.

```bash
npx @agentpos/site receipts                      # comprobantes recientes, altura, llave firmante
npx @agentpos/site receipts verify               # ¿la cadena está intacta?
npx @agentpos/site receipts export --from 2026-08-01 --to 2026-08-31 -o agosto.json
```

El comprador recibe su propia copia en `GET /agentpos/orders/<orderId>/receipt`, y un comprobante
suelto también se puede pedir por hash en `/agentpos/receipts/<hash>`.

**La verificación es local y no necesita a nadie.** Un comprobante es JSON: se recalcula SHA-256
sobre el JSON canónico de `body` y se compara `signature` contra `body.store.signer` (Ed25519). En
código:

```ts
import { verifyReceipt, verifyChain, verifyPaymentOnChain } from "@agentpos/receipts";

verifyReceipt(receipt);              // esquema, hash, firma, consistencia interna
verifyChain(receipts);               // secuencia, enlace, una sola llave firmante
await verifyPaymentOnChain(receipt); // opcional: ¿la red concuerda con el dinero?
```

Las dos primeras funcionan sin conexión y son totales. La tercera es la única que necesita red, y
si Horizon no responde devuelve *desconocido*, nunca *inválido*. El formato está especificado para
terceros en [`packages/receipts/SPEC.md`](../packages/receipts/SPEC.md) y
[`specs/extensions/agent-commerce-receipts.md`](../specs/extensions/agent-commerce-receipts.md).

Escribir un comprobante nunca te puede costar una venta: si la cadena no se puede escribir, la
orden igual se completa y el hueco aparece en `receipts verify`. Si tienes un motivo, se apaga con
`{ "receipts": { "enabled": false } }`.

## Mantenimiento de rutina

- **Respaldo:** `npx @agentpos/site backup ./backups` (SQLite `VACUUM INTO`, consistente en
  caliente). Restaurar es copiar el archivo sobre `<dataDir>/agentpos.sqlite` con el sidecar
  detenido. Respalda también la llave que firma los comprobantes.
- **Actualizar:** detén el sidecar, instala la versión nueva, arranca. El esquema de la base es
  aditivo; las bases anteriores se abren sin migración.
- **Rotar credenciales de WooCommerce:** edita `.env`, reinicia el sidecar y ejecuta
  `npx @agentpos/site status --retry` para empujar lo que haya fallado mientras tanto.
- **Registros:** `AGENTPOS_LOG_FORMAT=json` (el valor por defecto en `serve`) para agregadores,
  `pretty` para consola. Cada línea lleva un `traceId` que sigue una compra completa por escaneo,
  catálogo, carrito, checkout, liquidación y creación de la orden. Busca por ahí.
- **Pausar:** `{ "policy": { "status": "suspended" } }` detiene las ventas a agentes con la tienda
  arriba. Detener el sidecar también sirve, y deja tu tienda tal como estaba.

## Operar tu propio facilitador

`apps/facilitator`, en este repositorio, es un facilitador mínimo construido sobre los SDK
oficiales. Si lo operas, **pagas tus propias comisiones de red** desde una cuenta dedicada que
tiene XLM y nada más (medido: unos 0,0023 XLM por venta). Sus procedimientos de operación,
incluidos el fondeo de esa cuenta y la rotación de llaves, están en [RUNBOOK.md](RUNBOOK.md) y en
`apps/facilitator/README.md`.
