# Runbook del sidecar AgentPOS

Alertas llegan como líneas JSON `{"event":"alert","code":...}` en stderr del sidecar y, si está
configurado `AGENTPOS_ALERT_WEBHOOK`, como POST JSON `{ source: "agentpos", code, severity,
message, details, at }`. Cada alerta tiene un procedimiento.

## PAYMENT_MISMATCH (crítica)

Qué pasó: el facilitador liquidó un pago cuyos términos (destino, asset, monto o red) no
coinciden con la cotización. La orden queda `paid` con `hold.reason = PAYMENT_MISMATCH`, el
pago está registrado con su hash, y NO se creó la orden en la plataforma.

1. `agentpos status`: identificar la orden y el `txHash`; abrir el hash en stellar.expert.
2. Comparar `hold.details.mismatch` con la cotización. Casos típicos: monto liquidado menor
   (pago parcial) o destino distinto (el pago no llegó a la wallet de la tienda).
3. Si el dinero llegó a la wallet correcta y solo difiere el monto: decidir con el comprador
   (reembolsar la diferencia o completar). Si el destino es otro: no despachar; escalar.
4. Nunca crear la orden a mano sin resolver la discrepancia. Documentar la decisión.

## ORDER_NOT_CREATED (crítica)

Qué pasó: el pago está liquidado on-chain pero la plataforma (WooCommerce/Shopify/hook) no
aceptó la creación de la orden tras los intentos inmediatos. La cola de reintentos sigue con
backoff (30 s, 1 m, 2 m, ... hasta 30 m).

1. Revisar `agentpos status` (muestra intentos y último error) y `/agentpos/health`
   (`orders.stuck`).
2. Causas frecuentes: credenciales REST rotadas o sin permiso de escritura (401/403, no se
   reintenta), tienda caída (5xx, se reintenta), producto borrado en la plataforma.
3. Corregir la causa y forzar: `agentpos status --retry`.
4. Si no se puede crear en la plataforma, crear la orden a mano con los datos de
   `/agentpos/orders/<id>` (comprador, envío, hash) y anotar `externalOrderId` en el registro.

## RETRY_LOOP_STALLED (crítica)

Una orden pagada lleva más de una hora sin orden en plataforma. Mismo procedimiento que
ORDER_NOT_CREATED, con prioridad: el comprador ya pagó.

## SETTLEMENT_FAILED (advertencia)

El facilitador verificó el pago pero falló al liquidar (timeout o rechazo). Nadie fue cobrado; la
orden queda `pending_payment` y el cart sigue vigente hasta su TTL. Si se repite en varios carts:
revisar `/agentpos/health.facilitator`, la API key (401) y el estado del facilitador
(channels.openzeppelin.com). Escalar a OpenZeppelin/SDF si persiste.

## /health devuelve 503

- `facilitator.ok = false`: key inválida (status 401), red no soportada o facilitador caído.
  Sin facilitador no hay ventas nuevas; las órdenes ya pagadas no se ven afectadas.
- `orders.stuck > 0`: ver ORDER_NOT_CREATED.

## Facilitador propio (`apps/facilitator`)

Está en el camino del pago: si se cae, no hay ventas en las tiendas que apuntan a él.

**`/health` responde 503 con `funded: false`.** La cuenta de fees bajó del mínimo. Enviar XLM
a la dirección que muestra `signer`. Solo XLM. Las liquidaciones fallan cuando llega a cero,
no antes, así que el 503 es el aviso previo.

**`/health` muestra `warning` y `foreignBalances`.** Alguien envió a la cuenta de fees un
activo que no es XLM. Esa cuenta no debe recibir nada: moverlo fuera y averiguar quién lo
mandó (probablemente una tienda configuró su `payTo` con nuestra dirección; el facilitador
rechaza esos pagos con `SPEC_MISMATCH`, pero un envío manual no pasa por ahí).

**`verify` responde `unexpected_verify_error` en serie.** Casi siempre es el RPC. Revisar el
log (`facilitator.verify_failed` con el mensaje), y si el RPC primario no responde, cambiar
`AGENTPOS_FACILITATOR_RPC_URL` a un RPC secundario y reiniciar.
Nada se cobra mientras tanto: sin `verify` no hay `settle`.

**`verify` pasa pero `settle` queda PENDING y nunca se incluye (o falla al tiro).** Vivido el
2026-09-04: el cliente x402 arma la tx con 100 stroops de fee de inclusion, fijos y firmados por
el comprador; cuando el minimo de la red sube de 100 (ese dia: 200), nada se incluye y parece
caida del RPC. El facilitador ya envuelve cada envio en un fee-bump (ver
`apps/facilitator/src/feebump.ts`); si reaparece, comparar `getFeeStats` contra la puja
(`facilitator.fee_bump` en el log) y subirla.

**`settle` responde `success: false`.** Leer `errorReason`. Si es un error de secuencia, dos
instancias están firmando con la misma cuenta; debe correr una sola por cuenta de fees.

**Rotar la llave de fees.** Generar una nueva con `pnpm --filter @agentpos/facilitator keygen
--network mainnet --force` en la máquina de destino, fondearla, reiniciar con el archivo nuevo,
y vaciar la vieja hacia la tesorería. El servicio imprime al arrancar qué dirección está usando.

## Operación rutinaria

- Backup: `agentpos backup ./backups` (SQLite `VACUUM INTO`, consistente en caliente). Restaurar
  = copiar el archivo a `.agentpos/agentpos.sqlite` con el sidecar detenido.
- Actualizar: detener el sidecar, `npm i -g @agentpos/site@latest`, arrancar. El esquema de la
  base es aditivo; las versiones anteriores de la base se abren sin migración.
- Rotación de credenciales REST: editar `.env`, reiniciar el sidecar, `agentpos status --retry`.
- Logs: `AGENTPOS_LOG_FORMAT=json` (default en `serve`) para agregadores; `pretty` para consola.
  Buscar por `traceId` para seguir una compra completa.
