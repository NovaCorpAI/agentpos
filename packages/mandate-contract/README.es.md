# @agentpos/mandate-contract

[English](./README.md)

Cliente de los contratos de mandato de AgentPOS en Soroban: desplegarlos, emitir y revocar
la sesión de un agente, fijar su mandato, leer cuánto ha gastado y firmar un pago como la
cuenta lo espera. Los contratos, y lo que exigen, están en
[`contracts/`](../../contracts/README.es.md).

**Estado: solo testnet, sin auditoría.** Todavía no se publica en npm.

## Qué hace

| Función                                                | Qué es                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `deployContract`, `deployMandateAccount`, `uploadWasm` | Ponen los contratos en la red                                                             |
| `issueSession`                                         | Operación del dueño: una sesión para la llave del agente, con su mandato y su vencimiento |
| `setMandate`                                           | Operación del dueño: cambia los topes y los vendedores de una sesión                      |
| `revokeSession`                                        | Operación del dueño: quita la sesión; el siguiente pago no encuentra regla                |
| `getMandate`                                           | Lee los topes, los vendedores y lo gastado en el período actual                           |
| `signMandateAuthEntry`                                 | Firma una entrada de autorización de la cuenta, como dueño o como agente                  |

Cada llave es un `Keypair` local que tiene quien llama. Nada aquí guarda una llave ni la
envía a ninguna parte. Quien paga las comisiones de una transacción solo paga comisiones de
red; no tiene ningún poder sobre la cuenta.

## Pagar con x402 desde la cuenta

La cuenta firma con su propio formato, así que el cliente x402 estándar no puede firmar por
ella. El adaptador del core trae un esquema de cliente que arma el mismo pago y deja que la
cuenta firme:

```ts
import { createContractAccountScheme } from "@agentpos/core";
import { signMandateAuthEntry } from "@agentpos/core";

const scheme = createContractAccountScheme({
  address: account, // la cuenta con mandato, C...
  authorize: (entry, validUntilLedger, networkPassphrase) =>
    signMandateAuthEntry(
      entry,
      { account, contextRuleId: session, verifier, keys: [agentKey] },
      validUntilLedger,
      networkPassphrase,
    ),
});
```

Verify y settle siguen siendo del facilitador. Un pago que el mandato rechaza nunca llega a
quedar firmado en una transacción pagable: el esquema lanza `PAYMENT_REJECTED`, y
`details.contractCode` trae el motivo del contrato (4105 sobre el tope por pago, 3221 sobre
el tope por período, 4106 vendedor no permitido, 3002 sesión vencida, 3000 sesión
revocada).

## Correrlo en testnet

Requisitos: los contratos compilados a WASM (`stellar contract build` en `contracts/`), y en
el entorno `AGENTPOS_FACILITATOR_API_KEY` y, para dar saldo a la cuenta,
`SMOKE_USDC_SOURCE_SECRET` (una cuenta con USDC de testnet, ver
<https://faucet.circle.com>).

```bash
pnpm --filter @agentpos/mandate-contract deploy:testnet   # contratos, cuenta, una sesión
pnpm --filter @agentpos/mandate-contract gate:x402        # paga dentro del tope y luego sobre él
```

`deploy:testnet` genera llaves desechables de testnet, las deja en `.agentpos/` (ignorado
por git) y escribe los identificadores de los contratos en
`contracts/deployments/testnet.json`. `gate:x402` paga 0,5 USDC desde la cuenta a través
del facilitador e imprime la transacción liquidada; después intenta 1,5 USDC contra un tope
de 1 e imprime el rechazo.

## La compra, de punta a punta

```bash
pnpm demo:up          # la tienda demo de WooCommerce
pnpm e2e:mandate      # necesita un despliegue (deploy:testnet)
```

Un agente compra en una tienda AgentPOS real y paga desde la cuenta con mandato: la tienda
responde 402, el agente firma con su llave de sesión, el facilitador liquida, la orden se crea
en WooCommerce con el hash de la transacción y el comprobante firmado de la tienda se verifica
sin conexión. Después el agente intenta dos unidades contra una sesión con tope igual al
precio de una. En esta corrida el mandato del propio comprador se deja holgado a propósito,
como si el software del agente estuviera mal o comprometido, para que el rechazo que se ve sea
el de la red: la cuenta responde 4105, el saldo no se mueve y el período muestra un solo pago.

La corrida devuelve el precio desde su vendedor desechable a la cuenta, así que se puede
repetir. Con `AGENTPOS_CHECKOUT_ASSET=XLM` la sesión queda acotada al activo nativo y
friendbot financia todo; así la corre el CI (job `e2e-mandate-account`), con un despliegue
propio que `AGENTPOS_MANDATE_STATE_FILE` mantiene separado del de referencia.

`scripts/probe-no-policy.ts` es la prueba que aisló lo único que un facilitador no acepta de
una smart account: un evento de contrato emitido al autorizar. Se conserva como registro de
ese hallazgo.

## Reportado a los proyectos de origen

Construir esto dejó a la vista dos brechas entre x402 en Stellar y las smart accounts. Las dos
son públicas, con su reproducción y con transacciones liquidadas en testnet como evidencia.

| Qué                                                                                                | Dónde                                                                   | Nuestra parte                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| El esquema de cliente de x402 no puede firmar por una cuenta contrato con su propio valor de firma | [x402, issue 4453](https://github.com/x402-foundation/x402/issues/4453) | Reportado por nosotros, con la causa en el código, un arreglo y la oferta de enviar el PR. `createContractAccountScheme` en el core es ese arreglo, en uso                                                                                                           |
| El facilitador rechaza un pago cuya cuenta emite un evento de contrato al autorizar                | [x402, issue 3764](https://github.com/x402-foundation/x402/issues/3764) | Reportado antes por otra persona. Lo [confirmamos de forma independiente](https://github.com/x402-foundation/x402/issues/3764#issuecomment-7198315698), mostramos que una cuenta que no emite nada sí se liquida, y medimos cuánto cuestan estos pagos en comisiones |

Mientras lo segundo no cambie, una política que quiera poder pagarse por x402 calla en el
camino de pago, y por eso `mandate-policy` copia una función de la librería de OpenZeppelin.
Si se arregla lo primero, el esquema del core desaparece y se usa el cliente estándar.

## Límites conocidos

- Los firmantes son llaves Ed25519 detrás del contrato verificador. Passkeys y firmantes
  delegados todavía no se soportan.
- Una regla de contexto por firma: no se soporta una transacción que necesite que la cuenta
  autorice dos contextos distintos.
- Solo testnet. Los scripts terminan si la red es otra.
