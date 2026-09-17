# FAQ for merchants

Short answers to the questions merchants actually ask. Commands and configuration live in the
[merchant quickstart](quickstart-merchant.en.md) and the [operations guide](operations.en.md).
Spanish: [faq.es.md](faq.es.md)

## Do I need to understand crypto?

No. You need three things: a wallet address to receive money, a price in USDC for each item you
want agents to buy, and your usual WooCommerce admin to fulfil orders. The dashboard and the CLI
speak orders, payments, balance and receipts.

USDC is a dollar-denominated stablecoin: one USDC is intended to be one US dollar. If your
catalog is priced in USD, AgentPOS suggests a one-to-one price and you confirm it. If it is in
another currency, you set the USDC price yourself, because only you know the rate you want to
sell at.

## Who holds my money?

You do, always. The payment moves from the buyer to **your** wallet inside a single transaction.
We do not hold it, the facilitator does not hold it, and there is no intermediate account. The
sidecar refuses to even start if a private key appears in its configuration, so it cannot be
holding funds by accident.

You are the merchant of record for every sale. We take no commission and are not part of the
contract between you and the buyer.

## What if the agent pays the wrong amount?

Then no order is created. A payment whose destination, asset, amount or network does not match
what you quoted leaves the order **on hold** (`PAYMENT_MISMATCH`), the payment is recorded with
its hash, and you get a critical alert. Nothing ships until you decide.

More generally: the WooCommerce order is created **only after** the payment settles on-chain, and
it is idempotent by transaction hash, so a retry never produces two orders. If settlement fails
after verification, nobody is charged at all. Procedures:
[operations](operations.en.md#an-order-is-held-payment_mismatch).

## Can I refuse agent sales, or pause them?

Yes, at four different levels:

- **Per item:** only what you confirm and publish is visible to agents. Everything else keeps
  selling to humans as before.
- **Per rule:** `policy` sets maximums per order and per period, quantity caps, excluded items and
  the countries you accept.
- **Per order:** above `approvalThresholdUsdc` the order waits for your approval, and the agent is
  not charged while you decide. Silence rejects; it never approves.
- **Everything at once:** `{ "policy": { "status": "suspended" } }` stops agentic sales
  immediately without touching your catalog or your human customers. Stopping the sidecar works
  too, and leaves your store exactly as it was.

## Do I keep my current payment methods?

Yes. AgentPOS adds routes; it replaces nothing. Your checkout, your card processor, your bank
transfers and your human customers are untouched. Agent orders arrive in the same WooCommerce
order list, paid, with `payment_method = agentpos`, the transaction hash in `transaction_id` and
`_agentpos_*` metadata so you can tell them apart.

## What happens if AgentPOS disappears?

Nothing you cannot recover from.

- The sidecar, the CLI, the connectors, the trust layer, the buyer and the formats are
  **Apache-2.0 open source**. You can keep running, forking or auditing them regardless of what
  happens to us.
- It runs **on your server**, on your domain, against your own database. There is no call home in
  the payment path.
- Your **receipts verify without us**: a receipt is JSON signed by your own store key, and
  verification is SHA-256 plus Ed25519 against the signer inside the receipt. No API of ours is
  involved. The format is published as a specification for third parties.
- Your money is already in your wallet, not in a balance we hold.

The planned paid service (AgentPOS Cloud: a managed dashboard, long-term receipt archival) is
built on top of these formats, never in front of them. A store that never pays us anything is a
fully functional, fully discoverable store.

## Is my catalog exposed to competitors?

Only what you publish, and only what you would already show. `/agentpos/catalog` and
`/agentpos/feed` contain the items you confirmed, with the descriptions and prices you set: the
same facts on your public product pages, in a format an agent can read. Anything you do not
confirm is never exposed, and `excludedItems` keeps an item selling to humans while hiding it from
agents.

What is **not** exposed: buyer data. `/agentpos/metrics` and the dashboard are aggregates by
construction, with no emails, no addresses and no order ids.

One real caveat: the reconciliation export
(`/agentpos/dashboard/export.csv`) does contain buyer emails and is not authenticated today.
Restrict `/agentpos/dashboard` at your proxy, as described in
[operations](operations.en.md#reading-the-dashboard).

## Taxes and invoicing?

**This is not legal or tax advice, and it depends on your jurisdiction and your own systems.**

What AgentPOS does: it creates a normal paid order in your WooCommerce, with the amount, the items
and the transaction hash. Whatever you already do for an order (invoice, tax document, accounting
export) applies to this one too, through the same plugin or process you use now.

What AgentPOS does not do: it does not issue tax documents, does not decide the tax treatment of a
stablecoin payment, and does not convert anything to your local currency. Those questions belong
to your accountant. A pluggable fiscal adapter (for country-specific electronic invoicing) is
planned and deliberately outside the payment path; **it does not exist in the code today**, so
treat invoicing exactly as you do for any other paid order.

For reconciliation, the CSV export gives your accountant one row per order with the date, ids,
status, items, gross USDC, rail, asset, transaction hash, settlement time and buyer email. See
[operations](operations.en.md#reconciliation-csv).

## Do I have to use mainnet?

No, and you should not start there. Everything works on testnet with free test money, which is how
you verify the whole loop before a single real dollar moves. Mainnet requires an explicit
`AGENTPOS_ALLOW_MAINNET=true`, a mainnet facilitator key and an explicit RPC URL: the sidecar
refuses to guess its way into production.

## Can agents buy anything, from anyone?

You decide. By default any wallet can buy what you published, which is what most stores want. If
you need to know who is on the other side, the store can require agents to sign their requests and
carry an attestation from their owner (`identity.mode`). It reduces anonymity; it is not KYC and
collects no personal data.

## Where do I get help?

- Setup: [merchant quickstart](quickstart-merchant.en.md)
- Running a live store: [operations guide](operations.en.md)
- Alert-by-alert procedures: [RUNBOOK.md](RUNBOOK.md)
- What is open and what is not: [open-core.en.md](open-core.en.md)
- See it working: <https://demo.agentposhq.com> · <https://agentposhq.com>
