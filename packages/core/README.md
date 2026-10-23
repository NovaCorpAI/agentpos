# @agentpos/core

Shared foundation for every AgentPOS package.

- `config`: network (testnet default, mainnet gated), facilitator URLs, CAIP-2 ids, USDC issuers.
- `money`: branded integer types (`UsdcMinor`, `Stroops`), 7 decimals, no floats.
  `rescaleMinor` moves an amount between minor units exactly, and refuses to round.
- `chain`: networks as data. CAIP-2 ids, a `ChainProfile` per network (USDC decimals on that
  network, address check, explorer link) and a registry rail packages add to. Stellar ships
  built in; `usdcOnChain(price, caip2)` expresses a catalog price in that network's USDC unit.
- `wallet-proof`: proof that a merchant controls a receiving wallet, by signing a nonce
  (guardrail 1). Stellar uses SEP-53; other families register their verifier.
- `errors`: `AgentPOSError { code, message, hint, retryable }` with a closed code set.
- `adapter/x402`: the only module that imports `@x402/*`. Resource server, route config with
  integer prices, buyer client, settle -> receipt.
- `adapter/rails`: the `PaymentRail` interface and its registry (see "Payment rails" below).
- `adapter/ucp`, `adapter/acp`: discovery surfaces (skeletons; schema validation in Phase 2).
- `adapter/versions`: pinned protocol versions and `adapterVersion`.
- `signer`: factory for `local-keypair` (wallets-kit and passkey are reserved slots).
- `llm`: direct-HTTP router (Anthropic Messages API, OpenAI-compatible).
- `fiscal`: `FiscalAdapter` interface (plugins live elsewhere).

```ts
import { resolveConfig, usdc, createResourceServer, buildRouteConfig } from "@agentpos/core";

const cfg = resolveConfig(); // testnet
const server = createResourceServer(cfg);
const route = buildRouteConfig(cfg, { payTo: "G...", amount: usdc("1.25"), reference: "order_1" });
```

## Payment rails

A **rail** is one way a store can be paid. There are two: x402 / USDC over Stellar
(`org.x402.stellar`, settles on the ledger) and Transbank Webpay / Oneclick for cards in Chile
(`cl.transbank.webpay`, settles at the merchant's own acquirer). The `PaymentRail` interface is
what makes the second an addition rather than a rewrite, and what the next one (a network agentic
credential) will implement too.

```ts
import { createTransbankRail, fiatMinor, minorAmount } from "@agentpos/core";

// The merchant's own commerce code and API key: never ours (guardrail 7).
const card = createTransbankRail({
  environment: "integration",
  commerceCode: process.env.TRANSBANK_COMMERCE_CODE!,
  apiKey: process.env.TRANSBANK_API_KEY!,
  oneclick: { mallCode: "597055555541", childCommerceCode: "597055555542" },
});
const clp = minorAmount(fiatMinor("14990", 0, "CLP"), "CLP", 0); // whole pesos, no floats

// Webpay Plus: a first purchase. The human pays on Transbank's page; verify reports
// PAYMENT_PENDING until then; settle commits the token exactly once.
const first = await card.quote({ payTo: returnUrl, amount: clp, reference: "cart_1" });
// Oneclick: a repeat purchase on a card the buyer enrolled once. No human step.
const again = card.quoteOneclick({ payTo: "store", amount: clp, reference: "cart_2" });
await card.settle({ mode: "oneclick", username: "buyer-42", tbkUser: "tbk_..." }, again.terms);
```

A card settlement produces no transaction hash: its `reference` is the store's buy order, and the
acquirer's authorization code travels in `raw`. `fiatMinor(decimal, decimals, currency)` turns a
source price into an integer minor amount (CLP 0 decimals, USD 2); `fiatDecimals(code)` knows the
exponent.

```ts
import { createX402StellarRail, PaymentRailRegistry, usdcAmount, usdc } from "@agentpos/core";

const rails = new PaymentRailRegistry([createX402StellarRail({ config: cfg })]);
const rail = rails.requireSupporting({ currency: "USDC", amount: usdcAmount(usdc("1.25")) });

const quote = await rail.quote({
  payTo: "G...",
  amount: usdcAmount(usdc("1.25")),
  reference: "cart_1",
});
const decision = await rail.verify(paymentPayload, quote.terms); // never moves money
const settlement = await rail.settle(paymentPayload, quote.terms); // { settled, reference: txHash }
```

Five methods: `supports(ctx)` (network, currency and amount bounds; pure), `quote(input)` (the terms
an agent must satisfy, which for x402 are the 402 payment requirements verbatim), `verify`, `settle`
and `describe()` for discovery surfaces.

Three rules hold for every rail:

- **Adding a rail never changes the store's catalog or order surfaces.** Items, carts, quotes and
  orders are identical whichever rail was used; a rail only adds one more payment handler to
  discovery and one more value in the `rail` column of reconciliation.
- **Money is always an integer in a minor unit** (guardrail 4): `UsdcMinor`, or a `MinorAmount`
  (`{ minor: bigint, currency, decimals }`) for rails that price in another currency. No floats
  anywhere in the interface.
- **A failure says which kind it is.** `RailFailure.kind` is `"rejected"` (the rail answered no;
  deterministic, never retry) or `"unavailable"` (the rail did not answer; retryable, and the only
  case a failover may act on). For settlement, `preSubmission: true` additionally means the request
  provably never reached the rail: guardrail 6 forbids re-submitting anything else. Codes come from
  the underlying adapter unchanged (`PAYMENT_REJECTED`, `SETTLEMENT_FAILED`,
  `FACILITATOR_UNAVAILABLE`); a rail wrapper never relabels a failure.

`PaymentRailRegistry` is ordered and id-indexed: `list()`, `get`/`require`, `firstSupporting(ctx)`,
`describe()`. It holds **no routing policy** — thresholds, preferences and per-agent rules are the
merchant's and belong to `packages/policy`. Rail ids are permanent reverse-DNS strings pinned in
`adapter/versions.ts` (`PAYMENT_RAIL_IDS`, `RESERVED_PAYMENT_RAIL_IDS`).

Scripts: `pnpm e2e:smoke` (testnet friendbot + trustline + payment, prints tx hashes).

## Networks and wallet linking

The core is neutral about which chain a store is paid on. A network is a `ChainProfile`:

```ts
import { registerChainProfile, FAMILY_ADDRESS_CHECKS, usdcOnChain, usdc } from "@agentpos/core";

// A rail package registers its network once, at import.
registerChainProfile({
  caip2: "eip155:5042002",
  family: "eip155",
  label: "Arc testnet",
  testnet: true,
  usdcDecimals: 6,
  isValidAddress: FAMILY_ADDRESS_CHECKS.eip155,
});

usdcOnChain(usdc("1.5"), "stellar:pubnet"); // { minor: 15000000n, decimals: 7 }
usdcOnChain(usdc("1.5"), "eip155:5042002"); // { minor: 1500000n, decimals: 6 }
usdcOnChain(usdc("1.2345678"), "eip155:5042002"); // INVALID_AMOUNT: never rounded
```

Linking a merchant wallet never touches a key: the store issues a challenge, the merchant signs
it in their own wallet, the store verifies it.

```ts
const challenge = createWalletChallenge({
  caip2: "stellar:pubnet",
  address: "G...",
  domain: "shop.example.com",
});
// ...the merchant signs challenge.message in Freighter (SEP-53)...
await verifyWalletProof(challenge, signatureBase64); // throws WALLET_PROOF_INVALID / _EXPIRED
```
