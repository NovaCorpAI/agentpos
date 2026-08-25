# SPEC 09: Superficies de protocolo (`packages/core/src/adapter/`)

## Objetivo

Que un sitio AgentGate sea encontrable y comprable por CUALQUIER agente,
no solo por nuestro MCP, emitiendo los formatos que el ecosistema ya
definió. No inventamos protocolo. Un módulo por spec, versión fijada,
`adapterVersion` en toda salida. Guardrail 3: nadie fuera de este paquete
toca un spec directo.

## Superficies que expone un sitio publicado

| Ruta                  | Protocolo     | Contenido                                                                                                                            | v1                                |
| --------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `/.well-known/ucp`    | UCP           | manifiesto: version, services (`dev.ucp.shopping`), capabilities (checkout, discovery), payment_handlers (`x402-stellar`), políticas | emitido + validado contra esquema |
| `/agentgate/feed`     | ACP           | feed de productos versión fijada (última conocida 2026-04-17)                                                                        | emitido + validado                |
| `/agentgate/catalog`  | propio (JSON) | catálogo publicado, paginado, con `adapterVersion`                                                                                   | completo                          |
| `/agentgate/mcp`      | MCP           | tools del sitio: `search`, `get_item`, `create_cart`, `quote`, `checkout`, `get_order`                                               | completo                          |
| `/agentgate/checkout` | x402 V2       | 402 con `PAYMENT-REQUIRED`; acepta `PAYMENT-SIGNATURE`; responde `PAYMENT-RESPONSE`                                                  | completo, e2e                     |
| discovery x402        | x402 ext.     | registro del endpoint en la extensión de discovery del facilitador (si la soporta) e índices públicos                                | best-effort                       |

Garantía v1: el camino **MCP del sitio + checkout x402** funciona end-to-end
con cualquier cliente x402 Stellar. UCP y ACP se emiten válidos contra sus
esquemas para que los agentes de esos ecosistemas descubran el sitio;
completar el checkout por sus rutas nativas (UCP checkout binding, ACP
checkout API con delegated payment) es fase Build y depende de que cada
spec acepte un handler de pago en stablecoin. Se documenta el estado real
de interop en `docs/interop-status.md` (qué valida, qué no, por qué).

## Módulo x402 (`adapter/x402.ts`)

- Usa `@x402/core` + `@x402/stellar` exact scheme; nunca reimplementa.
- Config: facilitador (testnet/mainnet), red CAIP-2, asset USDC issuer por
  red, `payTo` por item (multi-wallet), memo = order id.
- Headers V2. Compatibilidad con clientes V1 delegada al SDK.
- Emite metadata de discovery del endpoint según la extensión vigente.

## Módulo UCP (`adapter/ucp.ts`)

- Genera el manifiesto desde el catálogo y la config. Declara handler
  `x402-stellar` con `config_schema` e `instrument_schemas` propios
  (documentados en el repo como propuesta de extensión).
- Validación contra el JSON Schema publicado en ucp.dev, fijado por
  versión. Test snapshot.
- Políticas declarables: envío (países, plazos), cancelación, devolución,
  contacto. Se llenan en `confirm` del CLI.

## Módulo ACP (`adapter/acp.ts`)

- Genera el feed de productos según la versión fijada. Validación contra
  el JSON Schema del repo agentic-commerce-protocol.
- Checkout API ACP y delegated payment: NO en v1 (slot documentado).

## Módulo MCP del sitio (`site/src/mcp.ts`)

- Servidor MCP por sitio sobre HTTP (streamable). Tools determinísticas,
  salida estructurada, errores `{ code, message, hint }`. Es lo que consume
  mcp-buyer y cualquier agente MCP.

## Rutina de conformance

- Semanal: diff de los esquemas UCP/ACP y del repo x402 contra las
  versiones fijadas; PR de actualización si cambió; `docs/adapter-versions.md`.
- Test suite `conformance/` corre en CI: cada superficie valida contra el
  esquema de su versión fijada.

## Tests

Snapshot por superficie contra fixtures de cada versión; validación de
esquemas; e2e checkout x402 en testnet; test de que un cliente x402
genérico (no nuestro) completa una compra.
