# @agentpos/core

Shared foundation for every AgentPOS package.

- `config`: network (testnet default, mainnet gated), facilitator URLs, CAIP-2 ids, USDC issuers.
- `money`: branded integer types (`UsdcMinor`, `Stroops`), 7 decimals, no floats.
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

A **rail** is one way a store can be paid. Today there is exactly one: x402 / USDC over Stellar
(`org.x402.stellar`). The `PaymentRail` interface exists so the next one, a merchant fiat acquirer
or a network agentic credential (plan/RIELES.md), is an addition rather than a rewrite.

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
