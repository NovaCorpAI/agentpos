# Inicio rápido para vendedores: vender a agentes de IA en menos de 30 minutos

Para un comercio que ya tiene una tienda **WooCommerce**. Al final, tu tienda responde tráfico de
agentes en tu propio dominio, cobra USDC sobre Stellar y la orden pagada aparece en tu
administrador de WooCommerce como cualquier otra.

Relacionado: [inicio rápido del comprador](quickstart-buyer.es.md) ·
[guía de operación](operations.es.md) · [preguntas frecuentes](faq.es.md) ·
En inglés: [quickstart-merchant.en.md](quickstart-merchant.en.md)

## Lo que no cambia

- AgentPOS agrega rutas nuevas (`/agentpos/*`, `/.well-known/ucp`, `/openapi.json`, `/llms.txt`).
  No toca ninguna de tus páginas, temas, plugins ni medios de pago actuales.
- Los pagos llegan **directo a tu wallet**. Nunca tenemos tu dinero y no cobramos comisión.
- Nada se publica sin que lo confirmes, artículo por artículo y precio por precio.
- Si detienes el sidecar, tu tienda queda exactamente como estaba.

## Antes de empezar (5 min)

| Necesitas                                                 | Dónde                                                                                                                                         |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Una máquina que pueda correr un proceso junto a tu tienda | Node.js >= 22.5, o Docker                                                                                                                     |
| Una tienda WooCommerce con HTTPS                          | tuya                                                                                                                                          |
| Una llave REST de WooCommerce, Lectura/Escritura          | ver paso 1                                                                                                                                    |
| Una dirección Stellar que controles (`G...` o `C...`)     | Lobstr, Freighter, xBull...                                                                                                                   |
| Una API key del facilitador                               | testnet: <https://channels.openzeppelin.com/testnet/gen> (sin registro); mainnet: <https://channels.openzeppelin.com/gen> (con cuenta GitHub) |

> **De dónde se instala.** Los paquetes todavía no están publicados en npm (el repositorio es
> privado hasta la semana del lanzamiento). Hasta entonces se instala desde el repo:
> `pnpm install && pnpm build`, y ejecutas `node packages/site/bin/agentpos.js <comando>` donde
> esta guía escribe `npx @agentpos/site <comando>`. Después del lanzamiento las dos formas son
> equivalentes y el binario instalado se llama `agentpos`.

## 1. Llave REST de WooCommerce (3 min)

Admin de WP -> **WooCommerce -> Ajustes -> Avanzado -> API REST -> Añadir clave**.
Descripción `agentpos`, tu usuario administrador, permisos **Lectura/Escritura**, Generar.

Copia la **Clave del cliente** (`ck_...`) y el **Secreto del cliente** (`cs_...`). Se muestran una
sola vez. Con esa llave AgentPOS lee tus productos y crea las órdenes pagadas. Nada más. La
puedes revocar desde la misma pantalla cuando quieras.

## 2. Levantar el sidecar

### Opción A: Node (lo más simple en el servidor de la tienda)

```bash
mkdir agentpos && cd agentpos
npx @agentpos/site init
```

`init` pregunta: la URL pública de tu sitio, el nombre que ven los agentes, dónde viven las
órdenes (`WooCommerce`), la URL de WooCommerce y tu dirección Stellar. Escribe
`agentpos.config.json` y crea el `.env` con los campos por llenar.

Existe `init --generate-wallet` como alternativa: crea un par de llaves local cifrado. Es mejor
vincular una wallet que ya controles, porque AgentPOS solo necesita tu dirección **pública**.

### Opción B: Docker

El repositorio trae la misma imagen que corre la tienda demo pública
([`apps/demo-store/deploy/Dockerfile.sidecar`](../apps/demo-store/deploy/Dockerfile.sidecar)),
construida desde la raíz del monorepo:

```bash
docker build -f apps/demo-store/deploy/Dockerfile.sidecar -t agentpos-sidecar .
```

La imagen corre como el usuario `node` (nunca root), trabaja desde `/data` y su comando por
defecto es `agentpos serve` en el puerto 8402. Deja `agentpos.config.json`, `.env` y el directorio
de datos `.agentpos` en el volumen montado, y asegúrate de que ese directorio sea escribible por
el uid 1000:

```bash
mkdir -p /srv/agentpos && chown -R 1000:1000 /srv/agentpos
# comandos puntuales (init, scan, confirm, publish) reemplazan el comando por defecto:
docker run --rm -it -v /srv/agentpos:/data agentpos-sidecar \
  node /app/packages/site/bin/agentpos.js init
# el sidecar permanente:
docker run -d --name agentpos --restart unless-stopped \
  -p 127.0.0.1:8402:8402 -v /srv/agentpos:/data agentpos-sidecar
```

