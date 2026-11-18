# Preparación para auditoría: contratos del mandato de AgentPOS

[English](./AUDIT-PREP.md)

Lo que un revisor necesita antes de leer el código: qué está en alcance, en qué se apoyan
los contratos, qué propiedades afirman y el test que fija cada una, y qué sigue abierto.

Esta es la preparación del propio autor. Ningún tercero ha revisado estos contratos. No
están desplegados.

## Alcance

| Crate | Líneas | Rol |
| --- | --- | --- |
| `mandate-policy/src/lib.rs` | 375 | El mandato: tope por pago, tope por período, lista de vendedores. Casi toda la lógica que es nuestra. |
| `mandate-account/src/lib.rs` | 76 | La smart account. Un constructor que crea la regla del dueño; todo lo demás es de OpenZeppelin. |
| `ed25519-verifier/src/lib.rs` | 33 | Verificación de firmas Ed25519, sin estado, para las llaves de sesión. |

Fuera de alcance, y usados tal como son:

- OpenZeppelin `stellar-accounts` 0.8.0 (fijada con `=0.8.0`): la cuenta, las reglas de
  contexto, el flujo de firmas y la política de límite de gasto.
- El Stellar Asset Contract del token.
- El host de Soroban: entradas de autorización, nonces, almacenamiento.

## En qué se apoya el diseño

1. El host llama al `__check_auth` de la cuenta para cada llamada que la cuenta debe
   autorizar, y nada mueve los tokens de la cuenta sin eso.
2. La cuenta de OpenZeppelin asocia cada llamada a una regla de contexto antes de que
   corra cualquier política, y rechaza una llamada sin regla o con la regla expirada.
3. En una regla con políticas, la cuenta no revisa los firmantes por sí misma. Su
   documentación lo dice: la responsable es la política. La nuestra lo hace.
4. La llave del dueño está a salvo. La regla del dueño lo puede todo, por diseño.
5. El token se comporta como un Stellar Asset Contract: `transfer(from, to, amount)` mueve
   `amount` de `from` a `to` y nada más.

## Propiedades y los tests que las fijan

Todos los tests están en `mandate-policy/tests/`. Construyen entradas de autorización
reales firmadas con Ed25519 y pasan por el host hasta `__check_auth`. Cada uno corre en
nativo y contra el WASM compilado.

| # | Propiedad | Test |
| --- | --- | --- |
| 1 | Una llave de sesión mueve tokens solo con `transfer` desde la cuenta | `reject_11`, `attack_13` |
| 2 | Nunca más que el tope por pago | `reject_01`, `accept_02`, test de modelo |
| 3 | Nunca más que el tope por período, sobre una ventana móvil | `reject_02`, `accept_03`, `accept_04`, `safety_05`, test de modelo |
| 4 | Solo a vendedores de la lista | `reject_03`, test de modelo |
| 5 | Solo en el token al que la sesión está acotada | `reject_15` |
| 6 | Solo mientras la sesión esté vigente y sin revocar | `reject_04`, `reject_05`, `accept_07` |
| 7 | Deben firmar todos los firmantes de la regla de sesión | `reject_12`, `reject_13`, `attack_11`, `attack_12` |
| 8 | Una firma cubre un pago, una regla y un uso | `attack_01` a `attack_05` |
| 9 | Una llave de sesión no puede cambiar su mandato, su regla ni la regla del dueño | `reject_06` a `reject_10`, `attack_06` a `attack_08` |
| 10 | Las entradas de la política no hacen nada sin la autorización de la cuenta | `attack_09`, `attack_10` |
| 11 | Las cuentas que comparten el contrato de política no comparten estado | `safety_01` |
| 12 | Un pago rechazado o fallido no consume nada del período | los pagos rechazados de `reject_*` lo afirman, `safety_02` |
| 13 | Una sesión no puede autorizar un pago anidado bajo la llamada a otro contrato | `attack_14` |
| 14 | Cambiar el mandato conserva los pagos ya hechos en el período | `accept_05`, `safety_03` |
| 15 | Revocar borra el estado del mandato | `safety_04` |
| 16 | El almacenamiento del mandato se renueva con el uso, y una sesión inactiva conserva sus términos | `storage_01` a `storage_05` |
| 17 | Los términos inválidos se rechazan al emitir y al cambiar | `reject_16`, `safety_06` |

