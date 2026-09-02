# Onboarding a WooCommerce store (assisted guide)

Goal: from "WooCommerce store selling in fiat" to "store agents can buy from on mainnet" in
**under 30 minutes assisted** (under 15 for a dev). This is the guide we use in the pilot; every
step has a time budget, and it ends with a verification that does not depend on our word.

**What does NOT happen when you install this**, stated first:

- Nothing touches your existing store: AgentGate adds new routes (`/agentgate/*`); it changes
  none of yours. Human customers notice nothing.
- Nobody holds your money: payments arrive **directly in your Stellar wallet**, in USDC. No
  intermediate account, no AgentGate commission.
- Nothing is published without your confirmation: the scanner proposes, **you set every price**
  and decide what goes live.
- You can leave whenever you want: stop the sidecar and your store is exactly as it was.

## Have at hand

| Thing | Where |
| --- | --- |
| WordPress admin access | your store |
| A box that can run a process (the store's own server works) | Node 22.5+ or Docker |
| Access to the web server / proxy config (nginx, Apache, Caddy or Cloudflare) | your hosting |
| A phone for the wallet | App Store / Play Store |

During the pilot, installation is from a package we hand you (the repo opens publicly at
launch); everything else in this guide is identical.

## Step 1 (5 min): your Stellar wallet

This is where your money arrives. It is yours; we never see the key.

1. Install **Lobstr** (lobstr.co) and create a wallet.
2. **Write the recovery phrase on paper.** Lose it and nobody can recover it; let someone see it
   and they can take your funds. It is your responsibility and no one else's.
3. Enable USDC: in Lobstr, "Assets" → search **USDC (Circle)** → add. You need ~2 XLM of balance
   to activate the account and that line (Lobstr sells you the minimum by card).
4. Copy your **public address** (starts with `G...`). That is the only thing you give us.

## Step 2 (5 min): WooCommerce REST key

This is how AgentGate creates orders in your admin (and nothing else; revoke it any time).

1. WP Admin → **WooCommerce → Settings → Advanced → REST API → Add key**.
2. Description `agentgate`, your admin user, **Read/Write** → Generate.
3. Copy the **Consumer key** (`ck_...`) and **Consumer secret** (`cs_...`). Shown only once.

## Step 3 (5 min): install and configure the sidecar

On your server:

```bash
npx agentgate init
```

It asks, in order: your store's public URL, name, **your `G...` address from step 1**, platform
(`woocommerce`) and the WordPress URL. Then paste into the `.env` it creates:

```
AGENTGATE_WOO_CONSUMER_KEY=ck_...
AGENTGATE_WOO_CONSUMER_SECRET=cs_...
AGENTGATE_NETWORK=mainnet
AGENTGATE_ALLOW_MAINNET=true
AGENTGATE_FACILITATOR_URL=...      # provided during the pilot (see note)
AGENTGATE_FACILITATOR_API_KEY=...
```

> **Pilot note:** the facilitator is the service that submits payments to the Stellar network and
> pays the network fee (~$0.002 per sale). During the pilot you use NovaCorp's at no cost. It is
> swappable by config: point at the public Built on Stellar one or run your own whenever you
> like; your store does not change.

## Step 4 (5 min): scan, price, publish

```bash
npx agentgate scan       # reads YOUR store (only yours) and proposes the catalog
npx agentgate confirm    # you review each item and set its USDC price; nothing ships without you
npx agentgate publish    # verifies the payment rail and exposes the catalog
npx agentgate serve      # leaves the sidecar running on :8402
```

## Step 5 (5 min): one rule in your proxy

Your domain must forward two paths to the sidecar. With nginx:

```nginx
location /.well-known/ucp { proxy_pass http://127.0.0.1:8402; }
location /agentgate/       { proxy_pass http://127.0.0.1:8402; }
location = /openapi.json   { proxy_pass http://127.0.0.1:8402; }
location = /llms.txt       { proxy_pass http://127.0.0.1:8402; }
```

(`agentgate serve` prints the exact snippet for nginx, Caddy, Apache and Cloudflare.)

## Step 6 (5 min): verify, trusting nobody

```bash
# 1. Your store describes itself to agents:
curl https://YOUR-STORE/openapi.json | head

# 2. A real agent walks the whole flow WITHOUT paying:
npx agentgate-buyer demo https://YOUR-STORE --dry-run
```

If the demo ends in "Dry run: stopping before payment", your store is ready. We make the first
real purchase together, on a cheap item, and you verify three things:

1. The order appears in your WooCommerce with the transaction hash.
2. The USDC lands in **your** Lobstr (not in any account of ours).
3. The hash is public: `stellar.expert/explorer/public/tx/<hash>`.

## Your dashboard

`https://YOUR-STORE/agentgate/dashboard` shows your agent sales: orders per day, totals, latency,
unique buyers. Aggregates only (no email, no address, ever), served from **your** domain, so
sharing it is your call like any page of yours.

## Day-to-day

```bash
npx agentgate status              # orders, hashes, errors
npx agentgate approvals           # big orders waiting for your ok (if you set that threshold)
npx agentgate receipts verify     # your receipt chain is intact
npx agentgate backup              # local database backup
```

## If something breaks

Every AgentGate error carries a code and a suggested action. The three most common at setup:

| Symptom | Usual cause | Fix |
| --- | --- | --- |
| `401` while scanning | REST key pasted wrong | check `ck_`/`cs_` in `.env` |
| `publish` fails on the payment rail | facilitator or network misconfigured | check `AGENTGATE_FACILITATOR_*` |
| Agents cannot find the store | proxy missing the routes | step 5; try `curl https://YOUR-STORE/agentgate/health` |
