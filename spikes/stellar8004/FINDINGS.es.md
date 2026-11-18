# Spike de Stellar 8004: hallazgos

[English](./FINDINGS.md)

El spike respondía una pregunta: ¿puede AgentPOS usar los registros de Stellar 8004 (Trion
Labs) para la identidad y la reputación de un agente, con lo que tiene hoy? Corrió en
testnet en noviembre de 2026 con llaves desechables.

## Qué funcionó

| Paso | Resultado |
| --- | --- |
| El dueño del agente lo registra (`register_with_uri`) | agente ID 184, tx [`5ba476f9…8c726`](https://stellar.expert/explorer/testnet/tx/5ba476f921d0ba4427eb712220bda7c2d1a536409e6b60db15c209681288c726) |
| Una tienda, con su propia llave, escribe feedback con el SHA-256 de un comprobante (`give_feedback`) | tx [`23dfcd67…ecfe`](https://stellar.expert/explorer/testnet/tx/23dfcd67e7ad82b2dd54f5b2473b9a65a71c74330c8324dc860fc909c426ecfe) |
| Cualquiera lee el resumen de reputación, sin llave (`get_summary`) | 1 registro, valor 100 |

Entonces las tres llamadas que AgentPOS necesita existen y funcionan: registrar, escribir
feedback atado a un comprobante y leerlo de vuelta. El hash del comprobante en el registro
de feedback permite a quien lee contrastar una entrada de reputación con el comprobante al
que se refiere.

## Qué aprendimos

1. **Las versiones del SDK no calzan.** `@trionlabs/stellar8004` 0.0.13 depende de
   `@stellar/stellar-sdk` ^17.4.0. AgentPOS está en 16.4.1, y también `@x402/stellar`,
   hasta su última versión (2.31.0, que depende de ^16.4.1). Por eso este spike vive fuera
   del workspace de pnpm, con su propio lockfile.
2. **El paquete es joven.** Versión 0.0.13, y espera una wallet de navegador
   (`@stellar/freighter-api`) como dependencia par. El spike firma con una llave simple a
   través de `wrapBasicSigner`, y funcionó.
3. **El resumen se lee por autor de feedback.** El spike pidió el resumen del feedback
   escrito por la dirección de la tienda. Quién cuenta como autor creíble es una decisión
   de quien lee, no algo que el registro resuelva.
4. **El perfil del agente es público.** El spike registra un perfil sin datos personales,
   como data URI. Lo que se ponga ahí queda en la red para siempre.

## Pasar AgentPOS al SDK 17: qué tan difícil

El tamaño del cambio en nuestro código es moderado: 59 archivos fuente importan el SDK, en
8 paquetes. No hemos leído el changelog del SDK 17, así que no sabemos cuántos se rompen.

El obstáculo real no es nuestro. Los pagos pasan por `@x402/stellar`, que está en el SDK
16. Si AgentPOS pasara al 17 hoy, se cargarían dos copias del SDK, y objetos creados con
una (llaves, transacciones) se entregarían a la otra. Ese tipo de desajuste falla en
ejecución, en el camino del pago. Es justo lo que evitamos en la versión 0.1.6.

## Opciones para el trabajo de identidad

| Opción | Qué significa | Costo y riesgo |
| --- | --- | --- |
| A. Dejar 8004 en su propio paquete con el SDK 17 | El paquete de identidad habla con el resto de AgentPOS con datos simples (direcciones, hashes, IDs), nunca con objetos del SDK | Dos copias del SDK instaladas, aisladas entre sí. Funciona hoy. |
| B. Llamar a los registros con el SDK 16, sin el paquete de Trion Labs | Las tres llamadas son llamadas comunes a un contrato | Ninguna dependencia nueva y un solo SDK. No se probó en este spike: necesita su propia verificación. |
| C. Esperar a que `@x402/stellar` pase al SDK 17 y migrar todo | Un solo SDK, el paquete del proveedor tal como es | Depende de una fecha que no controlamos. |

Nuestra lectura: A funciona ahora y B merece una hora de verificación antes de empezar el
trabajo de identidad, porque saca del cuadro una dependencia 0.0.x. C no es un plan.

## Qué no se cubrió

- Mainnet. El spike es solo testnet.
- Actualizar o revocar feedback, y los cambios de metadatos del agente.
- El costo de cada llamada en comisiones.
- Cómo decide una tienda en qué agentes confiar a partir de un resumen.

## Cómo correrlo

```bash
cd spikes/stellar8004 && npm install && npm run spike
```

Imprime el ID del agente, los dos hashes de transacción y el resumen. CI lo corre en
`main`.
