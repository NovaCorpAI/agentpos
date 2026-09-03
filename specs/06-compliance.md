# SPEC 06: Compliance transversal

## Capa A: nuestra posición (implementación = disciplina, no código)

No-custodia total (guardrail 1), no-intermediación (guardrail 7): el
vendedor es merchant of record, el pago va directo de la wallet del
comprador a la del vendedor, no tocamos fondos ni cobramos comisión.
Checklist en cada PR de feature nueva: "¿custodia? ¿intermediación?
¿fiat? ¿nos convierte en marketplace?" Si alguna es sí: bloquear y escalar.
Pendiente founder (no código): memo legal antes del gate G2 sobre
no-custodia / no-intermediación / software provider, con nota sobre
jurisdicción (la librería corre en el servidor del vendedor, bajo su ley).

## Capa B: la orden como responsabilidad del vendedor

Envío, entrega, garantía, devoluciones y cancelaciones son del vendedor,
igual que en su venta fiat. La librería expone las políticas que el
vendedor declare (SPEC 09) para que el agente y su humano decidan. Política
de cancelación de orden pagada: definida por el vendedor; reembolso
on-chain manual en v1 (guía), automático en Build.

## Capa C: integridad del catálogo

1. **Verificación de vendedor** al publicar: control de dominio (TXT DNS o
   `/.well-known/agentpos.txt` con nonce) + control de wallet (firma de
   nonce via SPEC 07). Ambas pruebas => flag `verified` en las superficies
   y en el registry. NO es KYC: no recolectamos documentos de identidad.
2. **Screening de sanciones:** interfaz `SanctionsScreener` en core;
   implementación v1 con API pública/low-cost configurable. Se corre sobre
   CADA wallet vinculada al vincular, al publicar y semanalmente (cron).
   Hit => unpublish + flag + notificar.
3. Lado comprador: mcp-buyer expone `verified` y soporta mandato
   'verified-only'. Sitios no registrados en el hosted se muestran como
   `unverified`, nunca se ocultan.

## Capa D: trazabilidad del gasto agéntico

Mandato + spending log del SPEC 02. Registro append-only exportable.
Diseño preparado para divulgación selectiva futura (NO implementar ahora).

## Capa E: datos del comprador

`buyerContact` y `shipping` viajan del agente al sitio del vendedor
directamente (el hosted no los ve). El sitio los guarda como cualquier
orden fiat. Documentar en política de datos.

## Textos legales mínimos (docs/)

Términos de uso de la librería, disclaimer no-asesoría (tributaria/legal/
financiera), política de datos (qué guarda el hosted: dominio, direcciones
públicas, hashes, email de cuenta; qué NO: llaves, credenciales de
plataforma, datos de compradores). Redactar en ES/EN, revisar con abogado
junto al memo.
