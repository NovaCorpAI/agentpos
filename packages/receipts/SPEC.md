# Verifiable Commerce Receipts

**Version:** `agentgate-receipt-1` · **Status:** draft · **Date:** 2026-08-29

This document specifies a signed, hash-chained receipt that a merchant issues for each agentic
sale, and the rules for verifying it. It is written so a third party can verify a receipt with
nothing but the JSON, SHA-256 and Ed25519: no database access, no API, no vendor.

It is the settlement half of the extension draft *Verifiable Agent Commerce Receipts*; the
identity half lives in `@agentgate/identity`.

## 1. Motivation

An agentic purchase settles in seconds and leaves the merchant with a transaction hash. That hash
proves value moved. It does not prove **what was bought, at what price, under what rules, with
whose permission, or on whose authority** — which is exactly what a merchant needs when a buyer
disputes a charge, an accountant reconciles a month, or a regulator asks how an autonomous
counterparty was handled.

Card networks answered this decades ago with an authorization record. Agentic commerce has the
payment and none of the record. Each system reinvents it as a log line, which is to say: as
something the merchant can quietly edit afterwards.

The gap this fills is narrow and concrete: **a per-sale document that binds the offer, the rules,
the consent and the settlement together, that the merchant cannot rewrite after the fact, and
that anyone can check.**

## 2. Design constraints

1. **Verifiable offline.** SHA-256 and Ed25519 over canonical JSON. A verifier needs the receipt
   and nothing else. Checking against the ledger is possible and separate.
2. **Append-only in a way that shows.** Chaining does not prevent tampering; it makes tampering
   detectable by whoever holds a later receipt, which is the property that matters.
3. **No new custody, no new trust anchor.** The signing key holds no funds and belongs to the
   merchant. There is no registry, no notary, no receipt service to be down.
4. **What did not happen is evidence.** Refusals, held payments and expired approvals are
   receipts too. A chain that only records successes is a marketing document.
5. **Never at the expense of the sale.** A store that cannot write a receipt still delivers the
   order it was paid for. Receipts are evidence, not a second point of failure.

## 3. Receipt

```json
{
  "body": { "…": "see 3.1" },
  "hash": "<lowercase hex sha256 of the canonical body>",
  "signature": "<base64 Ed25519 over the payload in 3.3>"
}
```

`hash` and `signature` sit outside `body` so that a verifier recomputes the hash from the body it
was handed, rather than from a field the issuer chose.

### 3.1 Body

| Field | Required | Meaning |
| --- | --- | --- |
| `v` | yes | `"agentgate-receipt-1"` |
| `seq` | yes | 1-based position in this store's chain |
| `prev` | yes | `hash` of the previous receipt, or `"genesis"` for the first |
| `event` | yes | see 3.2 |
| `at` | yes | RFC 3339 timestamp |
| `store` | yes | `{ name, url, signer }`; `signer` is the Ed25519 public key in Stellar StrKey form (`G…`) |
| `cart` | no | `{ id }`, when the receipt is about a cart with no order yet |
| `order` | no | `{ id, cartId, status, externalOrderId? }` |
| `terms` | no | exactly what the payment demand offered (3.4) |
| `policy` | no | `{ decision, code?, message?, evaluatedAt }` |
| `approval` | no | `{ id, status, snapshotHash, resolvedAt?, reason? }` |
| `agent` | no | `{ authenticated, attested, agentKey?, owner?, name? }` |
| `payment` | no | `{ txHash, network, asset, amountMinor, payer?, ts }` |
| `discrepancy` | no | free-form object: why an order is held, or why settlement failed |
| `adapterVersion` | yes | protocol adapter version in effect |
| `traceId` | no | correlates with the merchant's logs |

All monetary amounts are **decimal strings of integers in the asset's minor units** (USDC: 7
decimals). Never floating point, and never a number literal: a receipt is JSON that travels
between languages, and JSON numbers lose integers above 2^53.

### 3.2 Events

| Event | Written when |
| --- | --- |
| `order.settled` | payment settled and the order was placed with the merchant's platform |
| `order.held` | payment settled but did not match the quoted terms; the order was NOT placed |
| `order.failed` | settlement failed after verification; nothing was charged |
| `policy.denied` | the merchant's policy refused the sale |
| `approval.requested` | the order was parked for a human decision |
| `approval.resolved` | a human approved or rejected it, **or the deadline passed with no answer** |

The last row is deliberate. Silence is a decision with consequences, and a chain that omits it
cannot answer "why was this order never fulfilled?".

### 3.3 Signature

Canonical JSON: object keys sorted lexicographically at every depth, members whose value is
`undefined` omitted, arrays in their given order, no insignificant whitespace.

```
hash      = sha256( canonical(body) )                    lowercase hex
signature = Ed25519( "agentgate-receipt-1" ‖ LF ‖ hash )  base64
```

The version prefix domain-separates this signature, so a receipt signature can never be replayed
as an agent request signature, an owner attestation, or any other message in the family.

The signing key MUST NOT be a key that receives payments. It exists to sign statements; giving it
custody of funds would trade an auditing property for a security liability.

### 3.4 Terms

```json
{
  "lines": [{ "itemId": "mug", "title": "Ceramic Mug", "quantity": 1,
              "unitPriceMinor": "99000000", "lineTotalMinor": "99000000" }],
  "totalMinor": "99000000",
  "payTo": "G…",
  "network": "stellar:testnet",
  "asset": "USDC",
  "assetAddress": "C…"
}
```

