# What is free forever, and what will be paid

One page, so it is a public promise instead of an ambiguity. Spanish version:
[`open-core.es.md`](open-core.es.md).

## Free forever (Apache-2.0, in this repo)

Everything a store needs to sell to agents, with no account at NovaCorpAI and no payment to us,
ever:

- The **sidecar and CLI** (`agentpos`): scan, confirm, publish, serve, status, backup.
- The **connectors** (WooCommerce, generic hook; Shopify when it ships).
- The **whole trust layer**: policies, human approvals, Know Your Agent, signed hash-chained
  receipts, and the per-store metrics dashboard.
- The **buyer** (`agentpos-buyer`): MCP server and reference agent under a human mandate.
- The **facilitator** (`apps/facilitator`): self-hostable, on the official SDKs.
- The **formats and SPECs**: attestations, receipts, the extension draft. Verifiable by anyone
  without our software.

Two commitments that go with it:

1. **No feature moves from this list to the paid one.** The paid layer is built *on top of*
   these formats, never as a gate in front of them.
2. **Leaving costs nothing.** Stop the sidecar and your store is as it was. Your data is in your
   SQLite file, your receipts verify without us, your money never touched us.

## Paid, later: AgentPOS Cloud (hosted, not yet built)

For merchants who want someone else to operate the parts that are annoying to operate. Planned,
in order of likelihood:

| Service | What you pay for |
| --- | --- |
| **Receipt archive** | Long-term retention of your signed receipt chain, periodic publication of the chain head (which closes the truncation caveat the SPEC itself declares), audit exports, a verification portal for your accountant or bank. |
| **Managed dashboard + reconciliation** | Multi-store dashboards, an indexer that reconciles your orders against the Stellar ledger, alerting. |
| **Compliance pack** | Sanctions screening, verified-agent registry, domain verification. |
| **Managed facilitation** | We run the facilitator, fees included, with an SLA. |

Pricing is not set; it will be per-service subscription, never a percentage of sales. **Taking a
cut of transactions is structurally ruled out** — the merchant is the merchant of record and we
do not touch the money, which makes a commission impossible to even implement honestly.

Interested? There is a waitlist link on the site. Joining it commits you to nothing and helps us
order the roadmap by real demand.
