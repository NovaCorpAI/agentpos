# Quickstart: from WooCommerce to an agent-buyable store in 15 minutes (testnet)

AgentGate runs next to your site, reads your catalog, publishes it in the formats AI agents
understand, charges USDC on Stellar and creates the order in your WooCommerce. No marketplace,
no custody: payments go straight to your wallet and you remain the merchant of record.

## What you need

- Node.js 22.5 or newer on the server (or any machine that can reach your store).
- A WooCommerce store over HTTPS and a REST API key: WooCommerce > Settings > Advanced >
  REST API > Add key, permissions **Read/Write**.
- A Stellar address you control (Freighter, Lobstr, xBull...) to receive payments.
- A free facilitator API key for testnet: https://channels.openzeppelin.com/testnet/gen
  (shown once; store it).

## 1. Install and initialize

```bash
mkdir agentgate-sidecar && cd agentgate-sidecar
npx @agentgate/site init
```

Answer the prompts: site URL, store name, `WooCommerce`, your store URL, your Stellar address.
The command writes `agentgate.config.json` and a `.env` with empty slots. Fill them:

```
AGENTGATE_NETWORK=testnet
AGENTGATE_FACILITATOR_API_KEY=<from channels.openzeppelin.com>
AGENTGATE_WOO_CONSUMER_KEY=ck_...
AGENTGATE_WOO_CONSUMER_SECRET=cs_...
```

## 2. Scan

```bash
npx @agentgate/site scan
```

AgentGate reads products through your WooCommerce API and your sitemap and prints
"this is what I understood": one line per item with the source price and a suggested USDC
price (1:1 for USD stores; other currencies are left for you to set). Nothing is published.

## 3. Confirm

```bash
npx @agentgate/site confirm        # interactive, item by item
npx @agentgate/site confirm --all  # accept every suggested price (USD stores)
```

You decide which items agents may buy and at what USDC price, every time.

## 4. Publish and serve

```bash
npx @agentgate/site publish
npx @agentgate/site serve --port 8402
```

`publish` checks the facilitator with your key and marks confirmed items as published.
`serve` starts the sidecar. Reverse-proxy two paths from your domain to it:

```
/.well-known/ucp   -> http://127.0.0.1:8402/.well-known/ucp
/agentgate/*       -> http://127.0.0.1:8402/agentgate/*
```

nginx example:

```nginx
location /.well-known/ucp { proxy_pass http://127.0.0.1:8402; }
location /agentgate/      { proxy_pass http://127.0.0.1:8402; }
```

## 5. What agents see

| URL                                                   | Purpose                                                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `https://your-site/.well-known/ucp`                   | UCP discovery manifest with the `x402-stellar` payment handler                                 |
| `https://your-site/agentgate/catalog`                 | Published items, prices in USDC, search with `?q=`                                             |
| `https://your-site/agentgate/feed`                    | ACP product feed                                                                               |
| `https://your-site/agentgate/mcp`                     | MCP server: `search_items`, `get_item`, `create_cart`, `get_order`, `get_payment_instructions` |
| `POST https://your-site/agentgate/cart`               | Quote for `{ items, buyer, shipping }`                                                         |
| `POST https://your-site/agentgate/checkout?cart=<id>` | x402 checkout: 402 with terms, then payment                                                    |
| `https://your-site/agentgate/orders/<id>`             | Order status, tx hash, WooCommerce order number                                                |

When an agent pays, the facilitator settles on Stellar and the order appears in WooCommerce as
**Processing**, paid with `payment_method = agentgate`, `transaction_id = <stellar tx hash>` and
`_agentgate_*` metadata. You fulfil it like any other order.

## Set rules for agentic sales (optional)

You can bound what agents may buy from `agentgate.config.json`, in the `policy` block. Rules are
evaluated when quoting and **again** before charging, because your situation may have changed:

```json
{
  "policy": {
    "status": "active",
    "maxOrderUsdc": "200",
    "maxPeriodUsdc": "1000",
    "period": "daily",
    "maxQuantityPerItem": 5,
    "excludedItems": ["limited-edition"],
    "allowedShippingCountries": ["CL", "AR"],
    "approvalThresholdUsdc": "100"
  }
}
```

- `status: "suspended"` stops all agentic sales without touching your catalog.
- `excludedItems` stay on sale for humans, just not for agents.
- Above `approvalThresholdUsdc` the order waits for **your approval and is not charged**.
- The period accumulator counts settled orders plus orders awaiting approval, so a burst of
  unapproved orders cannot collectively pass your limit.

Every rejection reaches the agent with a code it can act on (`POLICY_ORDER_LIMIT`,
`POLICY_PERIOD_LIMIT`, `POLICY_ITEM_EXCLUDED`, `POLICY_SHIPPING_COUNTRY`...) and an actionable message.

## Check status

```bash
npx @agentgate/site status          # items, recent orders, connector errors
npx @agentgate/site status --retry  # re-create WooCommerce orders that failed after payment
```

## Try it with a real agent (testnet)

The repository ships an end-to-end script that plays the agent: it scans, publishes, creates a
cart, pays through the real facilitator and verifies the order in WooCommerce:

```bash
pnpm demo:up              # local WooCommerce with seed products
pnpm e2e:testnet          # needs AGENTGATE_FACILITATOR_API_KEY in .env
```

## Going to mainnet

Not yet. Mainnet is locked behind `AGENTGATE_ALLOW_MAINNET=true` and a mainnet facilitator key
(GitHub login at https://channels.openzeppelin.com/gen). See `plan/ROADMAP.md`, gate G2.
