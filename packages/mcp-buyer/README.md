# @agentpos/mcp-buyer

The buyer side (SPEC 02): an MCP server that lets any agent discover, quote and buy from
agent-buyable stores, always inside a **human mandate** the agent cannot edit.

## Human setup

```bash
npx @agentpos/mcp-buyer init --profile default     # encrypted spending wallet + mandate
npx @agentpos/mcp-buyer sites add https://shop.example
```

Mandate (`~/.agentpos/profiles/default.json`): `maxPerTx`, `maxTotal` per `period`
(day/week/month), `allowedSellers` (`any` or a list of hostnames), `requireConfirmAboveUsdc`,
`allowPhysicalGoods`, `shippingAddressLocked`, `allowedNetworks`. Fund the wallet like a prepaid card.

Several networks: a rail package can give `BuyerService` another network to pay on (`networks`,
e.g. `(max) => arcBuyerExtension(ARC_TESTNET, client, max)` from `@agentpos/rail-arc`, with the
client bound to the buyer's own Arc signer). It is used only when the mandate lists that network
in `allowedNetworks` (CAIP-2 ids); without the field the agent pays only on the profile's own
network, whatever is installed. `maxPerTx` and `maxTotal` apply to all networks together: the
spending log keeps every amount in the catalog's unit, so spreading payments across networks
does not reset the period limit. A purchase no allowed network can pay fails with
`NETWORK_NOT_ALLOWED`.

`allowedSellers: "verified-only"` was retired: it asked a hosted seller registry that was never
built, so it refused every site. A profile that still carries it loads as an explicit empty list
(same refusal, legible reason) and prints a `MANDATE_MODE_RETIRED` warning telling you to list
the hostnames you trust, or to set `"any"`. Your profile file is never rewritten for you.

Claude Desktop / Claude Code MCP config:

```json
{
  "command": "agentpos-buyer",
  "args": ["serve", "--profile", "default"],
  "env": { "AGENTPOS_BUYER_PASSPHRASE": "..." }
}
```

## Paying from a mandate account (testnet)

By default the buyer pays from the profile's own wallet, and the mandate is checked here, in
software, before every signature. A profile can instead pay from a **mandate account**: a
Soroban smart account that holds the funds and enforces the mandate on the network. The
profile's key is then only a session key: it can pay within the session its owner issued, and
it can do nothing else on the account.

```bash
agentpos-buyer account show      # the session key to hand to the account's owner
agentpos-buyer account link --account C... --session 3
agentpos-buyer account unlink    # back to the profile's own wallet
```

The owner of the account issues the session for that key (see
[`@agentpos/mandate-contract`](../mandate-contract/README.md)) and tells you its rule number.
`link` reads the session from the network before it saves anything: it refuses a session
that does not exist, that was issued for another key or that has expired, and it prints what
the account will enforce. Rule 0 is the owner's and is refused: an agent never holds the key
that changes its own mandate. Once linked, `show` prints the session as the network has it
now:

```text
balance of the account: 6
cap per payment: 1
cap per period: 2 every about 24 hours (spent now: 1)
sellers it may pay: GCPW...G6CQ
the session ends in about 14 days (ledger 6177535)
```

Every purchase of a linked profile, from the CLI and from the MCP server, is paid by the
account. `list_profiles` shows the link to the agent, and `get_mandate_account` gives it the
same limits `show` prints, so it can check them before it proposes a purchase.

The profile's mandate is still evaluated first. The account's check is the one that holds if
this process is wrong or compromised: a payment over its cap is refused before anything is
sent, with the contract's error code in the message (4105 over the cap per payment, 3221 over
the cap per period, 4106 seller not allowed).

Testnet only: the contracts are not audited, and a linked profile on mainnet refuses to pay.
Code that builds a `BuyerService` itself can pass `contractAccount` to sign some other way.

## The market call

One structured request, asked of every store the mandate allows at the same time, answered with
offers that can be compared side by side.

```bash
agentpos-buyer market "lamina 30x40" --attr Fondo=blanco --attr Passepartout=con --max 40 --qty 2
agentpos-buyer market "lamina 30x40" --attr Fondo=blanco --json
```

`BuyerService.marketCall({ what, attributes?, minPriceUsdc?, maxPriceUsdc?, physical?, quantity?, sites?, timeoutMs? })`
and the MCP tool `market_call` (same arguments) both answer:

