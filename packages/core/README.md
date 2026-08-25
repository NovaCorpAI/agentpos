# @agentgate/core

Shared foundation for every AgentGate package.

- `config`: network (testnet default, mainnet gated), facilitator URLs, CAIP-2 ids, USDC issuers.
- `money`: branded integer types (`UsdcMinor`, `Stroops`), 7 decimals, no floats.
- `errors`: `AgentGateError { code, message, hint, retryable }` with a closed code set.
- `adapter/x402`: the only module that imports `@x402/*`. Resource server, route config with
  integer prices, buyer client, settle -> receipt.
- `adapter/ucp`, `adapter/acp`: discovery surfaces (skeletons; schema validation in Phase 2).
- `adapter/versions`: pinned protocol versions and `adapterVersion`.
- `signer`: factory for `local-keypair` (wallets-kit and passkey are reserved slots).
- `llm`: direct-HTTP router (Anthropic Messages API, OpenAI-compatible).
- `fiscal`: `FiscalAdapter` interface (plugins live elsewhere).

```ts
import { resolveConfig, usdc, createResourceServer, buildRouteConfig } from "@agentgate/core";

const cfg = resolveConfig(); // testnet
const server = createResourceServer(cfg);
const route = buildRouteConfig(cfg, { payTo: "G...", amount: usdc("1.25"), reference: "order_1" });
```

Scripts: `pnpm e2e:smoke` (testnet friendbot + trustline + payment, prints tx hashes).
