# Contratos del mandato de AgentPOS (Soroban)

[English](./README.md)

Una persona deja que su agente comprador gaste dentro de un mandato: cuánto por pago, cuánto
por período y a qué vendedores. AgentPOS ya revisa ese mandato en software antes de cada
firma. Estos contratos son su contraparte en la red: el límite lo revisa la red dentro del
`__check_auth` de la cuenta, así que se sostiene aunque se filtre la llave del agente.

**Estado: solo testnet, sin auditoría.** Nada de esto va a mainnet antes de una auditoría.
Desplegado en testnet: los identificadores de los contratos están en
[deployments/testnet.json](./deployments/testnet.json).

## Qué hay aquí

| Crate | Qué es |
| --- | --- |
| `mandate-account` | La smart account del humano. Una smart account de OpenZeppelin (`stellar-accounts`) que nace con una regla del dueño. |
| `mandate-policy` | El mandato como política de la smart account: tope por pago, tope por período y lista de vendedores permitidos. |
| `ed25519-verifier` | Verificador Ed25519 sin estado para las llaves de sesión. Un despliegue sirve a todas las cuentas. |

La mayor parte es composición. La cuenta, las reglas de contexto, el flujo de firma y la
ventana móvil de gasto son de OpenZeppelin (`stellar-accounts` 0.8.0, versión fijada). Lo que
agrega AgentPOS es la política del mandato y la forma de ordenar las piezas.

## Cómo se traduce el mandato a la red

| Regla del mandato | Dónde se exige |
| --- | --- |
| Solo transferencias de USDC | La regla de contexto de la sesión está limitada al contrato de USDC (`CallContract`), y la política acepta solo `transfer(from = cuenta, to, amount)` |
| Tope por pago | `mandate-policy` (`OverPaymentCap`, 4105) |
| Tope por período | `mandate-policy`, sobre el estado y con las reglas del límite de gasto de OpenZeppelin (`SpendingLimitExceeded`, 3221) |
| Vendedores permitidos | `mandate-policy` (`SellerNotAllowed`, 4106) |
| Expiración de la sesión | El ledger `valid_until` de la regla de contexto, que revisa la cuenta |
| Revocación | El dueño quita la regla de contexto; el siguiente pago no encuentra regla |
| Cambios solo del dueño | Las llamadas de gestión necesitan la autorización de la propia cuenta, que solo la regla del dueño puede dar |

Operaciones del dueño:

- **Emitir sesión:** `add_context_rule(CallContract(usdc), name, valid_until, [llave de sesión], {política: MandateParams})` en la cuenta.
- **Fijar política:** `set_mandate(per_payment_cap, period_cap, sellers, context_rule_id, smart_account)` en la política.
- **Revocar sesión:** `remove_context_rule(context_rule_id)` en la cuenta.

Los montos son enteros en la unidad mínima del token (USDC tiene 7 decimales en Stellar).

## Verlo correr

Una historia, paso a paso, contra los contratos: el agente compra dentro de su mandato,
intenta pasarse, su llave se filtra, el dueño revoca.

```bash
cd contracts && ./demo.sh          # con --wasm corre contra el WASM compilado
```

Es un test como los demás (`mandate-policy/tests/mandate_demo.rs`): firmas reales, el
camino real de autorización y cada paso verificado. Imprime lo que pasa en palabras
simples. `AGENTPOS_DEMO_PAUSE_MS=1700` hace una pausa entre pasos, para grabar;
`video/tapes/scene-mandate.tape` lo graba.

## Matriz de aceptación

`mandate-policy/tests/mandate_matrix.rs` pasa cada caso por el camino real de autorización
del host: cada llamada lleva una entrada de autorización de Soroban para la cuenta, firmada
con una llave Ed25519, y atraviesa `__check_auth`, el verificador y la política. El token es
un Stellar Asset Contract, igual que USDC. Cada rechazo se comprueba junto con su código de
error, y con el saldo y el total del período intactos.