```jsonc
{
  "query": { "what": "lamina 30x40", "attributes": { "Fondo": "blanco" }, "quantity": 2 },
  "offers": [
    {
      "store": { "name": "Galeria Dos", "url": "https://dos.example", "host": "dos.example" },
      "itemId": "lamina-blanco",
      "title": "Lamina 30x40 blanco",
      "matchedAttributes": { "Fondo": "blanco" },
      "attributes": { "Fondo": "blanco", "Passepartout": "con" },
      "quantity": 2,
      "unitPrice": "18",
      "unitPriceMinor": "180000000",
      "totalUsdc": "36",
      "totalMinor": "360000000",
      "physical": true,
      "stock": "in_stock",
      "mandate": {
        "payable": false,
        "needsApproval": false,
        "blocks": [
          {
            "reason": "per_payment_cap",
            "code": "MANDATE_EXCEEDED",
            "message": "...",
            "hint": "...",
          },
        ],
      },
    },
  ],
  "stores": [{ "url": "...", "name": "...", "state": "ok", "offers": 2, "total": 2 }],
  "facets": {
    "Fondo": [
      { "value": "blanco", "count": 3 },
      { "value": "negro", "count": 2 },
    ],
  },
}
```

Three promises:

- **Nobody disappears.** `stores[].state` is `ok`, `timeout`, `error` (with a typed code),
  `unsupported-filters` (a store older than structured search: it answered 4xx to the filters, so
  it was asked with the plain `q` call and filtered here) or `not-allowed` (the mandate forbids
  it, so it was never contacted). Each store has its own deadline and its own failure.
- **Nothing is hidden.** An offer the mandate cannot pay is listed with `payable: false` and
  every reason why (`per_payment_cap`, `period_budget`, `physical_not_allowed`,
  `seller_not_allowed`). Hiding the cheapest option because of a limit is how an agent becomes
  confusing. `needsApproval` flags the ones above `requireConfirmAboveUsdc`. Nothing here pays:
  the mandate is still enforced at `buy`.
- **The next question is easy.** `facets` merges what every store can filter on, summing counts
  per value, so "Fondo: blanco 3, negro 2" comes back ready to refine the call.

Offers are sorted by total price ascending (ties by store name), and totals are the unit price
multiplied by `quantity` in minor units, never in decimals.

## Agent tools

`list_profiles`, `search_offers`, `market_call`, `get_site`, `create_cart`, `buy`, `get_order`, `get_spending_log`, `get_mandate_account`.
`buy` never pays outside the mandate: `MANDATE_EXCEEDED`, `SELLER_UNVERIFIED` or
`CONFIRMATION_REQUIRED` are returned instead. For the last one the human runs
`agentpos-buyer approve <cartId>` (see `agentpos-buyer pending`) and the agent calls `buy` again.

When a store's facilitator declines a payment (`PAYMENT_DECLINED`, for example a compliance screen
on Circle's facilitator), `buy` records the network on that cart and stops: a second `buy` signs
nothing. The cart shows up in `agentpos-buyer pending`; if the human approves it, the next `buy`
pays on another network the mandate allows, never on the one that declined. Other payment errors
keep the store's code (`INSUFFICIENT_FUNDS`, `PAYMENT_PENDING`, ...), with `retryable` and the
network in `details`.

Every payment is appended to `~/.agentpos/profiles/<name>.spending.jsonl` with tx hash, site,
order id and summary.

## `watch`: the signing bridge

If you approve purchases somewhere else (the `@agentpos/buyer-web` app, from a browser or
WhatsApp), that approval only queues the purchase: buyer-web holds no key and cannot pay.
`watch` is the half that pays. Run it on the machine that holds the wallet keyfile:

```bash
export AGENTPOS_SIGNER_TOKEN=...        # same value as buyer-web's SIGNER_TOKEN. Env only,
                                        # never a CLI flag: flags leak into process lists.
export AGENTPOS_BUYER_PASSPHRASE=...    # unlocks the local keyfile, as for any purchase
agentpos-buyer watch https://your-buyer-web.example            # poll every 15s
agentpos-buyer watch https://your-buyer-web.example --once     # one pass, for cron
agentpos-buyer watch https://your-buyer-web.example -i 30      # poll every 30s
```

For each approved-and-unpaid proposal it quotes a fresh cart and pays through the same
`BuyerService.buy()` a direct purchase uses, so the profile mandate applies unchanged
(`MANDATE_EXCEEDED`, `SELLER_UNVERIFIED`... refuse exactly as always; the queue is not a
bypass). It also refuses to pay more than the total the human approved
(`REQUOTE_REQUIRED`). Outcomes are reported back (`POST /api/signer/paid` with the tx hash,
`POST /api/signer/failed` with a machine-readable code), printed one line per proposal, and
a failed proposal is never retried in a loop (attempted ids are kept in memory; a restart
retries once). A malformed queue item is reported and skipped, never a crash. The wallet
key never leaves this machine.
