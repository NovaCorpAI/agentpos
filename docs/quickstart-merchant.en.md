# Merchant quickstart: sell to AI agents in under 30 minutes

For a merchant who already runs a **WooCommerce** store. At the end your store answers agent
traffic on your own domain, charges USDC on Stellar, and the paid order lands in your WooCommerce
admin like any other order.

Related: [buyer quickstart](quickstart-buyer.en.md) · [operations guide](operations.en.md) ·
[FAQ](faq.en.md) · Spanish: [quickstart-merchant.es.md](quickstart-merchant.es.md)

## What does not change

- AgentPOS adds new routes (`/agentpos/*`, `/.well-known/ucp`, `/openapi.json`, `/llms.txt`).
  It changes none of your existing pages, themes, plugins or payment methods.
- Payments arrive **directly in your wallet**. We never hold your money and charge no commission.
- Nothing is published until you confirm it, item by item, price by price.
- Stop the sidecar and your store is exactly as it was.

## Before you start (5 min)

| You need | Where |
| --- | --- |
| A machine that can run a process next to your store | Node.js >= 22.5, or Docker |
| A WooCommerce store over HTTPS | yours |
| A WooCommerce REST API key, Read/Write | see step 1 |
| A Stellar address you control (`G...` or `C...`) | Lobstr, Freighter, xBull... |
| A facilitator API key | testnet: <https://channels.openzeppelin.com/testnet/gen> (no login); mainnet: <https://channels.openzeppelin.com/gen> (GitHub sign-in) |

> **Install source.** The packages are not published to npm yet (the repository is private until
> launch week). Until then you install from the repo: `pnpm install && pnpm build`, and run
> `node packages/site/bin/agentpos.js <command>` where this guide writes `npx @agentpos/site
> <command>`. After launch both forms are identical, and the installed binary is called
> `agentpos`.

## 1. WooCommerce REST key (3 min)

WP Admin -> **WooCommerce -> Settings -> Advanced -> REST API -> Add key**.
Description `agentpos`, your admin user, permissions **Read/Write**, Generate.

Copy the **Consumer key** (`ck_...`) and **Consumer secret** (`cs_...`). They are shown once.
This key is how AgentPOS reads your products and creates paid orders. Nothing else. Revoke it
from the same screen whenever you want.

## 2. Run the sidecar

### Option A: Node (simplest on the store's own server)

```bash
mkdir agentpos && cd agentpos
npx @agentpos/site init
```

`init` asks for: your public site URL, the store name agents see, where orders live
(`WooCommerce`), the WooCommerce URL, and your Stellar address. It writes
`agentpos.config.json` and creates `.env` with the slots to fill.

`init --generate-wallet` exists as a fallback and creates an encrypted local keypair instead.
Prefer linking a wallet you already control: AgentPOS only ever needs your **public** address.

### Option B: Docker

The repository ships the exact image the public demo store runs
([`apps/demo-store/deploy/Dockerfile.sidecar`](../apps/demo-store/deploy/Dockerfile.sidecar)),
built from the monorepo root:

```bash
docker build -f apps/demo-store/deploy/Dockerfile.sidecar -t agentpos-sidecar .
```

The image runs as the non-root `node` user, works out of `/data` and its default command is
`agentpos serve` on port 8402. Put `agentpos.config.json`, `.env` and the `.agentpos` data
directory in the mounted volume, and make sure that directory is writable by uid 1000:

```bash
mkdir -p /srv/agentpos && chown -R 1000:1000 /srv/agentpos
# one-off commands (init, scan, confirm, publish) override the default command:
docker run --rm -it -v /srv/agentpos:/data agentpos-sidecar \
  node /app/packages/site/bin/agentpos.js init
# the long-running sidecar:
docker run -d --name agentpos --restart unless-stopped \
  -p 127.0.0.1:8402:8402 -v /srv/agentpos:/data agentpos-sidecar
```