El test de modelo (`mandate_model.rs`) revisa las propiedades 2, 3, 4, 6 y 7 juntas: 320
operaciones a partir de 8 semillas fijas, comparadas paso a paso con una segunda
implementación ingenua del mandato.

El mutation testing (`.github/workflows/mutants.yml`) cambia los tres contratos en 53
lugares. 9 cambios no compilan y los tests notan los otros 44.

## Qué revisamos contra la librería que reusamos

- **La validación de firmantes se delega a la política.** Está documentado en la librería
  (`smart_account/mod.rs`, flujo de autorización, paso 4.b). La política de límite de gasto
  de OpenZeppelin acepta un pago cuando firmó al menos un firmante. La nuestra exige a
  todos (propiedad 7).
- **El período cuenta montos autorizados, no transferencias ejecutadas.** Conocido en el
  origen:
  [stellar-contracts, issue 908](https://github.com/OpenZeppelin/stellar-contracts/issues/908),
  abierto desde septiembre de 2026. Una transferencia declarada bajo la llamada a otro
  contrato consume presupuesto aunque ese contrato retorne sin hacerla. Una sesión de este
  mandato no puede armar ese árbol (propiedad 13). La regla del dueño sí puede, y de todos
  modos el dueño no está sujeto al mandato.
- **El tope del período se cambia con la función de la librería.** `set_mandate` llama a
  `spending_limit::set_spending_limit` y nunca escribe el almacenamiento de esa política.
  Esa llamada es además la autorización de `set_mandate`. Observamos que pedir la
  autorización de la cuenta por segunda vez en la misma llamada hace que el host la
  rechace, así que se pide una sola vez.
- **Límite del historial.** La librería guarda como máximo 815 pagos por período y rechaza
  el siguiente hasta que los pagos antiguos salgan de la ventana.

## Preguntas abiertas para un revisor

No están cubiertas por un test, o solo en parte.

1. **No hay nada desplegado.** Todos los resultados vienen del host de pruebas de Soroban,
   en nativo y con el WASM. El comportamiento en testnet no se ha observado.
2. **Sesiones inactivas en una red real.** `storage_05` muestra que una entrada archivada
   vuelve con su contenido en el host de pruebas. La restauración en la red, y quién la
   paga, no se ha comprobado.
3. **El almacenamiento de la cuenta misma.** Probamos la vigencia de las dos entradas del
   mandato. La vigencia de las entradas propias de la cuenta (reglas, firmantes) es de la
   librería y no la hemos examinado.
4. **Firmantes duplicados.** La propiedad 7 compara cantidades. Es correcta porque la
   librería arma la lista de firmantes autenticados como un subconjunto de los firmantes de
   la regla y rechaza firmantes duplicados en una regla. Lo leímos en el código; ningún
   test nuestro lo fuerza.
5. **Montos cerca de los límites de `i128`.** Los topes y los montos son `i128`. El total
   del período lo suma la librería. Ningún test usa valores cercanos al máximo.
6. **Sin camino de actualización.** Un defecto en la política implica desplegar una nueva
   y emitir las sesiones otra vez. Es una decisión, no un descuido, y tiene un costo.
7. **La llave del dueño.** Una llave Ed25519, sin recuperación. Perderla bloquea la cuenta.
8. **Costo en comisiones.** Las instrucciones y los bytes están medidos (README). La
   comisión y el arriendo en XLM no están estimados.
9. **La lista de vendedores** se compara por dirección. Un pago a una dirección muxed se
   rechaza, y un vendedor que cambia de dirección deja de estar permitido.

## Reproducir

```bash
cd contracts
cargo test --workspace -- --test-threads=1
stellar contract build
AGENTPOS_WASM_DIR="$PWD/target/wasm32v1-none/release" \
  cargo test --workspace -- --nocapture --test-threads=1
cargo mutants --workspace --test-workspace true --no-shuffle
```

CI corre todo esto en cada pull request que toca `contracts/`, e imprime el SHA-256 de
cada WASM compilado.
