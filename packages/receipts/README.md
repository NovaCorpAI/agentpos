# @agentgate/receipts

The evidence an agentic sale leaves behind.

A transaction hash proves money moved. It does not say what was bought, at what price, under what
rules, with whose permission, or on whose authority. This package produces a **signed,
hash-chained receipt** that binds all of it together, and that anyone can verify with the JSON
alone: SHA-256 and Ed25519, no database, no API, no vendor.

Wire format: [`SPEC.md`](./SPEC.md). Apache-2.0.

## What gets a receipt

Successes and refusals alike. A chain that only records what worked is a marketing document.

| Event | Written when |
| --- | --- |
| `order.settled` | paid, and the order was created in the merchant's platform |
| `order.held` | paid, but the settled terms did not match the quote; no order was created |
| `order.failed` | settlement failed after verification; nothing was charged |
| `policy.denied` | the merchant's policy refused the sale |
| `approval.requested` | the order was parked for a human |
| `approval.resolved` | a human decided, **or the deadline passed with no answer** |

## Merchant side

Receipts are on by default in an AgentGate store; there is nothing to wire.

```bash
npx agentgate receipts                       # recent receipts, chain height, signing key
npx agentgate receipts verify                # is the chain intact?
npx agentgate receipts export --from 2026-08-01 --to 2026-08-31 -o august.json
```

The store signs with a key kept next to its database (`AGENTGATE_RECEIPT_SECRET` overrides it).
That key holds no funds and must never receive any: it exists to sign statements. Back it up with
the database.

## Buyer side

Each order serves its own receipt, whole:

```
GET /agentgate/orders/<orderId>/receipt
```

Keep it. Verification is local:

```ts
import { verifyReceipt, verifyChain, verifyPaymentOnChain } from "@agentgate/receipts";

verifyReceipt(receipt);              // schema, hash, signature, internal consistency
verifyChain(receipts);               // sequence, linkage, one signer throughout
await verifyPaymentOnChain(receipt); // optional: does Horizon agree about the money?
```

`verifyReceipt` and `verifyChain` are offline and total. `verifyPaymentOnChain` is the only part
that needs the network, and an unreachable Horizon returns *unknown*, never *invalid*.

## What it proves

That the store committed to these terms, this policy outcome, this approval and this settlement
when it signed, and has not changed its account since. With the on-chain check, that the ledger
agrees about amount, asset and destination.

**What it does not prove:** that the store described its catalog honestly in the first place, or
that anything was delivered. A merchant can always lie to a buyer; what it cannot do is tell the
buyer one story and the auditor another. Saying so plainly is part of the design.

## Guarantees worth knowing

- **Writing a receipt can never fail a paid order.** If the chain cannot be written, the failure
  is logged, the order still completes, and the gap is visible to verification.
- **Editing is detectable, not prevented.** Change a field and the hash breaks; re-sign it and the
  next receipt still points at the old hash.
- **No personal data.** Keys, amounts, item ids. No buyer contact details, no addresses.
