# Adapter versions (guardrail 3)

Single source of truth: `packages/core/src/adapter/versions.ts`. This file is the human log.

| Protocol    | Pinned                                                                                                    | Checked    | Source                                                                   | Status in v1                              |
| ----------- | --------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| x402        | wire V2, SDK `@x402/core` + `@x402/stellar` 2.23.0, scheme `exact`                                        | 2026-08-25 | github.com/x402-foundation/x402                                          | End-to-end (checkout + settle)            |
| Facilitator | Built on Stellar, `channels.openzeppelin.com/x402[/testnet]`, CAIP-2 `stellar:testnet` / `stellar:pubnet` | 2026-08-25 | developers.stellar.org/docs/build/agentic-payments/x402/built-on-stellar | Used as-is, never reimplemented           |
| UCP         | manifest `/.well-known/ucp`, version unpinned                                                             | 2026-08-25 | ucp.dev                                                                  | Discovery only; pin + validate in Phase 2 |
| ACP         | 2026-04-17 (feed)                                                                                         | 2026-08-25 | github.com/agentic-commerce-protocol/agentic-commerce-protocol           | Feed only; checkout is a Build slot       |

## Change log

- 2026-08-25: initial pins (Phase 0). x402 Foundation announced spec v1.0 target for Q3 2026;
  weekly watch issue must diff headers, discovery extension and facilitator `/supported`.
- 2026-08-25: facilitator requires a per-network API key (Bearer). `/supported` returns 401
  without it. Testnet keys are issued without login; mainnet keys via GitHub OAuth. Every
  seller running the site library needs their own key (it is free); the CLI must guide this.

## Weekly routine

1. `curl -H "Authorization: Bearer $KEY" https://channels.openzeppelin.com/x402/testnet/supported`
   and compare kinds/extensions.
2. `npm view @x402/stellar version`; read the changelog if it moved.
3. Diff UCP and ACP schemas against the pinned versions; open a PR in `wt-core` if changed.
