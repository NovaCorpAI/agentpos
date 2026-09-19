# Inicio rápido del comprador: darle a tu agente una wallet que no puede abusar

Configurar el lado comprador: una wallet local, un **mandato** que el agente no puede editar y el
servidor MCP con el que Claude (o cualquier cliente MCP) descubre, cotiza y compra en tiendas
comprables por agentes.

Relacionado: [inicio rápido del vendedor](quickstart-merchant.es.md) ·
[guía de operación](operations.es.md) · [preguntas frecuentes](faq.es.md) ·
En inglés: [quickstart-buyer.en.md](quickstart-buyer.en.md)

## La regla que nunca se dobla

**La llave de la wallet nunca sale de tu máquina.** Se guarda cifrada en `~/.agentpos/keys/` y se
descifra con tu frase de paso solo en el proceso que paga. Ningún servidor nuestro, y tampoco un
servidor tuyo (incluido el espacio web del comprador que se describe más abajo), la tiene nunca.
Todo lo que "aprueba" una compra en otra parte solo la deja en cola: el pago igual ocurre local.

> Los paquetes todavía no están en npm (el repositorio es privado hasta la semana del
> lanzamiento). Hasta entonces se ejecutan desde el repo: `pnpm install && pnpm build` y luego
> `node packages/mcp-buyer/bin/agentpos-buyer.js <comando>` donde esta guía escribe
> `npx @agentpos/mcp-buyer <comando>`. El binario instalado se llama `agentpos-buyer`.

## 1. Probarlo sin wallet

```bash
npx @agentpos/mcp-buyer demo https://demo.agentposhq.com --dry-run
```

El agente de referencia descubre la tienda como lo haría un desconocido, cotiza un carrito real y
se detiene antes de pagar. No instala nada y no gasta nada.

## 2. Crear un perfil

```bash
npx @agentpos/mcp-buyer init                       # perfil "default", testnet
npx @agentpos/mcp-buyer init --profile trabajo --network mainnet
```

`init` pide una frase de paso (con ella cifra la wallet) y después lo básico del mandato: máximo
por pago, máximo por día, el monto sobre el cual debe preguntarte primero, si se permiten
productos físicos y, en ese caso, la dirección de despacho y el correo que quedan fijos. Crea la
wallet, escribe `~/.agentpos/profiles/<nombre>.json` y, en testnet, fondea la cuenta con XLM de
prueba a través de friendbot.

## 3. El mandato

El mandato vive en `~/.agentpos/profiles/<nombre>.json` y el agente no lo puede cambiar: se evalúa
antes de cualquier firma, en cada compra.

| Campo | Qué significa |
| --- | --- |
| `maxPerTx` | Tope duro por pago individual, en USDC. |
| `maxTotal` + `period` | Tope de todo lo gastado dentro de `day`, `week` o `month`. |
| `allowedSellers` | `"any"` (por defecto) o una lista de hostnames. |
| `requireConfirmAboveUsdc` | Sobre ese monto el agente tiene que pedirte confirmación aparte. |
| `allowPhysicalGoods` | Si el agente puede comprar cosas que se despachan. |
| `shippingAddressLocked` | Si es verdadero, el agente no puede poner una dirección: se usa la del perfil. |

`init` no pregunta por `allowedSellers`: edita el archivo JSON para restringirlo, por ejemplo
`"allowedSellers": ["demo.agentposhq.com"]`.

Existía un tercer valor, `"verified-only"`. Consultaba un registro alojado de vendedores que
nunca se construyó, así que rechazaba todos los sitios del mundo. Ya no existe. Un perfil que
todavía lo tenga se carga como `"allowedSellers": []`, que rechaza todo igual, y el comprador
imprime una advertencia `MANDATE_MODE_RETIRED` que te dice cómo cambiarlo: la lista de hostnames
en los que confías, o `"any"`. Nada reescribe tu perfil por ti.

