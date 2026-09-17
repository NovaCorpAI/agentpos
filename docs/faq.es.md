# Preguntas frecuentes de vendedores

Respuestas cortas a lo que realmente preguntan los comercios. Los comandos y la configuración
están en el [inicio rápido del vendedor](quickstart-merchant.es.md) y en la
[guía de operación](operations.es.md). En inglés: [faq.en.md](faq.en.md)

## ¿Necesito entender de cripto?

No. Necesitas tres cosas: una dirección de wallet para recibir el dinero, un precio en USDC para
cada artículo que quieras que compren los agentes, y tu WooCommerce de siempre para despachar. El
panel y la CLI hablan de órdenes, pagos, saldo y comprobantes.

USDC es una moneda estable en dólares: un USDC está pensado para valer un dólar estadounidense. Si
tu catálogo está en USD, AgentPOS sugiere el precio uno a uno y tú lo confirmas. Si está en otra
moneda, el precio en USDC lo pones tú, porque solo tú sabes a qué tipo de cambio quieres vender.

## ¿Quién tiene mi dinero?

Tú, siempre. El pago va del comprador a **tu** wallet dentro de una sola transacción. No lo tenemos
nosotros, no lo tiene el facilitador y no hay ninguna cuenta intermedia. El sidecar se niega
incluso a arrancar si aparece una llave privada en su configuración, así que no puede estar
guardando fondos por accidente.

Tú eres el vendedor de registro en cada venta. No cobramos comisión y no somos parte del contrato
entre tú y el comprador.

## ¿Y si el agente paga un monto equivocado?

Entonces no se crea ninguna orden. Un pago cuyo destino, activo, monto o red no coincide con lo que
cotizaste deja la orden **en revisión** (`PAYMENT_MISMATCH`), el pago queda registrado con su hash
y te llega una alerta crítica. Nada se despacha hasta que tú decidas.

