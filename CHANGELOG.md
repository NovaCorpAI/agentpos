# Changelog

All public packages share one version. Dates are the day the tag was pushed.

## Unreleased

- Site: payments are keyed by network plus transaction hash (risk D2), so a payment on one
  network never stands in for one on another; EVM hashes are compared case-insensitively. Stores
  created before this release migrate their payments table once at startup, in a transaction,
  each row keeping its own network; take a backup first (`npx @agentpos/site backup`).
  `SiteStorage.getPayment` now takes the network first.
- Buyer: the mandate gains `allowedNetworks` (CAIP-2). Absent, the agent pays only on the
  profile's own network; listed, `BuyerService` uses the extra networks a rail brings
  (`networks`). The period limit adds up spending on every network (M2, M3). New error code
  `NETWORK_NOT_ALLOWED`; `createBuyerFetch` accepts network extensions.

## 0.1.2 (2026-10-27)

- Site: an extra network whose facilitator is down (Arc, for example) is left out of the 402
  until it is back, so the store stays payable on its own network. The sidecar no longer exits
  when a facilitator is unreachable at startup: it syncs with the facilitators itself and syncs
  again when a network recovers. `/agentpos/health` reports extra networks under `networks`.
- Site: reconciliation of extra networks. A rail can bring a `PaymentWatcher`; the sidecar
  compares what the merchant's wallet received with the payments it recorded and raises
  `PAYMENT_WITHOUT_ORDER` for money with no order. `createAgentPOS` accepts `x402Networks`.

## 0.1.1 (2026-10-27)

- Published through npm trusted publishing (OIDC) instead of a token, with provenance
  attestations on every package.
- Dependency advisories: zod, body-parser, undici and fast-uri moved to patched versions inside
  the monorepo. `@x402/core` still declares zod 3, which has no patch for GHSA-mrhx-c7xc-m3w5;
  the `@agentpos/core` README shows the one-line override for projects that install from npm.

## 0.1.0 (2026-10-26)

First publication on npm of the open base: `@agentpos/core`, `@agentpos/site`,
`@agentpos/scanner`, `@agentpos/connectors`, `@agentpos/policy`, `@agentpos/approvals`,
`@agentpos/identity`, `@agentpos/receipts`, `@agentpos/mcp-buyer`, `@agentpos/measure`, plus
the unscoped command wrappers `agentpos` and `agentpos-buyer`.

Everything the packages do is described in their READMEs and in `docs/`; the loop they
implement (discover, quote, pay with x402 on Stellar, order created only after settlement,
signed receipt) is proven on mainnet in `docs/EVIDENCE.md`.