| Caso | Esperado |
| --- | --- |
| Pago dentro de los topes a un vendedor permitido | aceptado |
| Pago por exactamente el tope por pago | aceptado |
| Pagos que suman exactamente el tope por período | aceptado |
| Pago después de que el período avanza | aceptado |
| El dueño fija la política y rigen los nuevos términos | aceptado |
| El dueño emite una segunda sesión con su propio mandato | aceptado |
| El dueño revoca la sesión | aceptado |
| El dueño paga con su regla, fuera del mandato del agente | aceptado |
| Pago sobre el tope por pago | rechazado, 4105 |
| Pago sobre el tope por período | rechazado, 3221 |
| Pago a un vendedor no permitido | rechazado, 4106 |
| Pago con la sesión expirada | rechazado, 3002 |
| Pago con la sesión revocada | rechazado, 3000 |
| Cambio de política firmado por el agente | rechazado, 3002 |
| Cambio de política firmado por el agente invocando la regla del dueño | rechazado, 3002 |
| Sesión emitida por el agente | rechazado, 3002 |
| Sesión revocada por alguien que no es el dueño | rechazado, 3002 |
| Sesión extendida por el agente | rechazado, 3002 |
| Llamada al token que no es una transferencia (`approve`) | rechazado, 4103 |
| Pago sin la firma de la sesión | rechazado, 4107 |
| Pago firmado por una llave desconocida | rechazado, 3016 |
| Pago por cero | rechazado, 4104 |
| Pago en un token al que la sesión no está limitada | rechazado, 3002 |
| Mandato con términos inválidos | rechazado, 4101 |

## Más allá de la matriz

La matriz muestra que cada regla rechaza lo que debe. Otras cuatro suites van por todo lo
que rodea a las reglas, y el mutation testing revisa a las suites mismas.

### Tests adversarios

`mandate-policy/tests/mandate_adversarial.rs`. Lo que puede intentar un ladrón con la llave
de sesión, un intermediario descuidado o el dueño de otra cuenta.

| Intento | Resultado |
| --- | --- |
| Reenviar un pago ya firmado | rechazado (el nonce ya se usó); se paga una vez |
| Subir el monto después de que el agente firmó | rechazado (la firma ya no calza) |
| Cambiar el destinatario por otro vendedor permitido después de firmar | rechazado |
| Enviar un pago bajo una sesión más holgada que la que firmó el agente | rechazado (la firma ata la regla) |
| Adjuntar la firma del agente sobre otro pago | rechazado |
| El agente quita la política de su propia sesión | rechazado, 3002 |
| El agente agrega un firmante a la regla del dueño | rechazado, 3002 |
| El agente llega a la política a través de `execute` de la cuenta | rechazado, 3002 |
| Una regla de sesión con la política y sin ningún firmante, pagada sin firma | rechazado, 4107 |
| Una sesión con dos firmantes, pagada con una sola firma | rechazado, 4107 |
| Una llamada al token con forma de transferencia y otro nombre (`burn_from`) | rechazado, 4103 |
| Un pago declarado bajo la llamada a otro contrato, que podría retornar sin pagar y gastar igual el presupuesto | rechazado, 3002 |
| Llamar a `enforce`, `install`, `uninstall` o `set_mandate` de la política sin la autorización de la cuenta | rechazado; el estado queda intacto |
| El dueño de otra cuenta cambia el mandato de esta cuenta | rechazado |

Y la contabilidad:

- Dos cuentas comparten un mismo contrato de política y nada de su estado.
- Un pago que falla más abajo (saldo insuficiente) no consume nada del período.
- Bajar el tope del período por debajo de lo ya gastado bloquea los pagos hasta que la
  ventana avance; los pagos anteriores siguen contando.
- Revocar borra el estado del mandato, y una sesión nueva parte con el período limpio.
- El período es una ventana móvil: un pago deja de contar exactamente `period_ledgers`
  después de hecho, no en un reinicio fijo.
- La lista de vendedores admite exactamente 32 direcciones: 32 se aceptan, 33 se rechazan
  (4102).

### Test contra un modelo

`mandate-policy/tests/mandate_model.rs`. El mandato se escribe una segunda vez, de la forma
ingenua: una lista de pagos aceptados y seis condiciones. Un generador produce 320
operaciones a partir de 8 semillas fijas (pagos por cualquier monto, incluidos cero,
negativos y una unidad sobre cada tope; a destinatarios permitidos y no permitidos; firmados
por el agente, por una llave desconocida o por nadie; en ledgers que caen antes, justo en y
después del borde del período y de la expiración de la sesión). Después de cada operación,
los contratos y el modelo tienen que coincidir en la respuesta, en ambos saldos y en el
total del período. Una falla nombra su semilla y su paso, así que se reproduce exacta.

### Vigencia del almacenamiento

