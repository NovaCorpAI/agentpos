# Changelog

All public packages share one version. Dates are the day the tag was pushed.

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
