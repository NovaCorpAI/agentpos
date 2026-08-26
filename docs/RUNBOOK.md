# Runbook del sidecar AgentGate

Alertas llegan como líneas JSON `{"event":"alert","code":...}` en stderr del sidecar y, si está
configurado `AGENTGATE_ALERT_WEBHOOK`, como POST JSON `{ source: "agentgate", code, severity,
message, details, at }`. Cada alerta tiene un procedimiento.

## PAYMENT_MISMATCH (crítica)

Qué pasó: el facilitador liquidó un pago cuyos términos (destino, asset, monto o red) no
coinciden con la cotización. La orden queda `paid` con `hold.reason = PAYMENT_MISMATCH`, el
pago está registrado con su hash, y NO se creó la orden en la plataforma.

1. `agentgate status`: identificar la orden y el `txHash`; abrir el hash en stellar.expert.
2. Comparar `hold.details.mismatch` con la cotización. Casos típicos: monto liquidado menor
   (pago parcial) o destino distinto (el pago no llegó a la wallet de la tienda).
3. Si el dinero llegó a la wallet correcta y solo difiere el monto: decidir con el comprador
   (reembolsar la diferencia o completar). Si el destino es otro: no despachar; escalar.
4. Nunca crear la orden a mano sin resolver la discrepancia. Documentar la decisión.

## ORDER_NOT_CREATED (crítica)

Qué pasó: el pago está liquidado on-chain pero la plataforma (WooCommerce/Shopify/hook) no
aceptó la creación de la orden tras los intentos inmediatos. La cola de reintentos sigue con
backoff (30 s, 1 m, 2 m, ... hasta 30 m).

1. Revisar `agentgate status` (muestra intentos y último error) y `/agentgate/health`
   (`orders.stuck`).
2. Causas frecuentes: credenciales REST rotadas o sin permiso de escritura (401/403, no se
   reintenta), tienda caída (5xx, se reintenta), producto borrado en la plataforma.
3. Corregir la causa y forzar: `agentgate status --retry`.
4. Si no se puede crear en la plataforma, crear la orden a mano con los datos de
   `/agentgate/orders/<id>` (comprador, envío, hash) y anotar `externalOrderId` en el registro.

## RETRY_LOOP_STALLED (crítica)

Una orden pagada lleva más de una hora sin orden en plataforma. Mismo procedimiento que
ORDER_NOT_CREATED, con prioridad: el comprador ya pagó.

## SETTLEMENT_FAILED (advertencia)

El facilitador verificó el pago pero falló al liquidar (timeout o rechazo). Nadie fue cobrado; la
orden queda `pending_payment` y el cart sigue vigente hasta su TTL. Si se repite en varios carts:
revisar `/agentgate/health.facilitator`, la API key (401) y el estado del facilitador
(channels.openzeppelin.com). Escalar a OpenZeppelin/SDF si persiste.

## /health devuelve 503

- `facilitator.ok = false`: key inválida (status 401), red no soportada o facilitador caído.
  Sin facilitador no hay ventas nuevas; las órdenes ya pagadas no se ven afectadas.
- `orders.stuck > 0`: ver ORDER_NOT_CREATED.

## Operación rutinaria

- Backup: `agentgate backup ./backups` (SQLite `VACUUM INTO`, consistente en caliente). Restaurar
  = copiar el archivo a `.agentgate/agentgate.sqlite` con el sidecar detenido.
- Actualizar: detener el sidecar, `npm i -g @agentgate/site@latest`, arrancar. El esquema de la
  base es aditivo; las versiones anteriores de la base se abren sin migración.
- Rotación de credenciales REST: editar `.env`, reiniciar el sidecar, `agentgate status --retry`.
- Logs: `AGENTGATE_LOG_FORMAT=json` (default en `serve`) para agregadores; `pretty` para consola.
  Buscar por `traceId` para seguir una compra completa.