A full compose file with WordPress, MariaDB and the sidecar together (the production deployment
of <https://demo.agentposhq.com>) is
[`apps/demo-store/deploy/docker-compose.prod.yml`](../apps/demo-store/deploy/docker-compose.prod.yml).
Copy it if you are starting a store from scratch.

### Option C: generate the files from a form

`@agentpos/merchant-web` is a four-step wizard that writes the same two files for you: store URL
and name with a live probe of your WooCommerce keys, your wallet address (a pasted secret is
refused instantly), the generated `agentpos.config.json` and `.env` to download, and the proxy
snippets plus the verification checklist. It also generates the key your panel needs
(`MERCHANT_API_TOKEN`, see step 3), shows it in step 4 with a copy button, and can check it
against your live store.

```bash
pnpm --filter @agentpos/merchant-web dev    # http://localhost:8410 (PORT to change)
```

It is stateless on purpose: no accounts, no database, nothing stored server-side. Your keys are
used for exactly one probe against your own store and come back inside the generated `.env`. You
still run the commands in step 5 yourself.

## 3. Fill `.env` (2 min)

```
AGENTPOS_NETWORK=testnet
AGENTPOS_FACILITATOR_API_KEY=<your facilitator key>
AGENTPOS_WOO_CONSUMER_KEY=ck_...
AGENTPOS_WOO_CONSUMER_SECRET=cs_...
MERCHANT_API_TOKEN=<your panel key>
```

**Your panel key.** `MERCHANT_API_TOKEN` is the key that lets the AgentPOS panel read your
orders. It is read only: with it your orders, your receipts and your rules can be read, and
nothing else. It cannot move your money, change your prices or publish items. The wizard in
option C writes one for you; if you filled `.env` by hand, make your own with
`openssl rand -hex 24` (24 characters minimum, or AgentPOS refuses to start). Once your store is
running, connect it to the panel at app.agentposhq.com with your store address and this key. If
you lose it, write a new one on that line, restart AgentPOS and connect the panel again: the old
one stops working right then. Leave the line out entirely and the panel simply has nothing to
read.

Keys are per network, so you can keep both and switch networks safely:
`AGENTPOS_FACILITATOR_API_KEY_TESTNET` and `AGENTPOS_FACILITATOR_API_KEY_MAINNET` win over the
generic one. The full list of variables with comments is [`.env.example`](../.env.example).

Secrets live in `.env` on your server and nowhere else. `agentpos.config.json` refuses to start
if it contains a Stellar secret seed (`SECRET_IN_CONFIG`).

## 4. `agentpos.config.json`: the fields that matter

`init` writes the first five. The rest have working defaults, and you only touch them when you
want to.

| Field | Default | What it does |
| --- | --- | --- |
| `siteUrl` | (asked) | Your public store URL. Every agent-facing URL is built from it. |
| `displayName` | (asked) | The store name agents see. |
| `payTo` | (asked) | The Stellar address that receives every payment. Public address only. |
| `platform` | `none` | `woocommerce`, `generic` (your own `createOrder` hook) or `none` (orders recorded locally only). |
| `woocommerce.baseUrl` | (asked) | Your WordPress URL. HTTPS required (`allowInsecureHttp` is for local demos). |
| `basePath` | `/agentpos` | Path prefix for every AgentPOS route. |
| `cartTtlMinutes` | `15` | How long a quote stays payable. |
| `dataDir` | `.agentpos` | Local SQLite database, drafts and the receipt signing key. |
| `locale` | `en` | Language of the dashboard and the reconciliation CSV headers (`en` or `es`). |
| `policies` | (unset) | Your shipping, returns, cancellation and contact text, published in the UCP manifest. |
| `policy` | sell everything | Limits on agentic sales: see [operations](operations.en.md#rules-for-agentic-sales). |
| `approvals` | enabled, 30 min | Park large orders for your decision instead of refusing them. |
| `identity` | `open` | Whether agents must prove who they are. |
| `receipts` | enabled | Signed proof of every sale and every refusal. |
| `rateLimit` | 60/min carts and checkouts | Per-IP limits, plus 10 checkout attempts per cart. |
| `facilitators` | (unset) | Ordered list, primary first, for failover. See [operations](operations.en.md#facilitator-failover). |

## 5. Scan, confirm, publish (10 min)

```bash
npx @agentpos/site scan       # reads YOUR store and proposes a catalog. Nothing is published.
npx @agentpos/site confirm    # you review each item and set its USDC price
npx @agentpos/site publish    # checks the payment rail and exposes the catalog
```

- `scan` reads your products through the WooCommerce API plus your sitemap and pages, and prints
  one line per item with the source price and a suggested USDC price. Options: `--max-pages <n>`
  (default 200) and `--no-llm`. **It only ever reads your own domain.**
- WooCommerce **variable products** are expanded into one item per purchasable variation, with
  its own SKU, price and stock. A paid order for a variation lands in Woo with the exact variant.
- `confirm` is interactive, item by item; `confirm --all` accepts every suggested price at once
  (only for items that got one). The USDC price is always a human decision.
- `publish` fails loudly if your facilitator key is missing or does not match the network, and it
  validates the discovery surfaces against the pinned official schemas before exposing anything.

Then start the sidecar:

```bash
npx @agentpos/site serve            # port 8402, all interfaces
npx @agentpos/site serve -p 8402 -H 127.0.0.1
```

## 6. Route four paths from your domain

The sidecar must answer on **your** domain, not on a port. nginx:

```nginx
location /.well-known/ucp { proxy_pass http://127.0.0.1:8402; }
location /agentpos/       { proxy_pass http://127.0.0.1:8402; }
location = /openapi.json  { proxy_pass http://127.0.0.1:8402; }
location = /llms.txt      { proxy_pass http://127.0.0.1:8402; }
```

Caddy:

```
handle /.well-known/ucp { reverse_proxy 127.0.0.1:8402 }
handle /agentpos/* { reverse_proxy 127.0.0.1:8402 }
handle /openapi.json { reverse_proxy 127.0.0.1:8402 }
handle /llms.txt { reverse_proxy 127.0.0.1:8402 }
```

`/openapi.json` and `/llms.txt` are what the x402 directories and crawlers read first, so leaving
them out means agents can transact with you but will not find you.

## 7. Verification checklist

Run these against your real domain. No screenshots, no trust required:

```bash
curl -s https://YOUR-STORE/.well-known/ucp      | head    # UCP manifest with the payment handler
curl -s https://YOUR-STORE/agentpos/catalog     | head    # your published items, prices in USDC
curl -s https://YOUR-STORE/openapi.json         | head    # how an agent discovers you
curl -s https://YOUR-STORE/agentpos/health                # ok: true, facilitator reachable
open   https://YOUR-STORE/agentpos/dashboard              # your sales dashboard

# your panel key: 200 with it, 401 without it. Both answers matter.
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $MERCHANT_API_TOKEN" \
  https://YOUR-STORE/agentpos/api/merchant/summary
curl -s -o /dev/null -w '%{http_code}\n' https://YOUR-STORE/agentpos/api/merchant/summary
```

A `404` on that last address means your store is running an older version of AgentPOS: update it
and start `agentpos serve` again. A `401` with the key means the key you sent is not the one in
the `.env` your store is running.

Also served, no configuration needed: `/agentpos/feed` (ACP product feed), `/agentpos/mcp` (MCP
endpoint), `/llms.txt`, `/agentpos/metrics`.

If `/agentpos/health` answers `503`, read the `facilitator` and `orders.stuck` fields and go to
the [operations guide](operations.en.md).

## 8. Test a real purchase (testnet)

The reference buying agent does exactly what a stranger's agent would do:

```bash
# discovery and quoting only, no wallet and no funds needed:
npx @agentpos/mcp-buyer demo https://YOUR-STORE --dry-run

# a real testnet purchase, after creating a buyer profile:
npx @agentpos/mcp-buyer init
npx @agentpos/mcp-buyer demo https://YOUR-STORE --item <itemId> -q 1
```

A dry run ending at the payment step means your store is ready. A real run prints the transaction
hash and a `stellar.expert` link. Check three things:

1. The order is in your WooCommerce as **Processing**, already paid, with
   `payment_method = agentpos`, `transaction_id = <hash>` and `_agentpos_*` metadata. You fulfil
   it like any other order.
2. The USDC is in **your** wallet.
3. The hash is public on `stellar.expert`.

Full buyer setup: [buyer quickstart](quickstart-buyer.en.md). You can also point the buyer at our
public demo store, <https://demo.agentposhq.com>, but note it runs on **mainnet**: a purchase
there without `--dry-run` spends real money.

## What it costs

- **Testnet: free.** Test XLM comes from friendbot (the buyer `init` calls it for you), test USDC
  from <https://faucet.circle.com>.
- **Mainnet:** the buyer pays in USDC; the network fee for submitting the payment is paid by the
  facilitator (the public Built on Stellar one sponsors it; if you run your own, measured cost is
  about 0.0023 XLM per sale). Your own wallet needs a small XLM balance (about 2 XLM) to exist and
  to be able to receive USDC: buy it inside your wallet app, once.
- **AgentPOS charges nothing.** No commission, no listing fee, no cut of your sales. We never
  touch the money: it moves from the buyer to your wallet inside a single transaction.
- Mainnet also requires `AGENTPOS_ALLOW_MAINNET=true`, a mainnet facilitator key and an explicit
  `AGENTPOS_RPC_URL`. The sidecar refuses to guess any of them.

## When something looks wrong

Every AgentPOS error carries a machine-readable code, a message and a hint. The three most common
at setup:

| Symptom | Usual cause | Fix |
| --- | --- | --- |
| `401` while scanning | REST key pasted wrong, or not Read/Write | check `AGENTPOS_WOO_CONSUMER_KEY` / `_SECRET` in `.env` |
| `publish` fails on the payment rail | facilitator key missing or for the wrong network | check `AGENTPOS_FACILITATOR_API_KEY` and `AGENTPOS_NETWORK` |
| agents cannot find the store | proxy missing the routes | step 6, then `curl https://YOUR-STORE/agentpos/health` |

For a store that is already selling (orders on hold, stuck settlements, facilitator failover,
reconciliation, receipts), go to the **[operations guide](operations.en.md)**. Merchant questions
without a command attached are answered in the **[FAQ](faq.en.md)**.