Si partes de cero, el archivo compose completo con WordPress, MariaDB y el sidecar (el despliegue
real de <https://demo.agentposhq.com>) está en
[`apps/demo-store/deploy/docker-compose.prod.yml`](../apps/demo-store/deploy/docker-compose.prod.yml).

### Opción C: generar los archivos desde un formulario

`@agentpos/merchant-web` es un asistente de cuatro pasos que escribe los mismos dos archivos por
ti: URL y nombre de la tienda con una prueba en vivo de tus llaves de WooCommerce, tu dirección de
wallet (si pegas un secreto se rechaza al instante), el `agentpos.config.json` y el `.env`
generados para descargar, y los fragmentos de proxy junto con la lista de verificación. También
genera la llave que necesita tu panel (`MERCHANT_API_TOKEN`, ver paso 3), te la muestra en el
paso 4 con un botón para copiarla y puede comprobarla contra tu tienda en vivo.

```bash
pnpm --filter @agentpos/merchant-web dev    # http://localhost:8410 (PORT para cambiarlo)
```

Es sin estado a propósito: sin cuentas, sin base de datos, sin nada guardado en el servidor. Tus
llaves se usan para exactamente una prueba contra tu propia tienda y vuelven dentro del `.env`
generado. Los comandos del paso 5 los sigues ejecutando tú.

## 3. Llenar el `.env` (2 min)

```
AGENTPOS_NETWORK=testnet
AGENTPOS_FACILITATOR_API_KEY=<tu llave del facilitador>
AGENTPOS_WOO_CONSUMER_KEY=ck_...
AGENTPOS_WOO_CONSUMER_SECRET=cs_...
MERCHANT_API_TOKEN=<la llave de tu panel>
```

**La llave de tu panel.** `MERCHANT_API_TOKEN` es la llave que deja al panel de AgentPOS leer tus
órdenes. Es de solo lectura: con ella se pueden ver tus órdenes, tus comprobantes y tus reglas, y
nada más. No puede mover tu dinero, ni cambiar tus precios, ni publicar artículos. El asistente
de la opción C te escribe una; si llenaste el `.env` a mano, crea la tuya con
`openssl rand -hex 24` (mínimo 24 caracteres, o AgentPOS se niega a arrancar). Cuando tu tienda
esté funcionando, conéctala al panel en app.agentposhq.com con la dirección de tu tienda y esta
llave. Si la pierdes, escribe otra en esa línea, reinicia AgentPOS y vuelve a conectar el panel:
la anterior deja de servir en ese mismo momento. Si dejas la línea fuera, el panel simplemente no
tiene nada que leer.

Las llaves son por red, así que puedes mantener las dos y cambiar de red sin riesgo:
`AGENTPOS_FACILITATOR_API_KEY_TESTNET` y `AGENTPOS_FACILITATOR_API_KEY_MAINNET` tienen prioridad
sobre la genérica. La lista completa de variables, comentada, está en
[`.env.example`](../.env.example).

Los secretos viven en el `.env` de tu servidor y en ningún otro lugar. El sidecar se niega a
arrancar si `agentpos.config.json` contiene una llave secreta de Stellar (`SECRET_IN_CONFIG`).

## 4. `agentpos.config.json`: los campos que importan

`init` escribe los primeros cinco. El resto tiene valores por defecto que funcionan y solo los
tocas si quieres.

| Campo                 | Por defecto                 | Para qué sirve                                                                                                                                                                                                                                                                                                           |
| --------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `siteUrl`             | (se pregunta)               | La URL pública de tu tienda. Todas las URLs para agentes se construyen desde ella.                                                                                                                                                                                                                                       |
| `displayName`         | (se pregunta)               | El nombre que ven los agentes.                                                                                                                                                                                                                                                                                           |
| `payTo`               | (se pregunta)               | La dirección Stellar que recibe cada pago. Solo dirección pública.                                                                                                                                                                                                                                                       |
| `platform`            | `none`                      | `woocommerce`, `generic` (tu propio hook `createOrder`) o `none` (órdenes solo locales).                                                                                                                                                                                                                                 |
| `woocommerce.baseUrl` | (se pregunta)               | Tu URL de WordPress. Exige HTTPS (`allowInsecureHttp` es para demos locales).                                                                                                                                                                                                                                            |
| `basePath`            | `/agentpos`                 | Prefijo de todas las rutas de AgentPOS.                                                                                                                                                                                                                                                                                  |
| `cartTtlMinutes`      | `15`                        | Cuánto vive una cotización antes de expirar.                                                                                                                                                                                                                                                                             |
| `dataDir`             | `.agentpos`                 | Base SQLite local, borradores y la llave que firma los comprobantes.                                                                                                                                                                                                                                                     |
| `locale`              | `en`                        | Idioma del panel y de los encabezados del CSV de conciliación (`en` o `es`).                                                                                                                                                                                                                                             |
| `policies`            | (sin valor)                 | Tus textos de despacho, devoluciones, cancelación y contacto, publicados en el manifiesto UCP.                                                                                                                                                                                                                           |
| `policy`              | vender todo                 | Límites para las ventas a agentes: ver [operación](operations.es.md#reglas-para-las-ventas-a-agentes).                                                                                                                                                                                                                   |
| `approvals`           | activado, 30 min            | Deja las órdenes grandes esperando tu decisión en vez de rechazarlas.                                                                                                                                                                                                                                                    |
| `identity`            | `open`                      | Si los agentes deben probar quiénes son.                                                                                                                                                                                                                                                                                 |
| `receipts`            | activado                    | Comprobante firmado de cada venta y de cada rechazo.                                                                                                                                                                                                                                                                     |
| `rateLimit`           | 60/min carritos y checkouts | Límites por IP, más 10 intentos de pago por carrito.                                                                                                                                                                                                                                                                     |
| `facilitators`        | (sin valor)                 | Lista ordenada, el primero es el principal, para respaldo. Ver [operación](operations.es.md#respaldo-de-facilitador).                                                                                                                                                                                                    |
| `fiatCurrency`        | (sin valor)                 | Moneda ISO 4217 de tus precios de origen (`CLP`, `USD`). Con ella cada carrito lleva también su total en pesos, sumado de los precios que el escáner leyó, sin ninguna conversión. Es lo que cobra un riel de tarjeta.                                                                                                   |
| `transbank`           | (sin valor)                 | Riel de tarjeta para Chile, con TUS credenciales de Transbank en `.env` (`TRANSBANK_COMMERCE_CODE`, `TRANSBANK_API_KEY`). `environment` (`integration` o `production`) y, para recompras sin el comprador presente, `oneclick.mallCode` y `oneclick.childCommerceCode`. Sin este bloque la tienda cobra solo con wallet. |

## 5. Escanear, confirmar, publicar (10 min)

```bash
npx @agentpos/site scan       # lee TU tienda y propone un catálogo. No publica nada.
npx @agentpos/site confirm    # revisas cada artículo y fijas su precio en USDC
npx @agentpos/site publish    # verifica el riel de pago y expone el catálogo
```

- `scan` lee tus productos por la API de WooCommerce más tu sitemap y tus páginas, e imprime una
  línea por artículo con el precio de origen y un precio sugerido en USDC. Opciones:
  `--max-pages <n>` (200 por defecto) y `--no-llm`. **Solo lee tu propio dominio.**
- Los **productos variables** de WooCommerce se expanden en un artículo por variación comprable,
  con su propio SKU, precio y stock. Una orden pagada de una variación llega a Woo con la variante
  exacta.
- `confirm` es interactivo, artículo por artículo; `confirm --all` acepta de una vez todos los
  precios sugeridos (solo los artículos que recibieron uno). El precio en USDC siempre lo decide
  una persona.
- `publish` falla con un mensaje claro si falta la llave del facilitador o no corresponde a la
  red, y valida las superficies de descubrimiento contra los esquemas oficiales fijados antes de
  exponer nada.

Después, deja el sidecar corriendo:

```bash
npx @agentpos/site serve            # puerto 8402, todas las interfaces
npx @agentpos/site serve -p 8402 -H 127.0.0.1
```

## 6. Enrutar cuatro rutas desde tu dominio

El sidecar tiene que responder en **tu** dominio, no en un puerto. Con nginx:

```nginx
location /.well-known/ucp { proxy_pass http://127.0.0.1:8402; }
location /agentpos/       { proxy_pass http://127.0.0.1:8402; }
location = /openapi.json  { proxy_pass http://127.0.0.1:8402; }
location = /llms.txt      { proxy_pass http://127.0.0.1:8402; }
```

Con Caddy:

```
handle /.well-known/ucp { reverse_proxy 127.0.0.1:8402 }
handle /agentpos/* { reverse_proxy 127.0.0.1:8402 }
handle /openapi.json { reverse_proxy 127.0.0.1:8402 }
handle /llms.txt { reverse_proxy 127.0.0.1:8402 }
```

`/openapi.json` y `/llms.txt` son lo primero que leen los directorios x402 y los rastreadores: si
faltan, los agentes pueden comprarte pero no te van a encontrar.

## 7. Lista de verificación

Contra tu dominio real. Sin capturas de pantalla y sin creernos nada:

```bash
curl -s https://TU-TIENDA/.well-known/ucp      | head    # manifiesto UCP con el medio de pago
curl -s https://TU-TIENDA/agentpos/catalog     | head    # tus artículos publicados, en USDC
curl -s https://TU-TIENDA/openapi.json         | head    # cómo te descubre un agente
curl -s https://TU-TIENDA/agentpos/health                # ok: true, facilitador alcanzable
open   https://TU-TIENDA/agentpos/dashboard              # tu panel de ventas

# la llave de tu panel: 200 con ella, 401 sin ella. Las dos respuestas importan.
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $MERCHANT_API_TOKEN" \
  https://TU-TIENDA/agentpos/api/merchant/summary
curl -s -o /dev/null -w '%{http_code}\n' https://TU-TIENDA/agentpos/api/merchant/summary
```

Un `404` en esa última dirección significa que tu tienda corre una versión antigua de AgentPOS:
actualízala y vuelve a levantar `agentpos serve`. Un `401` con la llave significa que la llave
que enviaste no es la que está en el `.env` con el que corre tu tienda.

También se sirven, sin configurar nada: `/agentpos/feed` (catálogo ACP), `/agentpos/mcp` (punto
MCP), `/llms.txt` y `/agentpos/metrics`.

Si `/agentpos/health` responde `503`, lee los campos `facilitator` y `orders.stuck` y sigue con la
[guía de operación](operations.es.md).

## 8. Probar una compra real (testnet)

El agente comprador de referencia hace exactamente lo que haría el agente de un desconocido:

```bash
# solo descubrimiento y cotización, sin wallet y sin fondos:
npx @agentpos/mcp-buyer demo https://TU-TIENDA --dry-run

# una compra real en testnet, después de crear un perfil de comprador:
npx @agentpos/mcp-buyer init
npx @agentpos/mcp-buyer demo https://TU-TIENDA --item <itemId> -q 1
```

Si la corrida en seco termina justo antes del pago, tu tienda está lista. Una corrida real imprime
el hash de la transacción y un enlace a `stellar.expert`. Verifica tres cosas:

1. La orden está en tu WooCommerce como **Procesando**, ya pagada, con
   `payment_method = agentpos`, `transaction_id = <hash>` y metadatos `_agentpos_*`. La despachas
   como cualquier otra.
2. Los USDC están en **tu** wallet.
3. El hash es público en `stellar.expert`.

La configuración completa del comprador está en el
[inicio rápido del comprador](quickstart-buyer.es.md). También puedes apuntar el comprador a
nuestra tienda demo pública, <https://demo.agentposhq.com>, pero ojo: corre en **mainnet**, así
que una compra ahí sin `--dry-run` gasta dinero real.

## Cuánto cuesta

- **Testnet: gratis.** El XLM de prueba viene de friendbot (el `init` del comprador lo llama por
  ti) y el USDC de prueba de <https://faucet.circle.com>.
- **Mainnet:** el comprador paga en USDC; la comisión de red por enviar el pago la paga el
  facilitador (el público de Built on Stellar la patrocina; si operas el tuyo, el costo medido es
  de unos 0,0023 XLM por venta). Tu wallet necesita un saldo pequeño de XLM (unos 2 XLM) para
  existir y poder recibir USDC: se compra una vez, dentro de la app de la wallet.
- **AgentPOS no cobra nada.** Sin comisión, sin cuota de publicación, sin porcentaje de tus
  ventas. Nunca tocamos el dinero: va del comprador a tu wallet dentro de una sola transacción.
- Mainnet además exige `AGENTPOS_ALLOW_MAINNET=true`, una llave de facilitador de mainnet y un
  `AGENTPOS_RPC_URL` explícito. El sidecar no adivina ninguno de los tres.

## Cuando algo se ve mal

Todos los errores de AgentPOS traen un código legible por máquina, un mensaje y una sugerencia.
Los tres más comunes durante la instalación:

| Síntoma                             | Causa habitual                                    | Solución                                                   |
| ----------------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| `401` al escanear                   | llave REST mal pegada, o sin permiso de escritura | revisa `AGENTPOS_WOO_CONSUMER_KEY` / `_SECRET` en `.env`   |
| `publish` falla en el riel de pago  | falta la llave del facilitador o es de otra red   | revisa `AGENTPOS_FACILITATOR_API_KEY` y `AGENTPOS_NETWORK` |
| los agentes no encuentran la tienda | faltan las rutas en el proxy                      | paso 6, después `curl https://TU-TIENDA/agentpos/health`   |

Para una tienda que ya vende (órdenes en revisión, liquidaciones trabadas, respaldo de
facilitador, conciliación, comprobantes) sigue con la **[guía de operación](operations.es.md)**.
Las dudas de negocio, sin comando de por medio, están en las
**[preguntas frecuentes](faq.es.md)**.
