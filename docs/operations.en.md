# Operations guide: running a live agent-buyable store

For a store that is already selling to agents. What to read every day, what each order state
means, and what to do when something goes wrong.

Related: [merchant quickstart](quickstart-merchant.en.md) · [buyer quickstart](quickstart-buyer.en.md) ·
[FAQ](faq.en.md) · alert-by-alert procedures: [RUNBOOK.md](RUNBOOK.md) (Spanish) ·
Spanish: [operations.es.md](operations.es.md)

## The daily loop

```bash
npx @agentpos/site status          # items, last 20 orders, tx hashes, connector errors, holds
npx @agentpos/site status --retry  # same, and retry the platform orders that failed after payment
npx @agentpos/site receipts verify # the signed chain is intact
npx @agentpos/site backup ./backups
curl -s https://YOUR-STORE/agentpos/health
```

`/agentpos/health` answers `200` when the facilitator is reachable and no paid order is stuck,
`503` otherwise, and lists `facilitator`, `facilitators` (one entry per configured facilitator,
host only), `orders.stuck` and the receipt chain height. A store that also takes payments on
another network (Arc, for example) adds `networks`: one entry per extra network, `ok` or
`degraded`. A degraded network is left out of the payment request until its facilitator is back,
and does not turn the answer into `503`: the store still sells on its own network.
The reverse holds too: if the store's own facilitator is down, checkout offers the extra networks
alone. When no network can settle, buyers get `FACILITATOR_UNAVAILABLE` with `Retry-After: 60`
and nothing is charged.

## Reading the dashboard

`https://YOUR-STORE/agentpos/dashboard` is a single self-contained page served by your own
sidecar. No CDN, no fonts, no analytics. Three tabs:

**Metrics** (from `/agentpos/metrics`, aggregates only, windows of 7, 30 or 90 days):

| Figure | What it counts |
| --- | --- |
| paid orders | orders with a settled payment in the window |
| total sold | sum in USDC |
| unique paying wallets | distinct payer addresses |
| identified agents | how many orders carried a verified agent identity |
| checkout to platform order | latency between payment and the order appearing in WooCommerce |
| on hold | paid orders whose settled terms did not match the quote (see below) |
| pending platform order | paid orders whose WooCommerce order has not been created yet |

**Catalog** (from `/agentpos/catalog`): your published items exactly as an agent receives them.
Empty means you have confirmed prices but not run `publish`.

**Rules** (from `/agentpos/dashboard/rules`): the limits and switches this store enforces. It is
read-only by design: the rules live in `agentpos.config.json` on your machine, so nothing remote
can change what you sell or for how much.

> **Who can see it.** Everything on `/agentpos/dashboard` is public on purpose: aggregates with no
> buyer data, your published catalog, and the rules agents are held to. CORS is open on metrics on
> purpose too. Nothing that identifies a buyer is served from this path. The reconciliation export,
> which does carry buyer emails, lives behind your merchant token at
> `/agentpos/api/merchant/export.csv` (next section).

## Reconciliation CSV