La lista de tiendas por defecto se maneja aparte:

```bash
npx @agentpos/mcp-buyer sites add https://shop.example
npx @agentpos/mcp-buyer sites list
npx @agentpos/mcp-buyer sites remove https://shop.example
```

Cuando el agente choca con un límite recibe un rechazo tipado sobre el que puede razonar, nunca un
fallo silencioso: `MANDATE_EXCEEDED`, `SELLER_UNVERIFIED` o `CONFIRMATION_REQUIRED`. Para el
último caso:

```bash
npx @agentpos/mcp-buyer pending            # carritos esperando tu decisión
npx @agentpos/mcp-buyer approve <cartId>   # después, dile al agente que lo intente de nuevo
```

## 4. Fondear

**Testnet (gratis).** `init` llama a friendbot y consigue XLM de prueba. Para USDC de prueba usa
<https://faucet.circle.com>. Si la tienda cobra en USDC, con XLM de prueba no basta: consigue
también USDC de prueba.

**Mainnet.** Envía USDC desde tu propia wallet a la dirección que imprimió `init`. Trátala como
una tarjeta de prepago: pon lo que estás dispuesto a que gaste un agente, no tus ahorros. La
cuenta además necesita un saldo pequeño de XLM (unos 2 XLM) para existir y poder mantener USDC.

Todo lo que paga el agente queda registrado en
`~/.agentpos/profiles/<nombre>.spending.jsonl`:

```bash
npx @agentpos/mcp-buyer log     # cada pago, con monto, tienda, id de orden y hash
```

## 5. Una compra real

```bash
npx @agentpos/mcp-buyer demo https://shop.example
npx @agentpos/mcp-buyer demo https://shop.example --item <itemId> -q 2 --note "grabado: Ana"
npx @agentpos/mcp-buyer demo https://shop.example --json        # corrida en formato máquina
```

Sin `--item` compra el artículo publicado más barato. Imprime cada paso (descubrimiento,
cotización, política, pago, liquidación, comprobante) y termina con el hash de la transacción y un
enlace a `stellar.expert` que puedes revisar por tu cuenta.

<https://demo.agentposhq.com> es nuestra tienda demo pública y corre en **mainnet**: sin
`--dry-run`, una compra ahí gasta dinero real.

## 6. Conectarlo a un cliente MCP

```bash
npx @agentpos/mcp-buyer serve --profile default    # servidor MCP sobre stdio
```

Configuración para Claude Desktop / Claude Code:

```json
{
  "command": "agentpos-buyer",
  "args": ["serve", "--profile", "default"],
  "env": { "AGENTPOS_BUYER_PASSPHRASE": "<tu frase de paso>" }
}
```

Herramientas que ve el agente: `list_profiles`, `search_offers`, `get_site`, `create_cart`, `buy`,
`get_order`, `get_spending_log`. `buy` evalúa el mandato antes de firmar nada, así que lo peor que
puede lograr un agente es que lo rechacen.

## 7. El espacio web del comprador (opcional)

`@agentpos/buyer-web` es una página autoalojada donde una persona mira y decide lo que hace el
agente: estado del mandato con barra de presupuesto, búsqueda de ofertas y propuestas para aprobar
o rechazar. Tres páginas detrás de tu acceso: `/` (inicio y editor del mandato),
`/proposals`, `/activity`, más `/login` y `/setup`.

```bash
pnpm --filter @agentpos/buyer-web dev     # http://localhost:8788
```

| Variable | Para qué sirve |
| --- | --- |
| `BUYER_WEB_PORT` | Puerto. Por defecto `8788`. |
| `BUYER_WEB_DB` | Archivo SQLite. Por defecto `~/.agentpos/buyer-web.sqlite`. |
| `AGENTPOS_NETWORK` | `testnet` (por defecto) o `mainnet`. |
| `SIGNER_TOKEN` | Activa el puente de firma en `/api/signer/*`. Mínimo 24 caracteres (`openssl rand -hex 24`). Sin él esas rutas no existen. |
| `BUYER_WEB_OWNER_EMAIL` + `BUYER_WEB_OWNER_PASSWORD_HASH` | Cuenta del dueño para despliegues automatizados. Las dos o ninguna, y siempre un hash scrypt, nunca la contraseña. |