`mandate-policy/tests/mandate_storage.rs`. El almacenamiento en Soroban se arrienda: una
entrada que no se renueva se archiva. Un mandato guarda dos entradas por sesión, sus
términos y el historial del período. Las otras suites le dan a cada entrada una vigencia
más larga que el test, así que estos cinco tests usan vigencias cortas y leen las entradas
directamente.

- Un mandato nuevo parte con la vigencia mínima de la red.
- Un pago, o leer el mandato, renueva ambas entradas a 30 días.
- No se renueva nada mientras queden más de 29 días, así el agente no paga arriendo en
  cada compra.
- Una sesión inactiva por más tiempo que su almacenamiento conserva los mismos términos:
  un pago sobre el tope o a otro vendedor se sigue rechazando. Esto es lo que hace el host
  de pruebas, donde una entrada archivada vuelve cuando se lee. Todavía no se ha comprobado
  en testnet.

### Los mismos tests contra el WASM

Por defecto los contratos corren como Rust nativo dentro del host de pruebas. Con
`AGENTPOS_WASM_DIR` apuntando a los `.wasm` compilados, todas las suites corren contra esos
artefactos, que son lo que se despliega. CI corre ambos modos.

### Cuánto cuesta exigir el mandato

Medido por el host con los contratos WASM (`mandate_costs.rs`), para la transacción
completa: la transferencia del token, el `__check_auth` de la cuenta, la verificación
Ed25519 y la política.

| Operación | Instrucciones de CPU | Entradas escritas | Bytes escritos |
| --- | --- | --- | --- |
| Pago del agente, primero del período | 2.580.802 | 4 | 912 |
| Pago del agente, cuarto del período | 2.607.605 | 4 | 1.152 |
| Pago del agente sobre el tope (rechazado) | 2.259.385 | 0 | 0 |
| El dueño fija la política | 3.062.095 | 3 | 1.000 |
| El dueño emite una sesión | 3.668.047 | 7 | 1.692 |
| El dueño revoca una sesión | 3.128.711 | 7 | 776 |

Cada pago agrega una entrada al historial del período (unos 80 bytes) hasta que sale de la
ventana. CI falla si un pago supera 4.000.000 de instrucciones; ese es un techo propio de
regresión, no un límite de la red.

### Mutation testing

Las suites anteriores prueban los contratos. El mutation testing prueba a las suites:
cargo-mutants rompe el código de a un cambio pequeño por vez (un `>` convertido en `>=`,
un `&&` en `||`, el cuerpo de una función vaciado) y corre todas las suites contra cada
cambio. Un cambio que ningún test nota es un hueco en los tests.

Sobre los tres contratos hace 67 cambios. 9 no compilan y los tests notan los otros 58;
ninguno pasa inadvertido. La primera corrida completa dejó 3 sin notar, y cada uno se
volvió un test: la lista de vendedores en su límite, y una llamada al token con forma de
transferencia y otro nombre. Una corrida parcial anterior había mostrado que nada probaba
una sesión a la que le falta una firma cuando hay varios firmantes, y que nada probaba la
renovación del almacenamiento.

Corre en `.github/workflows/mutants.yml` y falla si algún cambio pasa inadvertido. Muestra
que los tests notan estos cambios. No muestra que los contratos sean correctos, y no
reemplaza una auditoría.

## Notas de seguridad

En qué se apoya el diseño, dicho de forma que un revisor lo pueda comprobar. La lista
completa de propiedades, cada una con su test, y las preguntas que siguen abiertas están en
[AUDIT-PREP.es.md](./AUDIT-PREP.es.md).

- **El límite está en el camino de autorización.** La política corre dentro del
  `__check_auth` de la cuenta. No existe una entrada que mueva fondos y se la salte; una
  transferencia que el mandato rechaza nunca llega al token.
- **Los chequeos fallan cerrados.** Todo lo que la política no reconoce se rechaza: otra
  función, otro token, un argumento faltante, una dirección que no puede leer, una firma
  ausente. Si la entrada de almacenamiento del mandato llegara a faltar, los pagos se
  rechazan (`NotInstalled`), no se permiten.
- **Una regla con política delega la validación de firmantes a la política.** Así funciona
  la cuenta de OpenZeppelin. Por eso el mandato exige que hayan firmado todos los firmantes
  de la regla de sesión; sin ese chequeo, un pago dentro de los topes no necesitaría firma
  alguna. `reject_12` lo deja fijado.
- **El contrato de política no tiene dueño ni camino de actualización.** Su estado se
  indexa por `(cuenta, regla de contexto)` y toda escritura exige la autorización de esa
  cuenta.
