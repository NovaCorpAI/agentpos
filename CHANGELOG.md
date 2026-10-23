# Changelog

All public packages share one version. Dates are the day the tag was pushed.

## 0.1.0 (unreleased)

First publication on npm of the open base: `@agentpos/core`, `@agentpos/site`,
`@agentpos/scanner`, `@agentpos/connectors`, `@agentpos/policy`, `@agentpos/approvals`,
`@agentpos/identity`, `@agentpos/receipts`, `@agentpos/mcp-buyer`, `@agentpos/measure`, plus
the unscoped command wrappers `agentpos` and `agentpos-buyer`.

Everything the packages do is described in their READMEs and in `docs/`; the loop they
implement (discover, quote, pay with x402 on Stellar, order created only after settlement,
signed receipt) is proven on mainnet in `docs/EVIDENCE.md`.
