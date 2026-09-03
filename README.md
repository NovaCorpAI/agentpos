# AgentPOS (nombre de trabajo, renombrable)

Librería open source que convierte cualquier sitio que hoy vende en fiat en
una tienda comprable por agentes de IA. Corre en el servidor del propio
sitio: lo escanea, publica su catálogo en los formatos estándar del comercio
agéntico (UCP, ACP, x402, MCP), cobra USDC sobre Stellar vía x402 y cierra la
orden en el sistema que el vendedor ya usa (Shopify, WooCommerce, hook
custom). Sin marketplace, sin intermediario, sin custodia. Global.

## Cómo usar este paquete con Claude Code

1. Copia esta carpeta a la raíz de un repo nuevo (`agentpos/`).
2. Abre VSCode, inicia Claude Code en la raíz.
3. Claude Code lee `CLAUDE.md` automáticamente. Primer comando sugerido:
   `Lee plan/ROADMAP.md y ejecuta la Fase 0 completa.`
4. Trabaja por fases. Cada fase tiene Definition of Done verificable.
5. Para paralelizar: usa git worktrees por paquete (ver CLAUDE.md, sección Agentes).

## Estructura del paquete

- `CLAUDE.md` ............ Instrucciones permanentes para Claude Code
- `docs/VISION.md` ....... Tesis, problema, escalera de fondos
- `docs/ARQUITECTURA.md` . Sistema, monorepo, decisiones, modelo de datos
- `docs/ONE-PAGER-TELLUS.md` Borrador del documento para el capítulo
- `specs/01..09` ......... Especificación por componente
- `plan/ROADMAP.md` ...... Fases, hitos Instaward, gate mainnet, backlog

## Reglas de oro (resumen)

1. NUNCA custodia: ni llaves privadas de terceros ni fondos. Default:
   vincular wallet existente (solo dirección pública), generar es fallback.
2. NUNCA marketplace: el vendedor es merchant of record, sin comisión, sin
   listado central. Cada sitio es su propio endpoint.
3. NUNCA una orden sin pago liquidado on-chain (settle + tx_hash).
4. Testnet hasta que ROADMAP marque el gate de mainnet.
5. Specs en movimiento (x402, UCP, ACP): capa de adaptación, nunca acoplar directo.
6. El scanner solo lee el sitio donde está instalado.
7. Todo open source, Apache-2.0, desde el commit 1.
8. Código e identificadores en inglés; docs de usuario bilingües (EN/ES).
