# Contributing to AgentPOS

Thanks for wanting to help. This project has a small surface of hard rules and a lot of room for
everything else; knowing which is which will save you time.

## The non-negotiables

These are structural. PRs that cross them will be closed with a pointer here, however good the
code is.

1. **Zero custody.** Nothing in this codebase may store private keys or funds belonging to
   merchants or buyers. Linking an existing wallet (public address + proof of control) is the
   default; local key generation is a fallback for the user's own machine only.
2. **No marketplace.** The merchant is always the merchant of record, on their own domain. No
   commission, no central listing, no funds routed through anything we run. Features that turn
   AgentPOS into an intermediary get rejected regardless of how useful they look.
3. **No order without settled payment.** An order in the merchant's platform is created only
   after a successful facilitator `settle` with a transaction hash, idempotent by that hash.
   Never on `verify` alone.
4. **Protocol contact goes through the adapter.** Anything touching x402, UCP or ACP formats
   lives in `packages/core/src/adapter/`. No other package imports a spec shape directly; the
   specs will change and only the adapter should feel it.
5. **Money is integers.** USDC amounts are branded bigints in minor units (7 decimals),
   `packages/core/src/money.ts`. A float touching money is a bug even when the test passes.
6. **The scanner reads only the site it is installed on.** No third-party sites, no exceptions,
   no flags.
7. **Cryptography comes from official SDKs** (`@stellar/stellar-sdk`, `@x402/*`, the official
   MCP SDK). Home-made crypto is rejected on sight.

## Ground rules for changes

- **Conventional commits** (`feat:`, `fix:`, `docs:`, …), small PRs, one topic per PR.
- Code, identifiers and comments in **English**. User-facing docs in `docs/` ship in **English
  and Spanish** — a PR that updates one language updates both.
- Errors are typed, with a machine-readable code and an actionable hint
  (`{ code, message, hint }`): an agent must be able to reason about any error we emit.
- Each package's public API is `src/index.ts`, with TSDoc. If you change a public API, update
  the package README in the same PR.
- No `any` without a comment justifying it. No AGPL dependencies anywhere.

## Definition of done

```bash
pnpm build && pnpm -r typecheck && pnpm lint && pnpm test
```

All green, always. If your change touches the payment or order flow, additionally:

```bash
pnpm gate:check   # the production gate: all 10 checks must stay green
pnpm e2e:testnet  # full loop against real Stellar testnet (needs a facilitator API key)
```

`gate:check` is not a formality — it is what stands between "the tests pass" and "this is safe
to run against other people's money". A PR that turns any of its ten checks red does not merge.

## Getting set up

Node ≥ 22.5 (for `node:sqlite`) and pnpm 11.

```bash
pnpm install
pnpm build
pnpm test
pnpm demo:up      # optional: WooCommerce demo store in Docker, for e2e work
```

The e2e against testnet needs a free facilitator API key; `docs/quickstart.en.md` explains
where it comes from.

## Releasing to npm

Every public package under `packages/` ships together, with one version, from a tag:

```bash
pnpm release:check 0.2.0        # every package.json must already say 0.2.0
git tag v0.2.0 && git push origin v0.2.0
```

The `Release` workflow builds, lints, typechecks, tests, re-runs `release:check` against the
tag, packs every package (the log shows exactly what is uploaded) and publishes with npm
provenance. Packages already on the registry at that version are skipped, so re-running the
workflow after a partial failure is safe. It needs the `NPM_TOKEN` secret in the `npm`
environment of the repository; maintainers hold it, contributors never need it.

Sibling packages depend on each other with `workspace:^`, which npm sees as `^0.2.0`: a patch
of `@agentpos/core` does not force a republish of everything that uses it. `agentpos` and
`agentpos-buyer` are unscoped wrappers that only re-export the binaries of `@agentpos/site`
and `@agentpos/mcp-buyer`, so that `npx agentpos` works as the docs promise.

## Reporting security issues

Do **not** open a public issue for anything that could affect payments, keys or receipts.
Email the maintainers (address in `package.json`) with the details; you will get a response, and
credit if you want it. Everything else: issues and PRs are welcome, in English or Spanish.
