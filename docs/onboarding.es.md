# Onboarding de una tienda WooCommerce (guía asistida)

Objetivo: de "tienda WooCommerce que vende en pesos" a "tienda comprable por agentes de IA en
mainnet" en **menos de 30 minutos acompañado** (menos de 15 si eres dev). Esta guía es la que
usamos en el piloto; cada paso tiene su presupuesto de tiempo y al final hay una verificación
que no depende de nuestra palabra.

**Qué NO pasa al instalar esto**, dicho antes que nada:

- Nadie toca tu tienda actual: AgentGate agrega rutas nuevas (`/agentgate/*`), no modifica las
  existentes. Tus clientes humanos no notan nada.
- Nadie custodia tu dinero: los pagos llegan **directo a tu billetera Stellar**, en USDC. No hay
  cuenta intermedia, no hay comisión de AgentGate.
- Nada se publica sin tu confirmación: el escáner propone, **tú fijas cada precio** y decides qué
  se publica.
- Te puedes bajar cuando quieras: apagas el sidecar y tu tienda queda exactamente como estaba.

## Necesitas tener a mano

| Cosa | Dónde |
| --- | --- |
| Acceso admin a WordPress | tu tienda |
| Un servidor donde correr un proceso (el mismo de la tienda sirve) | Node 22.5+ o Docker |
| Acceso a la configuración del proxy/servidor web (nginx, Apache, Caddy o Cloudflare) | tu hosting |
| Un teléfono para la billetera | App Store / Play Store |

Durante el piloto la instalación es desde un paquete que te entregamos nosotros (el repo se abre
públicamente en el lanzamiento); el resto de la guía es idéntico.

## Paso 1 (5 min): tu billetera Stellar

Aquí llega tu plata. Es tuya, nosotros nunca vemos la llave.

1. Instala **Lobstr** (lobstr.co) y crea una billetera.
2. **Guarda la frase de recuperación en papel.** Si la pierdes, nadie puede recuperarla; si
   alguien la ve, puede sacar tus fondos. Es tu responsabilidad y de nadie más.
3. Activa USDC: en Lobstr, "Assets" → busca **USDC (Circle)** → agregar. Necesitas ~2 XLM de
   saldo para activar la cuenta y esa línea (Lobstr te deja comprar el mínimo con tarjeta).
4. Copia tu **dirección pública** (empieza con `G...`). Eso es lo único que nos vas a dar.

> Convertir USDC a pesos: Lobstr permite intercambiar y retirar hacia exchanges que operan en
> Chile. Lo vemos juntos al final si te interesa; no es requisito para vender.

## Paso 2 (5 min): clave REST de WooCommerce

Con esto AgentGate crea las órdenes en tu admin (y nada más: puedes revocarla cuando quieras).

1. WP Admin → **WooCommerce → Ajustes → Avanzado → API REST → Añadir clave**.
2. Descripción `agentgate`, usuario tu admin, permisos **Lectura/Escritura** → Generar.
3. Copia la **Consumer key** (`ck_...`) y el **Consumer secret** (`cs_...`). Se muestran una sola
   vez.

## Paso 3 (5 min): instalar y configurar el sidecar

En tu servidor:

```bash
npx agentgate init
```

Te pregunta, en este orden: URL pública de tu tienda, nombre, **tu dirección `G...` del paso 1**,
plataforma (`woocommerce`) y la URL del sitio WordPress. Después crea un `.env` donde pegas:

```
AGENTGATE_WOO_CONSUMER_KEY=ck_...
AGENTGATE_WOO_CONSUMER_SECRET=cs_...
AGENTGATE_NETWORK=mainnet
AGENTGATE_ALLOW_MAINNET=true
AGENTGATE_FACILITATOR_URL=...      # te lo damos en el piloto (ver nota abajo)
AGENTGATE_FACILITATOR_API_KEY=...
```

> **Nota del piloto:** el facilitador es el servicio que envía los pagos a la red Stellar y paga
> la comisión de red (~$0,002 por venta). Durante el piloto usamos el de NovaCorp sin costo. Es
> intercambiable por config: puedes apuntar al público de Built on Stellar o correr el tuyo
> cuando quieras, y tu tienda no cambia en nada.

## Paso 4 (5 min): escanear, poner precios, publicar

```bash
npx agentgate scan       # lee TU tienda (solo la tuya) y propone el catálogo
npx agentgate confirm    # revisas cada ítem y fijas su precio en USDC; nada sale sin tu ok
npx agentgate publish    # valida el riel de pago y expone el catálogo
npx agentgate serve      # deja el sidecar corriendo en :8402
```

Regla simple para el precio piloto: precio en pesos ÷ valor del dólar, redondeado a favor
tuyo. Lo puedes cambiar cuando quieras con `confirm`.

## Paso 5 (5 min): una regla en tu proxy

Tu dominio tiene que redirigir dos rutas al sidecar. Con nginx:

```nginx
location /.well-known/ucp { proxy_pass http://127.0.0.1:8402; }
location /agentgate/       { proxy_pass http://127.0.0.1:8402; }
location = /openapi.json   { proxy_pass http://127.0.0.1:8402; }
location = /llms.txt       { proxy_pass http://127.0.0.1:8402; }
```

(`agentgate serve` imprime el snippet exacto para nginx, Caddy, Apache y Cloudflare.)

## Paso 6 (5 min): verificación, sin confiar en nadie

```bash
# 1. Tu tienda se describe sola a los agentes:
curl https://TU-TIENDA/openapi.json | head

# 2. Un agente real la recorre entera SIN pagar (lo corremos nosotros o tú):
npx agentgate-buyer demo https://TU-TIENDA --dry-run
```

Si el `demo` termina en "Dry run: stopping before payment", tu tienda está lista. La primera
compra real la hacemos juntos, con un producto barato, y verificas tres cosas:

1. La orden aparece en tu WooCommerce con el hash de la transacción.
2. Los USDC aparecen en **tu** Lobstr (no en ninguna cuenta nuestra).
3. El hash es público: `stellar.expert/explorer/public/tx/<hash>`.

## Tu dashboard

`https://TU-TIENDA/agentgate/dashboard` muestra tus ventas a agentes: órdenes por día, total,
latencia, compradores únicos. Solo agregados (ni un correo, ni una dirección) y se sirve desde
**tu** dominio, así que puedes compartirlo o no, como cualquier página tuya.

## Comandos del día a día

```bash
npx agentgate status              # órdenes, hashes, errores
npx agentgate approvals           # órdenes grandes esperando tu ok (si activas ese umbral)
npx agentgate receipts verify     # tu cadena de comprobantes está intacta
npx agentgate backup              # respaldo de la base local
```

## Si algo sale mal

Cada error de AgentGate trae un código y una acción sugerida. Los tres más comunes en el arranque:

| Síntoma | Causa típica | Arreglo |
| --- | --- | --- |
| `401` al escanear | clave REST mal pegada | revisar `ck_`/`cs_` en `.env` |
| `publish` falla en el riel de pago | facilitador o red mal configurados | revisar `AGENTGATE_FACILITATOR_*` |
| El agente no encuentra la tienda | proxy sin las rutas | paso 5; probar `curl https://TU-TIENDA/agentgate/health` |

Y para todo lo demás, estamos en el piloto contigo: escríbenos y lo resolvemos en conjunto.