The export is private merchant data, so it requires `MERCHANT_API_TOKEN` (see
[Rotating the merchant API token](#rotating-the-merchant-api-token)):

```bash
curl -H "Authorization: Bearer $MERCHANT_API_TOKEN" \
  "https://YOUR-STORE/agentpos/api/merchant/export.csv?from=YYYY-MM-DD&to=YYYY-MM-DD" \
  -o conciliacion.csv
```

Default range: the last 30 days. Bounds accept `YYYY-MM-DD` (whole days) or a full ISO timestamp;
a malformed or inverted range answers `400` with code `CONFIG_INVALID`, and a missing or wrong
token answers `401` `MERCHANT_UNAUTHORIZED`.

One row per order, RFC 4180 quoting, CRLF, UTF-8 BOM so Excel opens it directly. Column headers
follow your `locale` (`en` or `es`); the column order never changes:

`date_iso, order_id, external_order_id, status, items, gross_usdc, rail, asset, tx_hash,
settled_at, buyer_email`

`rail` is derived from the payment network (`x402-stellar` today), so adding a second payment
rail later will not change the file's shape.

The dashboard's Metrics tab does not download the file: it prints this same command for you to
copy. The AgentPOS Cloud panel can download it for you, because it stores that token on your
behalf.

## Order states

| State | Meaning |
| --- | --- |
| `pending_payment` | The order exists because a cart passed checkout, but nothing settled yet. Nobody was charged. |
| `paid` | The payment settled on-chain. The WooCommerce order is created from here, never before. |
| `fulfilled` | Your own platform reports the order as completed. Fulfilment still happens in WooCommerce; the sidecar only mirrors what it says. |
| `cancelled` | Your platform reports the order as cancelled, refunded or failed. The payment record and its receipt are kept, always. |
| `expired` | The cart expired and nothing was ever paid. Only orders with no payment reach this state. |

Every few minutes the sidecar re-reads the platform status of paid orders and mirrors it,
oldest first. The mapping is deliberately small: `completed` becomes `fulfilled`, and
`cancelled`, `refunded` or `failed` become `cancelled`. Any other status (`processing`,
`on-hold`, anything a plugin invents) leaves the order exactly as it is: the sidecar never
guesses what a status it does not know means for your money. A paid order is never expired by
a timer, whatever its cart says.

Two fields matter as much as the state:

- `connectorError` (`{ code, message, attempts }`): paid, but WooCommerce refused to create the
  order. The retry loop is still working on it.
- `hold` (`{ reason: "PAYMENT_MISMATCH", details, at }`): paid, but the settled terms did not
  match the quote. **No WooCommerce order is created and the retry loop will not touch it.**

## An order is held: PAYMENT_MISMATCH

What happened: the facilitator settled a payment whose destination, asset, amount or network does
not match what your store quoted. The payment is recorded with its hash, the order stays `paid`
with the hold, and a critical alert is raised.

1. `npx @agentpos/site status` and find the order and its `txHash`. Open the hash on
   `stellar.expert`.
2. Compare `hold.details.mismatch` against the quote. The two usual cases: a smaller amount
   settled (partial payment) or a different destination (the money did not reach your wallet).
3. Money in the right wallet, only the amount differs: decide with the buyer (refund the
   difference, or ask them to complete it).
4. Different destination: do not ship. Escalate.
5. **Never create the order by hand without resolving the discrepancy first**, and write down
   what you decided. The hold and your decision are already in the receipt chain.

## Paid, but no order in WooCommerce

The payment settled and the platform refused the order. AgentPOS retries automatically with
growing backoff (30s, 1m, 2m, ... capped at 30 minutes) and raises `ORDER_NOT_CREATED`; after an
hour without an order it escalates to `RETRY_LOOP_STALLED`.

1. `npx @agentpos/site status` shows the attempt count and the last error; `/agentpos/health`
   shows `orders.stuck`.
2. Usual causes: REST credentials rotated or without write permission (401/403, not retried),
   the store down (5xx, retried), the product deleted in WooCommerce.
3. Fix the cause, then force a pass: `npx @agentpos/site status --retry`.
4. If the platform genuinely cannot take it, create the order by hand from
   `/agentpos/orders/<id>` (buyer, shipping, hash) and note the external order id in your records.

## Money received with no order: PAYMENT_WITHOUT_ORDER

Only on a store that also takes payments on another network (Arc, for example) whose rail brings
a payment watcher. Every 5 minutes AgentPOS reads what your wallet received on that network and
compares it with the payments it recorded. A transfer still unmatched after 2 minutes raises
`PAYMENT_WITHOUT_ORDER` (critical), once per transaction, with the network, the hash, the payer,
the amount and `candidateOrders`: orders still waiting for payment with the same total.

1. Open the hash in the network's explorer and confirm the money is in your wallet.
2. If it matches a candidate (same amount, the buyer you expected), the store settled the payment
   and then failed to record it: fulfil that order by hand and write down the hash.
3. If it matches no order, it may be unrelated income to that wallet (a transfer you made
   yourself, for instance). If it came from a buyer, refund it. A wallet used only for the store
   keeps this alert meaningful.
4. `/agentpos/health` shows the count under `networks[].reconciliation.paymentsWithoutOrder`, and
   `error` when the last pass could not read the chain.

## Payment declined: PAYMENT_DECLINED

The facilitator refused a signed payment without a documented reason. On Circle's Facilitator
Service (Arc, Base, Polygon) this is how a failed compliance screen looks: Circle screens both the
buyer and the merchant before settling and publishes no reason code for it. **Nobody was charged**
and no order was created. The agent receives `PAYMENT_DECLINED` with the network; it does not
retry, and it does not move the payment to another network unless its human approves it.

You get a warning alert with that code at most once an hour per network. One alert after a single
buyer is usually about that buyer. If buyers keep being declined on the same network, the screen
may be about your own address there: stop offering that network (remove it from the store's
networks) and contact the facilitator's support with your merchant address.

The other refusals of a signed payment reach the agent typed too: `INSUFFICIENT_FUNDS` (its
wallet is short), `PAYMENT_REJECTED` (a stale signature, retryable; or your payment setup on that
network, not retryable), `PAYMENT_PENDING` (settlement unresolved: do not pay again) and
`FACILITATOR_UNAVAILABLE` (retryable, `Retry-After: 60`). None of them raises an alert.

## Settlement failed

`SETTLEMENT_FAILED` (warning): the facilitator verified the payment but failed to settle it.
**Nobody was charged.** The order stays `pending_payment` and the cart remains valid until its
TTL, so the agent can simply try again.

If it repeats across several carts: check `/agentpos/health` (`facilitator`), your API key (a
`401` means the key is missing or belongs to the other network) and the facilitator's own status.

Alerts reach you as JSON lines on the sidecar's stderr (`{"event":"alert","code":...}`) and, when
`AGENTPOS_ALERT_WEBHOOK` is set, as a JSON POST `{ source: "agentpos", code, severity, message,
details, at }`.

## Facilitator failover

A facilitator is the service that checks the buyer's signed transaction and submits it to the
network. If yours is down, new sales stop (orders already paid are unaffected). Configure a
second one and the store keeps selling.

By environment:

```
AGENTPOS_FACILITATOR_URL=...                 # primary
AGENTPOS_FACILITATOR_API_KEY=...
AGENTPOS_FACILITATOR_FALLBACK_URL=...        # fallback
AGENTPOS_FACILITATOR_FALLBACK_API_KEY=...
```

Or in `agentpos.config.json` (this wins over the environment, up to four entries, first is the
primary):

```json
{ "facilitators": [{ "url": "https://primary.example", "apiKey": "..." }, { "url": "https://fallback.example" }] }
```

Verify and settle for one payment always use the same facilitator. A settle is retried on the
next one only when the first attempt provably never connected; anything ambiguous goes through
the stuck-order path above instead of risking a double settlement. `/agentpos/health` lists each
facilitator by host with `ok` / `degraded` and marks the active one. With a single facilitator
nothing changes.

## Rules for agentic sales

All optional, all in `agentpos.config.json`, all evaluated when quoting **and again** before
charging, because your situation may have changed in between:

```json
{
  "policy": {
    "status": "active",
    "maxOrderUsdc": "200",
    "maxPeriodUsdc": "1000",
    "period": "daily",
    "maxQuantityPerItem": 5,
    "maxQuantityPerOrder": 20,
    "excludedItems": ["limited-edition"],
    "allowedShippingCountries": ["CL", "AR"],
    "approvalThresholdUsdc": "100"
  }
}
```

- `status: "suspended"` stops every agentic sale immediately without touching your catalog and
  without affecting human customers.
- `period` is `hourly`, `daily` or `weekly`. The accumulator counts settled orders **plus** orders
  awaiting approval, so a burst of unapproved orders cannot collectively pass your limit.
- `excludedItems` stay on sale for humans.
- Every refusal reaches the agent with a code it can act on: `POLICY_SUSPENDED`,
  `POLICY_ITEM_EXCLUDED`, `POLICY_ITEM_QUANTITY`, `POLICY_ORDER_QUANTITY`, `POLICY_ORDER_LIMIT`,
  `POLICY_PERIOD_LIMIT`, `POLICY_SHIPPING_COUNTRY`.

### Orders that wait for you

Above `approvalThresholdUsdc` the order is parked instead of refused: the agent gets a `202` with
a polling URL and **is not charged** while you decide.

```bash
npx @agentpos/site approvals                              # what is waiting
npx @agentpos/site approvals approve <id>
npx @agentpos/site approvals reject <id> -r "out of stock"
```

Configuration and secrets:

```json
{ "approvals": { "enabled": true, "ttlMinutes": 30, "webhookUrl": "https://your-system.example/hooks/agentpos", "whatsapp": { "from": "whatsapp:+14155238886", "to": "whatsapp:+56912345678" } } }
```

```
AGENTPOS_APPROVAL_SECRET=<long random string>
AGENTPOS_APPROVAL_WEBHOOK_SECRET=<webhook secret>
AGENTPOS_TWILIO_ACCOUNT_SID=AC...
AGENTPOS_TWILIO_AUTH_TOKEN=...
```

Three guarantees: **silence rejects**, never approves (the TTL expires the request and releases
the quote); **you approve exactly what you saw** (the snapshot is hashed, and any change voids the
approval); **nobody can approve for you** (HTTP resolutions must be signed with
`AGENTPOS_APPROVAL_SECRET`; without it the sidecar answers `401` and only the local CLI can
decide).

### Who may buy

`{ "identity": { "mode": "open" | "identified" | "verified-only" } }`. In every mode a signature
that arrives is verified; what the mode changes is what happens when identity is absent. Revoking
is immediate, including for carts already quoted:

```bash
npx @agentpos/site agents                                 # who may buy
npx @agentpos/site agents register ./attestation.json
npx @agentpos/site agents revoke GAGENT... -r "key lost"
```

## Rotating the merchant API token

`MERCHANT_API_TOKEN` is the store owner's bearer token for the read-only merchant API
(`GET /agentpos/api/merchant/summary | orders | orders/:id | receipts | receipts/:seq | rules |
export.csv`). Minimum 24 characters; without it those routes are not mounted at all, the
reconciliation export included. Treat it like a password: it can read your orders, including
buyer emails.

There is **no rotation command**: rotation is editing the environment and restarting.

```bash
openssl rand -hex 24                     # new token
# put it in .env as MERCHANT_API_TOKEN=..., then restart the sidecar:
#   node:    stop `agentpos serve`, start it again
#   docker:  docker restart agentpos
curl -H "Authorization: Bearer <new token>" https://YOUR-STORE/agentpos/api/merchant/summary
```

Update every consumer (AgentPOS Cloud, your own tooling) with the new value. The old token stops
working the moment the sidecar restarts. Wrong or missing token answers `401`
`MERCHANT_UNAUTHORIZED`; the group is rate limited (`rateLimit.merchantApiPerMinute`, default
120/min) with `429` and `Retry-After`. Logs carry an 8-character hash of the token, never the
token.

## Receipts, and how anyone verifies one

Every sale **and every refusal** leaves a signed receipt, chained to the one before it: what was
offered, at what price, what your rules said, who approved it, who bought and the transaction
hash. Events written: `order.settled`, `order.held`, `order.failed`, `policy.denied`,
`approval.requested`, `approval.resolved` (including the expiry nobody decided).

Where they live:

- The chain is in your SQLite database, `<dataDir>/agentpos.sqlite` (default `.agentpos/`).
- The signing key is `<dataDir>/receipt-signer.json`, created on first use unless you set
  `AGENTPOS_RECEIPT_SECRET`. **Back it up with the database.** It signs statements only: it holds
  no money and must never receive any. Lose it and old receipts stay verifiable, but the chain
  restarts under a new key.

```bash
npx @agentpos/site receipts                      # recent receipts, chain height, signing key
npx @agentpos/site receipts verify               # is the chain intact?
npx @agentpos/site receipts export --from 2026-08-01 --to 2026-08-31 -o august.json
```

The buyer gets their own copy at `GET /agentpos/orders/<orderId>/receipt`, and a single receipt is
also addressable by hash at `/agentpos/receipts/<hash>`.

**Verification is offline and needs nobody.** A receipt is JSON: recompute SHA-256 over the
canonical JSON of `body` and check `signature` against `body.store.signer` (Ed25519). Programmatic
form:

```ts
import { verifyReceipt, verifyChain, verifyPaymentOnChain } from "@agentpos/receipts";

verifyReceipt(receipt);              // schema, hash, signature, internal consistency
verifyChain(receipts);               // sequence, linkage, one signer throughout
await verifyPaymentOnChain(receipt); // optional: does the ledger agree about the money?
```

The first two are offline and total. The third is the only part that needs the network, and an
unreachable Horizon returns *unknown*, never *invalid*. The wire format is specified for third
parties in [`packages/receipts/SPEC.md`](../packages/receipts/SPEC.md) and
[`specs/extensions/agent-commerce-receipts.md`](../specs/extensions/agent-commerce-receipts.md).

Writing a receipt can never cost you a sale: if the chain cannot be written the order still
completes, and the gap shows up in `receipts verify`. Turn the whole thing off with
`{ "receipts": { "enabled": false } }` if you have a reason to.

## Routine maintenance

- **Backup:** `npx @agentpos/site backup ./backups` (SQLite `VACUUM INTO`, consistent while
  running). Restore by copying the file over `<dataDir>/agentpos.sqlite` with the sidecar stopped.
  Back up the receipt signing key with it.
- **Upgrade:** stop the sidecar, install the new version, start it. The database schema is
  additive; older databases open without migration.
- **Credential rotation (WooCommerce):** edit `.env`, restart the sidecar, then
  `npx @agentpos/site status --retry` to push any order that failed meanwhile.
- **Logs:** `AGENTPOS_LOG_FORMAT=json` (the default under `serve`) for aggregators, `pretty` for a
  console. Every log line carries a `traceId` that follows one purchase across scan, catalog,
  cart, checkout, settlement and order creation. Search by it.
- **Pausing:** `{ "policy": { "status": "suspended" } }` stops agentic sales while keeping the
  store up. Stopping the sidecar entirely also works, and leaves your store exactly as it was.

## Running your own facilitator

`apps/facilitator` in this repository is a minimal facilitator built on the official SDKs. If you
run it, **you pay your own network fees** from a dedicated account that holds XLM and nothing
else (measured: about 0.0023 XLM per sale). Its own operational procedures, including fee-account
funding and key rotation, are in [RUNBOOK.md](RUNBOOK.md) and `apps/facilitator/README.md`.