En general: la orden en WooCommerce se crea **solo después** de que el pago se liquida en la red, y
es idempotente por hash de transacción, así que un reintento nunca produce dos órdenes. Si la
liquidación falla después de la verificación, nadie es cobrado. Procedimientos:
[operación](operations.es.md#una-orden-en-revisión-payment_mismatch).

## ¿Puedo rechazar las ventas a agentes, o pausarlas?

Sí, en cuatro niveles distintos:

- **Por artículo:** solo lo que confirmas y publicas es visible para los agentes. Todo lo demás se
  sigue vendiendo a humanos como siempre.
- **Por regla:** `policy` fija máximos por orden y por período, topes de cantidad, artículos
  excluidos y los países que aceptas.
- **Por orden:** sobre `approvalThresholdUsdc` la orden espera tu aprobación, y al agente no se le
  cobra mientras decides. El silencio rechaza, nunca aprueba.
- **Todo de una vez:** `{ "policy": { "status": "suspended" } }` detiene las ventas a agentes de
  inmediato, sin tocar tu catálogo ni a tus clientes humanos. Detener el sidecar también sirve, y
  deja tu tienda tal como estaba.

## ¿Conservo mis medios de pago actuales?

Sí. AgentPOS agrega rutas, no reemplaza nada. Tu checkout, tu pasarela de tarjetas, tus
transferencias y tus clientes humanos quedan intactos. Las órdenes de agentes llegan a la misma
lista de órdenes de WooCommerce, ya pagadas, con `payment_method = agentpos`, el hash en
`transaction_id` y metadatos `_agentpos_*` para distinguirlas.

## ¿Qué pasa si AgentPOS desaparece?

Nada de lo que no puedas recuperarte.

- El sidecar, la CLI, los conectores, la capa de confianza, el comprador y los formatos son código
  abierto **Apache-2.0**. Los puedes seguir usando, bifurcando o auditando pase lo que nos pase.
- Corre **en tu servidor**, en tu dominio, contra tu propia base de datos. En el camino del pago no
  hay ninguna llamada a nosotros.
- Tus **comprobantes se verifican sin nosotros**: un comprobante es JSON firmado por la llave de tu
  propia tienda, y verificarlo es SHA-256 más Ed25519 contra el firmante que va dentro del
  comprobante. Ninguna API nuestra participa. El formato está publicado como especificación para
  terceros.
- Tu dinero ya está en tu wallet, no en un saldo que tengamos nosotros.

El servicio pagado que viene (AgentPOS Cloud: panel gestionado, archivo de comprobantes a largo
plazo) se construye encima de esos formatos, nunca delante de ellos. Una tienda que jamás nos pague
un peso es una tienda plenamente funcional y plenamente descubrible.

## ¿Mi catálogo queda expuesto a la competencia?

Solo lo que publicas, y solo lo que ya mostrabas. `/agentpos/catalog` y `/agentpos/feed` contienen
los artículos que confirmaste, con las descripciones y precios que fijaste: los mismos datos de tus
páginas públicas de producto, en un formato que un agente puede leer. Lo que no confirmas nunca se
expone, y `excludedItems` mantiene un artículo a la venta para humanos mientras lo oculta a los
agentes.

Lo que **no** se expone: datos de compradores. `/agentpos/metrics` y el panel son agregados por
construcción, sin correos, sin direcciones y sin ids de orden.

El único archivo que sí lleva correos de compradores es la exportación de conciliación, y nunca es
pública: `GET /agentpos/api/merchant/export.csv` exige tu `MERCHANT_API_TOKEN`, y sin ese token la
ruta ni siquiera se monta. Ver [operación](operations.es.md#csv-de-conciliación).

## ¿Impuestos y facturación?

**Esto no es asesoría legal ni tributaria, y depende de tu jurisdicción y de tus propios
sistemas.**

Lo que hace AgentPOS: crea una orden pagada normal en tu WooCommerce, con el monto, los artículos y
el hash de la transacción. Todo lo que ya haces con una orden (boleta, factura, documento
tributario, exportación contable) aplica igual, por el mismo plugin o proceso que usas hoy.

Lo que AgentPOS no hace: no emite documentos tributarios, no decide el tratamiento tributario de un
pago con moneda estable y no convierte nada a tu moneda local. Esas preguntas son de tu contador.
Un adaptador fiscal conectable (para facturación electrónica por país) está planificado y queda
deliberadamente fuera del camino del pago; **hoy no existe en el código**, así que trata la
facturación exactamente como con cualquier otra orden pagada.

Para conciliar, la exportación CSV le entrega a tu contador una fila por orden con fecha, ids,
estado, artículos, monto bruto en USDC, riel, activo, hash de transacción, momento de liquidación y
correo del comprador. La descargas con el token de tu comercio:

```bash
curl -H "Authorization: Bearer $MERCHANT_API_TOKEN" \
  "https://TU-TIENDA/agentpos/api/merchant/export.csv?from=2026-09-01&to=2026-09-30" \
  -o conciliacion.csv
```

Ver [operación](operations.es.md#csv-de-conciliación).

## ¿Tengo que usar mainnet?

No, y no deberías partir por ahí. Todo funciona en testnet con dinero de prueba gratis, que es como
verificas el ciclo completo antes de que se mueva un dólar real. Mainnet exige un
`AGENTPOS_ALLOW_MAINNET=true` explícito, una llave de facilitador de mainnet y una URL de RPC
explícita: el sidecar se niega a llegar a producción adivinando.

## ¿Cualquier agente puede comprar, de quien sea?

Lo decides tú. Por defecto cualquier wallet puede comprar lo que publicaste, que es lo que quiere
la mayoría de las tiendas. Si necesitas saber quién está del otro lado, la tienda puede exigir que
los agentes firmen sus solicitudes y traigan una atestación de su dueño (`identity.mode`). Reduce
el anonimato; no es KYC y no recopila datos personales.

## ¿Dónde pido ayuda?

- Instalación: [inicio rápido del vendedor](quickstart-merchant.es.md)
- Tienda en producción: [guía de operación](operations.es.md)
- Procedimientos alerta por alerta: [RUNBOOK.md](RUNBOOK.md)
- Qué es abierto y qué no: [open-core.es.md](open-core.es.md)
- Verlo funcionando: <https://demo.agentposhq.com> · <https://agentposhq.com>