These are the terms the buyer was shown and agreed to, not a summary written afterwards.

## 4. Verification

### 4.1 A single receipt (offline, mandatory)

A verifier MUST, in order:

1. Parse against the schema; reject otherwise (`RECEIPT_MALFORMED`).
2. Recompute `sha256(canonical(body))` and compare to `hash`. On mismatch, reject
   (`RECEIPT_TAMPERED`) and stop: the signature covers the hash, so nothing else is meaningful.
3. Verify `signature` against `body.store.signer` (`RECEIPT_SIGNATURE_INVALID`).
4. When `terms` is present, check `totalMinor` equals the sum of `lineTotalMinor`
   (`TOTAL_MISMATCH`).
5. When `event` is `order.settled` and both `terms` and `payment` are present, check that the
   payment's amount, asset and network match the terms (`PAYMENT_MISMATCH`).

### 4.2 A chain (offline, mandatory when more than one receipt is held)

For each consecutive pair, a verifier MUST check that `seq` increments by exactly one
(`CHAIN_SEQUENCE_GAP`), that `prev` equals the previous receipt's `hash` (`CHAIN_LINK_BROKEN`),
and that `store.signer` has not changed (`CHAIN_SIGNER_CHANGED`). A first receipt with `seq` 1
MUST carry `prev` of `"genesis"`.

Verification is relative to the receipts presented. A verifier holding a partial run reports gaps
rather than assuming it holds everything: a store handing over an incomplete chain is a fact worth
reporting, not an error to suppress.

### 4.3 The ledger (online, optional)

For a receipt carrying `payment`, a verifier MAY confirm settlement against a Horizon instance for
`payment.network`:

1. `GET /transactions/{txHash}` — the transaction exists and `successful` is true.
2. `GET /transactions/{txHash}/effects` — some `account_credited` effect credits `terms.payTo`
   with `payment.amountMinor` of `payment.asset`, and (when the asset is a classic asset with a
   known issuer) that issuer.

This confirms that the ledger agrees with the receipt on amount, asset and destination. It does
not confirm that the buyer intended the purchase, or that the merchant delivered: a receipt is
evidence of terms and settlement, not of satisfaction.

Verifiers MUST treat an unreachable Horizon as *unknown*, never as *invalid*. The offline
verification in 4.1 stands on its own.

## 5. What a receipt proves, and what it does not

**Proves.** That the store committed to these terms, this policy outcome, this approval and this
settlement at the time it signed; that it has not changed its account since; and, with 4.3, that
the ledger agrees about the money.

**Does not prove.** That the store described its own catalog honestly at the moment of sale. A
merchant can always lie about what a product is; what it cannot do is tell one story to the buyer
and a different one to the auditor afterwards. Nor does it prove delivery, satisfaction, or the
legal identity of any party.

Stating the boundary is part of the specification. A receipt format that implies more than it
proves is worse than none, because it invites reliance it has not earned.

## 6. Security considerations

- **Chain truncation.** Chaining detects edits and deletions in the middle of a run. Dropping the
  *tail* is only detectable by someone holding a later receipt. Buyers therefore SHOULD keep their
  own copy; merchants operating under external audit SHOULD publish the head hash periodically.
- **Key compromise or rotation.** A new signing key starts a new chain and is reported as
  `CHAIN_SIGNER_CHANGED`. Receipts signed by the old key remain verifiable; new ones cannot extend
  the old chain. Implementations SHOULD back up the signing key with the database.
- **Not a ledger.** Receipts are the merchant's own statements. Their value comes from being
  unrewritable and independently checkable, not from consensus.
- **Privacy.** A receipt names an agent key, an owner key and a payer address. It carries no
  buyer contact details, no shipping address and no personal data; implementations MUST NOT add
  them. Publishing receipts publicly is a merchant decision with correlation consequences.
- **Availability.** Writing a receipt MUST NOT be able to fail a paid order. Implementations
  record the failure and continue; a missing receipt is visible as a sequence gap.

## 7. Error codes

| Code | Meaning |
| --- | --- |
| `RECEIPT_NOT_FOUND` | No receipt for that order or hash |
| `RECEIPT_MALFORMED` | Does not match the schema |
| `RECEIPT_TAMPERED` | The body does not hash to the stated hash |
| `RECEIPT_SIGNATURE_INVALID` | The signature does not verify against the named signer |
| `CHAIN_SEQUENCE_GAP` | A link is missing between two receipts |
| `CHAIN_LINK_BROKEN` | A receipt does not point at its predecessor |
| `CHAIN_SIGNER_CHANGED` | The signing key changed mid-chain |
| `TOTAL_MISMATCH` | The total is not the sum of the lines |
| `PAYMENT_MISMATCH` | A settled receipt records a payment contradicting its own terms |

## 8. Audit export

An implementation SHOULD offer an export for a period containing the receipts, the verification
result for exactly those receipts, and a summary (counts by event, settled total, distinct
identified agents). The export MUST carry the verification verdict rather than assert validity:
an export that hid a broken link would defeat its purpose.

## 9. Future work

- Publishing the head hash to a public medium, so tail truncation becomes detectable by anyone.
- Buyer countersignature, turning a merchant statement into a bilateral one.
- Alignment with the x402 settlement response, so the receipt can quote the facilitator verbatim.
- A shared verifier CLI so no party has to trust the other's implementation.

## Reference implementation

`@agentgate/receipts` (Apache-2.0), running in production sidecars.
Conformance vectors: `src/receipts.test.ts`, including verification of a real Stellar testnet
payment against public Horizon.