En esta aplicación no hay, a propósito, ninguna variable para una llave de wallet ni para una
frase de paso. Pegar un secreto (`S...`) en el campo de wallet se rechaza con `SECRET_IN_CONFIG`.

### Entrar: una cuenta, la tuya

Esta página puede subir tus límites de gasto y aprobar pagos que después firma tu máquina, así
que tiene su propio acceso. La primera vez que la abres, todo te lleva a `/setup`: ahí creas la
única cuenta de dueño (correo y contraseña de 12 caracteres o más, escrita dos veces) y quedas
dentro. Desde ese momento `/setup` responde 404 para siempre. Hazlo apenas levantes el servicio:
mientras no exista la cuenta, la crea quien llegue primero.

- La contraseña se guarda solo como hash scrypt (sal propia por cuenta, comparación en tiempo
  constante). Nadie, ni tú, puede leerla desde la base de datos.
- La sesión es una fila en el servidor y la cookie lleva solo su id (`HttpOnly`,
  `SameSite=Strict`, `Secure` sobre https). Dura 12 horas sin uso y se renueva mientras
  trabajas; `Salir` borra la fila y la cookie deja de valer en todas partes.
- Un correo desconocido y una contraseña equivocada reciben la misma respuesta ("correo o
  contraseña incorrectos"): nada revela qué cuentas existen. Tras varios intentos fallidos el
  acceso se bloquea un rato y responde 429 con `Retry-After`.
- **Aprobar pide la contraseña de nuevo** (sobre `requireConfirmAboveUsdc`, y en cualquier monto
  si no fijaste ese umbral), con el monto y la tienda escritos al lado del campo. La sesión
  sigue abierta para lo demás.
- En `/activity` hay un panel **Accesos**: entradas, intentos fallidos y aprobaciones, con la
  fecha, un hash corto de la IP y el navegador. Sirve para responder "¿estuvo alguien más aquí?".
- Las rutas de WhatsApp y `/api/signer/*` no cambian: se autentican solas en cada petición (la
  firma del proveedor y el token del firmador), así que Twilio y tu vigilante siguen igual.

Para un despliegue automatizado, genera el hash con el código del propio paquete (la contraseña
se escribe por la entrada estándar, nunca como argumento, para que no quede en el historial):

```bash
pnpm --filter @agentpos/buyer-web hash-password    # escribe la contraseña, copia el scrypt$...
```

y pon el resultado en `BUYER_WEB_OWNER_PASSWORD_HASH` junto con `BUYER_WEB_OWNER_EMAIL`. El par
manda en cada arranque: crea la cuenta si no existe y la reemplaza si cambia, cerrando todas las
sesiones abiertas. Así se recupera el acceso si pierdes la contraseña. Poner la contraseña en
claro en `BUYER_WEB_OWNER_PASSWORD` se rechaza con `SECRET_IN_CONFIG`.

Si marcas "Permitir bienes físicos" en el mandato, el editor abre la sección "Dirección de
despacho" y el servidor la exige completa: nombre de quien recibe, dirección (línea 1), ciudad,
código postal, país (ISO de dos letras) y tu correo de contacto. Falta cualquiera de esos campos
y el guardado se rechaza con `SHIPPING_REQUIRED` diciendo cuál falta, porque la tienda no puede
despachar sin eso. Con los bienes físicos desactivados la dirección es opcional y, si ya estaba
guardada, se conserva. En las páginas solo se muestran la ciudad y el país; la dirección completa
viaja únicamente a la tienda donde compras y nunca aparece en el historial ni en los registros.
Un perfil antiguo que permita bienes físicos sin dirección muestra un aviso en el inicio y sus
propuestas físicas se rechazan de inmediato, en vez de fallar al momento de pagar.

### WhatsApp

Las mismas cinco operaciones por WhatsApp: buscar, proponer, aprobar, rechazar, estado. Las rutas
se montan solo cuando está el conjunto completo de variables de un proveedor, y aprobar por
WhatsApp igual deja la propuesta en "aprobada, en espera de firma".

| Variable | Para qué sirve |
| --- | --- |
| `WHATSAPP_ALLOWED_NUMBERS` | Lista blanca en E.164 separada por comas (`+56912345678`). **Obligatoria** si hay un proveedor configurado; cualquier otro número recibe un rechazo cortés y después es ignorado. |
| `META_VERIFY_TOKEN` | Una cadena que eliges tú; el saludo GET de Meta debe coincidir. Webhook: `/whatsapp/meta`. |
| `META_APP_SECRET` | Verifica cada POST como HMAC-SHA256 del cuerpo crudo (`X-Hub-Signature-256`). |
| `META_ACCESS_TOKEN` | Token permanente con el que se envían las respuestas. |
| `META_PHONE_NUMBER_ID` | El número de WhatsApp que responde. Las cuatro variables de Meta, o ninguna. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Credenciales de Twilio (el sandbox es la demo más rápida). Webhook: `/whatsapp/twilio`. |
| `TWILIO_FROM_NUMBER` | Por ejemplo `whatsapp:+14155238886`. |
| `TWILIO_WEBHOOK_URL` | La URL pública exacta a la que Twilio hace POST; sobre ella se calcula `X-Twilio-Signature`, lo que importa detrás de un proxy o un túnel. Las cuatro variables de Twilio, o ninguna. |

Comandos, en español con alias en inglés: `buscar <texto>` / `search`, `comprar <n> [cantidad]` /
`buy`, `si` / `yes`, `no`, `estado` / `status`, `ayuda` / `help`. Son credenciales de mensajería:
no pueden mover dinero.

### El puente de firma

Aprobar en la web o en WhatsApp solo **encola** la compra. La paga la máquina que tiene la wallet:

```bash
export AGENTPOS_SIGNER_TOKEN=<el mismo valor que SIGNER_TOKEN>   # solo entorno, nunca una bandera
export AGENTPOS_BUYER_PASSPHRASE=<tu frase de paso>
npx @agentpos/mcp-buyer watch https://tu-buyer-web.example         # consulta cada 15 s
npx @agentpos/mcp-buyer watch https://tu-buyer-web.example -i 30   # cada 30 s
npx @agentpos/mcp-buyer watch https://tu-buyer-web.example --once  # una pasada, para cron
```

`AGENTPOS_SIGNER_TOKEN` se lee solo del entorno, a propósito: una bandera `--token` se filtraría a
la lista de procesos. El token autoriza tu propio demonio de firma contra tu propia instancia de
buyer-web; no puede aprobar propuestas y no es un secreto de wallet.

El vigilante paga por el mismo camino que una compra directa, así que el mandato local se sigue
aplicando (la cola no es un atajo), y se niega a pagar más de lo que aprobaste
(`REQUOTE_REQUIRED`). Informa cada resultado de vuelta a buyer-web (`/api/signer/paid`,
`/api/signer/failed`) y nunca reintenta en bucle una propuesta fallida.

## Guardar la prueba

Las tiendas que emiten comprobantes entregan la copia del comprador en
`GET https://shop.example/agentpos/orders/<orderId>/receipt`. Guárdala: dice qué se ofreció, a qué
precio, bajo qué reglas y qué se liquidó, firmado por la tienda. La puedes verificar después sin
preguntarle nada a la tienda ni a nosotros. Ver
[operación: comprobantes](operations.es.md#comprobantes-y-cómo-cualquiera-verifica-uno).
