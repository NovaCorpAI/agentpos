# Gate de producción G1 (desbloqueo de mainnet)

Estado: EN CURSO. Mainnet se habilita solo cuando `pnpm gate:check` está 100% verde y el
founder cambia `MAINNET_READY` a `true` en `packages/core/src/config.ts` en un commit dedicado.
El reporte automático se escribe en `docs/gate-g1.report.json`.

## Criterios automáticos (los verifica `pnpm gate:check`)

| Criterio                                                                                  | Cómo se verifica                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Verificación exacta de monto, asset (contrato) y destino contra la cotización al liquidar | `packages/site/src/gate.test.ts` (mismatch => hold + alerta, sin orden en plataforma)                                                                                                                                                                        |
| Idempotencia y anti-replay                                                                | tx_hash único en `payments`; una orden por cart; test "replayed payment cannot pay a second cart". Además el facilitador rechaza on-chain la reutilización de la auth entry firmada                                                                          |
| Expiración y re-cotización                                                                | TTL de cart + `revalidateCart` en checkout: precio o stock cambiado => 409 `REQUOTE_REQUIRED`, cart expirado                                                                                                                                                 |
| Caminos tristes                                                                           | tests: pago parcial (hold), asset/destino distintos (hold), verify falla (sin orden), settle falla (pendiente + alerta), plataforma caída tras settle (pago guardado, alerta, cola de reintentos persistente con backoff, alerta de estancamiento a la hora) |
| Sanitización de inputs                                                                    | zod en cada frontera; body máx. 64 KB (413); carritos máx. 50 líneas; `q` truncado a 200; ids truncados                                                                                                                                                      |
| Rate limiting                                                                             | token bucket por IP en cart y checkout y por cart en intentos de checkout; 429 con `Retry-After`                                                                                                                                                             |
| Cero custodia al arrancar                                                                 | `assertNoSecretsInConfig` rechaza cualquier seed `S...` en `agentgate.config.json`                                                                                                                                                                           |
| Historial git sin secretos                                                                | gitleaks sobre todo el historial (docker)                                                                                                                                                                                                                    |
| Auditoría de dependencias                                                                 | `pnpm audit --prod` sin vulnerabilidades; `pnpm-lock.yaml` en el repo                                                                                                                                                                                        |
| Facilitador                                                                               | `/supported` responde y soporta `exact@<red>` con la key configurada                                                                                                                                                                                         |
| Carga                                                                                     | 40 agentes concurrentes: 40 órdenes, 40 pagos únicos, cero duplicados                                                                                                                                                                                        |
| Salud y alertas                                                                           | `/health` reporta facilitador y órdenes atascadas (503 si hay); alertas por log JSON y webhook (`AGENTGATE_ALERT_WEBHOOK`)                                                                                                                                   |
| Trazabilidad                                                                              | `traceId` por request (header `x-trace-id`), en cart, orden y logs JSON                                                                                                                                                                                      |

## Criterios manuales (marcar con evidencia enlazada)

- [x] secrets-history: gitleaks sobre 14 commits, 0 fugas, 2026-08-26 (docs/GATE-G1.md#evidencia)
- [x] runbook: procedimientos por alerta (docs/RUNBOOK.md)
- [x] backup-restore: `agentgate backup` + restauración por copia en un data dir real, 2026-08-26 (docs/GATE-G1.md#evidencia)
- [x] dependency-review: revisión manual de dependencias directas, 2026-08-26 (docs/GATE-G1.md#evidencia)
- [x] e2e-testnet: XLM y USDC reales, 2026-08-25 (docs/GATE-G1.md#evidencia)

## Evidencia

- Historial: `docker run --rm -v $PWD:/repo ghcr.io/gitleaks/gitleaks:latest git /repo --config /repo/.gitleaks.toml`
  -> "14 commits scanned, no leaks found" (2026-08-26). Mismo comando en CI en cada push.
- Auditoría: `pnpm audit --prod` -> "No known vulnerabilities found" (2026-08-26).
- Dependencias directas revisadas (2026-08-26): `@stellar/stellar-sdk`, `@x402/core|stellar|hono|fetch`
  (x402 Foundation / SDF), `hono`, `@hono/node-server`, `@modelcontextprotocol/sdk`, `zod`, `ajv`,
  `ajv-formats`, `cheerio`, `fast-xml-parser`, `commander`, `@clack/prompts`, `picocolors`.
  Ninguna dependencia de autor único desconocido; sin AGPL; SQLite vía `node:sqlite` (sin nativos).
- E2E testnet real: XLM tx `6623679bdb2640efb89eb4a5222d23ff826d13ab7a493b1f72bc7f2d27db8f4b`
  (orden Woo #17), USDC tx `6e5007492399a2378d39ae762c7ba7e82b6c6b0e756de21d568a291004f1f2b7`
  (orden Woo #18, vendedor recibió 9.9 USDC on-chain). Job `e2e-testnet` en CI en cada push a main.

## Qué NO cubre este gate (y dónde vive)

- Reembolsos on-chain y cancelaciones: política por tienda en `policies`, flujo automático en M2/M4.
- Rate limiting por wallet pagadora: requiere decodificar la auth entry firmada; queda para M3
  (identidad del agente), donde la wallet se conoce antes de cotizar.
- Memo legal y política de conversión: fuera de código (founder), condición para el lanzamiento.
- Backup/restore (2026-08-26): `agentgate backup ./backups` produjo `agentgate-<ts>.sqlite` (VACUUM INTO); se borró la base viva, se copió el backup a `.agentgate/agentgate.sqlite` y `agentgate status` volvió a leer el estado. Test automático `backs up the database consistently` en `gate.test.ts`.
