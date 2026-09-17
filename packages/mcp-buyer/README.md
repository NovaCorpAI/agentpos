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
`allowPhysicalGoods`, `shippingAddressLocked`. Fund the wallet like a prepaid card.

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

## Agent tools

`list_profiles`, `search_offers`, `get_site`, `create_cart`, `buy`, `get_order`, `get_spending_log`.
`buy` never pays outside the mandate: `MANDATE_EXCEEDED`, `SELLER_UNVERIFIED` or
`CONFIRMATION_REQUIRED` are returned instead. For the last one the human runs
`agentpos-buyer approve <cartId>` (see `agentpos-buyer pending`) and the agent calls `buy` again.

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
