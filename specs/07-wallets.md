# SPEC 07: Vinculación de wallets (transversal a 01, 02 y 04)

## Principio

Vincular > generar. La wallet del usuario es SUYA: guardamos solo
direcciones públicas + prueba de control. Generar keypair local queda como
fallback para quien no tiene wallet. Guardrail 1 (cero custodia) intacto.

## Abstracción en core (`packages/core/src/signer.ts`)

Interfaz `SignerProvider` con implementaciones:

- `LocalKeypairSigner` (archivo cifrado local con passphrase)
- `WalletsKitSigner` (browser: Stellar Wallets Kit, que unifica Freighter,
  xBull, Albedo, Lobstr, Ledger, WalletConnect y passkeys bajo una sola
  API; verificar versión vigente y soporte de `signAuthEntry` por wallet
  antes de fijar la matriz)
- `PasskeySigner` (passkey-kit del ecosistema; fase Build, dejar el slot)
  Ningún paquete instancia signers directo: siempre via factory de core.

## Lado vendedor (afecta SPEC 01 y 04)

1. **Vincular wallet existente (default):** el vendedor entra al dashboard
   (o usa el CLI con XDR + link a Stellar Lab si no tiene browser wallet),
   "Conectar wallet" via Wallets Kit, firma un nonce -> probamos control
   de la dirección y la guardamos como `payTo` (watch-only). Cero llaves
   en nuestro lado.
2. **Operaciones que sí requieren firma del vendedor** (solo setup):
   crear trustline USDC si no existe. Flujo: se construye el XDR, la
   wallet conectada lo firma client-side.
3. **Multi-wallet:** un vendedor puede vincular N direcciones y asignar
   `payTo` POR ITEM o por categoría (separar líneas de ingreso, rotación).
   Cada dirección pasa screening (SPEC 06) al vincularse y semanalmente.
4. Retiros: siempre desde SU wallet con SUS medios. Solo mostramos saldo y
   guía off-ramp.

## Lado comprador (afecta SPEC 02)

1. **Spending wallet local (default v1):** el agente firma con keypair
   local dedicado, fondeado por el humano como "tarjeta prepago" +
   mandato. Un agente headless no puede clickear popups de Freighter.
2. **Perfiles múltiples:** `~/.agentpos/profiles/<name>.json` (wallet +
   mandato + network + dirección de envío opcional). Tool `list_profiles`;
   `buy` acepta `profile?`.
3. **Aprobación remota (fase Build, diseñar slot):** `buy` sobre el umbral
   envía push al humano y ESTE firma desde su wallet (passkey/mobile).
   Enum `signerMode: 'local' | 'remote-approval'` reservado.

## Modelo de datos

- Tabla `wallets` (merchant_id, address unique, label, proof_sig,
  screened_at, status active|flagged|removed), local y hosted.
- `catalog_items.pay_to_wallet_id` FK opcional (default: primera activa).

## Tests

- Firma de nonce: casos válido/expirado/dirección ajena.
- Multi-wallet: órdenes a 2 direcciones del mismo vendedor quedan bien
  atribuidas por el indexer.
- E2e: vincular Freighter en testnet (playwright con extensión mockeada o
  signer inyectado), crear trustline via XDR firmado fuera.