- **El tope del período es el de OpenZeppelin, salvo el paso que corre en cada pago.** Se
  instala, se cambia y se quita llamando a las funciones del límite de gasto de
  OpenZeppelin. La revisión de cada pago (`enforce_period`) es el `enforce` de esa
  librería, sobre la misma entrada de almacenamiento y con los mismos códigos de error,
  sin su evento. Esa única función escribe directo la entrada de la librería, así que la
  versión queda fijada y una versión nueva se compara con ella antes de adoptarla.
- **Autorizar un pago no emite ningún evento de contrato.** Un facilitador x402 acepta un
  pago solo cuando el `transfer` del token es el único evento de contrato de la
  transacción. Cualquier evento publicado dentro de `__check_auth` deja el pago sin poder
  pagarse por un facilitador; lo vimos rechazarlo en testnet
  (`invalid_exact_stellar_payload_event_not_transfer`). El evento `transfer` del token es
  el registro del pago. Las operaciones del dueño siguen emitiendo sus eventos. El mismo
  rechazo ya estaba reportado en el origen antes de que lo encontráramos
  ([x402, issue 3764](https://github.com/x402-foundation/x402/issues/3764), abierto), con la
  propuesta de que un facilitador ignore los eventos de contratos que no sean el activo.
  Mientras eso no cambie, una política que quiera poder pagarse por x402 tiene que callar.
- **En qué se puede equivocar el dueño.** La regla del dueño lo puede todo, por diseño. Dos
  acciones del dueño debilitan una sesión y merecen una pantalla de confirmación en
  cualquier wallet: `remove_policy` sobre una regla de sesión deja la llave de sesión sin
  ningún mandato, y `update_context_rule_valid_until` extiende una sesión. Se revoca
  quitando la regla, nunca quitando la política.
- **Sin revisión de terceros.** Estos son los tests del propio autor. Antes de cualquier
  despliegue en mainnet va una auditoría.

## Compilar y probar

Requisitos: Rust estable con el target `wasm32v1-none`, y
[stellar-cli](https://developers.stellar.org/docs/tools/cli/install-cli) 25.2 o posterior
para compilar a WASM.

```bash
cd contracts
cargo test --workspace -- --test-threads=1   # todas las suites, una línea por caso
stellar contract build                       # WASM en target/wasm32v1-none/release/

# las mismas suites contra el WASM, imprimiendo los costos medidos
AGENTPOS_WASM_DIR="$PWD/target/wasm32v1-none/release" \
  cargo test --workspace -- --nocapture --test-threads=1
```

En Windows con el toolchain GNU los tests no enlazan (una dependencia también se compila
como DLL y supera el límite de símbolos exportados). Usa WSL o Docker:

```bash
docker run --rm -v "$PWD:/work" -w /work rust:1 cargo test --workspace -- --test-threads=1
```

CI corre formato, clippy, la compilación a WASM y todas las suites, en nativo y contra el
WASM, en cada pull request (job `contracts` en `.github/workflows/ci.yml`). El mutation
testing corre aparte (`.github/workflows/mutants.yml`) en los pull requests que tocan
`contracts/`.

## Límites conocidos

- Sin auditoría. Solo testnet hasta que haya una auditoría.
- Un pago a una dirección muxed (`M...`) se rechaza: la lista compara direcciones simples.
- El período es una ventana móvil medida en ledgers, no en días de calendario.
- Una sesión con más de 815 pagos dentro de un período se rechaza hasta que los pagos
  antiguos salgan de la ventana (el límite de la política de OpenZeppelin, que se mantiene).
- La regla del dueño no expira. Quitarla bloquea la cuenta, como en cualquier smart account
  de OpenZeppelin.

## Spike de Stellar 8004

`../spikes/stellar8004` registra un agente en el registro de identidad de Stellar 8004,
escribe feedback desde una llave de tienda distinta con el SHA-256 de un comprobante, y lee
el resumen de reputación, en testnet y con llaves desechables:

```bash
cd spikes/stellar8004 && npm install && npm run spike
```

Lo que mostró y lo que implica para el trabajo de identidad está en
[FINDINGS.es.md](../spikes/stellar8004/FINDINGS.es.md). Vive fuera del workspace de pnpm porque `@trionlabs/stellar8004` 0.0.13 necesita
`@stellar/stellar-sdk` 17, y los paquetes de AgentPOS están en 16.
