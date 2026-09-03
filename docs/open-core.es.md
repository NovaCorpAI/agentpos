# Qué es gratis para siempre, y qué será de pago

Una página, para que sea una promesa pública y no una ambigüedad. Versión en inglés:
[`open-core.en.md`](open-core.en.md).

## Gratis para siempre (Apache-2.0, en este repo)

Todo lo que una tienda necesita para venderle a agentes, sin cuenta en NovaCorpAI y sin pagarnos
nunca:

- El **sidecar y el CLI** (`agentpos`): scan, confirm, publish, serve, status, backup.
- Los **conectores** (WooCommerce, hook genérico; Shopify cuando salga).
- **Toda la capa de confianza**: políticas, aprobaciones humanas, Know Your Agent, comprobantes
  firmados y encadenados, y el dashboard de métricas por tienda.
- El **comprador** (`agentpos-buyer`): servidor MCP y agente de referencia bajo mandato humano.
- El **facilitador** (`apps/facilitator`): auto-hospedable, sobre los SDK oficiales.
- Los **formatos y SPECs**: atestaciones, comprobantes, el borrador de extensión. Verificables
  por cualquiera sin nuestro software.

Dos compromisos que van con esto:

1. **Ninguna función se muda de esta lista a la de pago.** La capa paga se construye *encima* de
   estos formatos, nunca como un peaje delante de ellos.
2. **Irse no cuesta nada.** Apagas el sidecar y tu tienda queda como estaba. Tus datos están en
   tu archivo SQLite, tus comprobantes se verifican sin nosotros, tu plata nunca nos tocó.

## De pago, después: AgentPOS Cloud (hospedado, aún no construido)

Para comercios que prefieren que otro opere las partes latosas de operar. Planeado, en orden de
probabilidad:

| Servicio | Qué pagas |
| --- | --- |
| **Archivo de comprobantes** | Retención de años de tu cadena firmada, publicación periódica del hash de cabecera (cierra la debilidad de truncamiento que el propio SPEC declara), exportes de auditoría, portal de verificación para tu contador o tu banco. |
| **Dashboard gestionado + reconciliación** | Dashboards multi-tienda, un indexer que reconcilia tus órdenes contra el ledger de Stellar, alertas. |
| **Pack de compliance** | Screening de sanciones, registro de agentes verificados, verificación de dominio. |
| **Facilitación gestionada** | Operamos el facilitador, comisiones de red incluidas, con SLA. |

Los precios no están definidos; será suscripción por servicio, nunca un porcentaje de las ventas.
**Cobrar comisión por transacción está estructuralmente descartado**: el comercio es el merchant
of record y nosotros no tocamos el dinero, así que una comisión ni siquiera se puede implementar
honestamente.

¿Te interesa? Hay una lista de espera en el sitio. Anotarse no compromete a nada y nos ayuda a
ordenar el roadmap por demanda real.
