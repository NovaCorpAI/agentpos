# @agentgate/mcp-buyer

The buyer side (SPEC 02): an MCP server that lets any agent discover, quote and buy from
agent-buyable stores, always inside a **human mandate** the agent cannot edit.

## Human setup

```bash
npx @agentgate/mcp-buyer init --profile default     # encrypted spending wallet + mandate
npx @agentgate/mcp-buyer sites add https://shop.example
```

Mandate (`~/.agentgate/profiles/default.json`): `maxPerTx`, `maxTotal` per `period`
(day/week/month), `allowedSellers` (`any` | hostnames | `verified-only`), `requireConfirmAboveUsdc`,
`allowPhysicalGoods`, `shippingAddressLocked`. Fund the wallet like a prepaid card.

Claude Desktop / Claude Code MCP config:

```json
{
  "command": "agentgate-buyer",
  "args": ["serve", "--profile", "default"],
  "env": { "AGENTGATE_BUYER_PASSPHRASE": "..." }
}
```

## Agent tools

`list_profiles`, `search_offers`, `get_site`, `create_cart`, `buy`, `get_order`, `get_spending_log`.
`buy` never pays outside the mandate: `MANDATE_EXCEEDED`, `SELLER_UNVERIFIED` or
`CONFIRMATION_REQUIRED` are returned instead. For the last one the human runs
`agentgate-buyer approve <cartId>` (see `agentgate-buyer pending`) and the agent calls `buy` again.

Every payment is appended to `~/.agentgate/profiles/<name>.spending.jsonl` with tx hash, site,
order id and summary.
