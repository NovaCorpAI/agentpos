# @agentpos/buyer-web

The buyer-side web platform: a human configures their buying agent's **mandate** (spending
limits, allowed stores, physical goods or not) and then watches and decides what the agent
does. The agent proposes purchases with real quotes; the human approves or rejects them.

Three server-rendered pages, zero frontend framework, zero CDN assets:

| Page         | What it does                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/`          | Mandate editor: max per purchase, max per period, allowed stores, physical goods, contact email, linked wallet (public address).     |
| `/proposals` | Pending proposals with Approve / Reject; approved ones show as **approved, awaiting signature** with the exact payment instructions. |
| `/activity`  | Append-only activity log plus the full proposal history.                                                                             |

## The custody rule, plainly

**This server never stores, asks for, or touches a secret key.** The profile holds a public
wallet address (`G...`) and nothing else about the wallet; pasting a secret (`S...`) into the
form is refused with `SECRET_IN_CONFIG`. Consequently, approving a proposal does **not** pay:
it marks the proposal approved and hands back the checkout URL, the amount and the exact
`agentpos-buyer` command to run **on the machine that holds the key**. The UI says
"approved, awaiting signature" because that is exactly what is true. No completed purchase is
ever faked.

## Service layer (channel-agnostic)

`src/service.ts` exports `BuyerWebService` with `searchOffers(query)`,
`propose(itemId, storeUrl, quantity?)`, `approve(proposalId)`, `reject(proposalId)` and
`status()`. The web pages call these functions and nothing else; a future WhatsApp (or any
messaging) adapter calls exactly the same five functions. The JSON API under `/api` mirrors
them one-to-one.

Mandate validation reuses `mandateSchema` from `@agentpos/mcp-buyer` verbatim, and
`propose()` evaluates the mandate against a real store quote **before** the human is
bothered: a proposal that could never be paid is refused with a typed error
(`MANDATE_EXCEEDED`, `SELLER_UNVERIFIED`, ...), not queued.

## Storage

`node:sqlite` (no native dependencies) behind `BuyerWebStorage`: `profiles` (mandate +
public wallet address), `proposals` (pending / approved / rejected / expired) and
`activity`, which is append-only by construction: the class exposes insert and select for it
and nothing else.

## Run

```sh
pnpm --filter @agentpos/buyer-web dev     # http://localhost:8788
```

Environment (all optional):

- `BUYER_WEB_PORT` - default `8788`
- `BUYER_WEB_DB` - SQLite file, default `~/.agentpos/buyer-web.sqlite`
- `AGENTPOS_NETWORK` - `testnet` (default) or `mainnet`

There is deliberately no environment slot for any key or passphrase.

## Test

```sh
pnpm --filter @agentpos/buyer-web test
```

The tests spin a real AgentPOS store in-process (the `packages/mcp-buyer` demo-test
pattern), so proposals carry genuine quotes from genuine carts.
