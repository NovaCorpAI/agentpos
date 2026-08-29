# Extension: `agent-commerce-receipts`

## Summary

The `agent-commerce-receipts` extension lets a resource server state, and later prove, **the
commercial context of a payment**: which agent asked, under whose delegated authority, against
which merchant policy, with which human approval, and how that settled.

x402 answers "was this payment valid?". This extension answers the question a merchant is asked
afterwards: *"why did you sell this, to whom, and who said you could?"* It adds two artifacts:

1. an **owner attestation** — a signed statement that an agent key acts on behalf of an owner,
   presented alongside the payment;
2. a **hash-chained merchant receipt** — a signed record per commercial event, including the
   events where no payment happened at all.

Both are verifiable offline by any third party with the JSON, SHA-256 and a signature library.

This document uses RFC 2119 keywords.

---

## Motivation

Agentic payments settle in seconds and leave a transaction hash. That hash proves value moved. It
does not carry what was bought, at what price, under what rules, with whose permission, or on
whose authority.

Merchants selling to autonomous buyers are asked for exactly that, by three parties who will not
accept a log line as an answer:

- **A buyer disputing a charge.** "I never authorised that agent to spend this."
- **An accountant or auditor reconciling a period.** "Show me every sale, and every sale you
  refused, with the terms as offered."
- **A regulator or bank assessing an automated counterparty.** "How do you decide what an agent
  may buy, and who reviews the exceptions?"

Today each implementation answers with application logs: mutable, private, and worthless as
evidence precisely because the party being asked is the party that can rewrite them.

The gap is narrow and concrete: **a per-sale document that binds offer, policy, consent and
settlement, that the merchant cannot rewrite after the fact, and that anyone can check.**

---

## Relationship to existing extensions

This extension deliberately does not re-solve what the ecosystem has already specified. It
composes with two existing extensions and adds only the delta.

| Concern | Where it is already specified | What this extension adds |
| --- | --- | --- |
| Authenticating the paying agent's requests | [`http-message-signatures`](./http-message-signatures.md) (RFC 9421) | Nothing. Implementations SHOULD use RFC 9421 for request authentication. |
| Proving the server committed to the terms it advertised, and issuing a per-payment signed receipt | [`extension-offer-and-receipt`](./extension-offer-and-receipt.md) | Chaining across a merchant's history, commercial context, and negative events. |
| Who authorised the agent to act, and can that authority be withdrawn | not specified | **Owner attestation** and revocation semantics (§ Owner attestation). |
| What the merchant's own rules said, whether a human approved, and what did NOT happen | not specified | **Merchant receipt** (§ Merchant receipt). |

The two additions are not restatements of `offer-receipt` with more fields. They differ in kind:

- `offer-receipt` produces an artifact about **one interaction**, privacy-minimal and
  self-contained by design. A merchant receipt is a link in a **chain**, so that a merchant
  cannot silently drop or rewrite a past sale without the change being detectable to anyone
  holding a later link.
- `offer-receipt` records **that a payment happened**. A merchant's evidentiary burden is mostly
  about the cases where one did not: the sale refused by policy, the payment held because the
  settled terms did not match the quote, the approval that expired because nobody answered.

A merchant receipt MAY embed an `offer-receipt` artifact verbatim in `body.offerReceipt`. Where
both are present, they are complementary: the offer-receipt is the server's statement about that
payment; the merchant receipt is the merchant's statement about that sale, in sequence.

---

## `PaymentRequired`

The resource server advertises support, the identity it requires, and the key its receipts are
signed with.

```json
{
  "extensions": {
    "agent-commerce-receipts": {
      "info": {
        "identityMode": "identified",
        "attestationRequired": false,
        "receiptSigner": "GDTD355XEM6S5DAZGZUO46I3X6YYB4EBHP2UPKA6F7NVGTRCQ7SZNG5P",
        "receiptEndpoint": "https://shop.example/agentgate/orders/{orderId}/receipt",
        "policyDecision": "allowed"
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "identityMode": { "enum": ["open", "identified", "verified-only"] },
          "attestationRequired": { "type": "boolean" },
          "receiptSigner": { "type": "string" },
          "receiptEndpoint": { "type": "string", "format": "uri-template" },
          "policyDecision": { "enum": ["allowed", "requires_approval", "denied"] }
        },
        "required": ["identityMode", "receiptSigner"]
      }
    }
  }
}
```

`identityMode` tells a client, before it signs anything, whether identity is optional
(`open`, `identified`) or a precondition of sale (`verified-only`). A server in `verified-only`
mode MUST refuse the request rather than issue a `PaymentRequired` it will not honour: an agent
must never be charged for an order the server was always going to reject.

`policyDecision` of `requires_approval` signals that a human decision is pending. A server in that
state MUST NOT issue a `PaymentRequired`; see § Human approval.

---

## `PaymentPayload`

The client echoes the extension and presents its owner attestation, base64url-encoded.

```json
{
  "extensions": {
    "agent-commerce-receipts": {
      "info": {
        "attestation": "eyJhdHRlc3RhdGlvbiI6ey…",
        "agentKey": "GAGENT4XKZ5KZQ7WYJ2RSPMHW6ZJ4A7RJ6V2MB6VBSDGLQ4YQ3XKA2LT"
      }
    }
  }
}
```

`agentKey` MUST equal the key that authenticated the request (RFC 9421 `keyid`, where the
`http-message-signatures` extension is in use) and the `agent` field inside the attestation. A
server that cannot establish all three are the same key MUST treat the attestation as absent.

---

## Owner attestation

A signed statement by an owner that an agent key acts on their behalf. It answers the question a
wallet signature cannot: *not* "does this agent control these funds", but "**who put this agent in
charge of them, and are they still willing to say so**".

```json
{
  "attestation": {
    "v": "agentgate-attestation-1",
    "agent": "GAGENT…",
    "owner": "GOWNER…",
    "name": "Ada's shopping agent",
    "issuedAt": "2026-08-29T12:00:00.000Z",
    "expiresAt": "2026-11-27T12:00:00.000Z",
    "scope": { "sites": ["shop.example"], "maxPerTxUsdc": "50" }
  },
  "signature": "<base64 Ed25519>"
}
```

The signature is computed over:

```
"agentgate-attestation-1" ‖ LF ‖ canonical(attestation)
```

**Canonical JSON**, used throughout this extension: object keys sorted lexicographically at every
depth, members whose value is `undefined` omitted, arrays in their given order, no insignificant
whitespace. The version prefix domain-separates the signature so it can never be replayed as a
request signature or any other message in the family.

### Verification

An attestation is valid when the envelope parses, the signature verifies against `owner`,
`issuedAt <= now < expiresAt`, and — when checking a specific request — `agent` equals the
authenticated request signer and `scope.sites`, if non-empty, contains the resource host.

`scope.maxPerTxUsdc` is informational: it states what the owner intended. Servers MAY refuse above
it. The binding limits on spending remain the buyer's own mandate and the merchant's policy.

Validity is a property of the attestation alone. Whether a **valid** attestation is **sufficient**
is the server's policy, expressed as `identityMode`.

### Revocation

An owner revokes by informing servers to stop honouring a key. A server MUST consult its own
record of the key on every authenticated request, so that revocation takes effect on the next
request rather than at a cache expiry, and MUST re-check it at settlement time, so that a key
revoked between quote and payment cannot complete the purchase.

This extension defines no central revocation list and no registry to depend on: a mechanism whose
failure mode is "the revocation service was down, so we honoured the compromised key" is worse
than none. Attestations SHOULD therefore carry short lifetimes.

### Modes

| Mode | Unauthenticated request | Authenticated, no valid attestation | Attested agent |
| --- | --- | --- | --- |
| `open` | allowed | allowed, recorded | recorded |
| `identified` | allowed | allowed, recorded | recorded |
| `verified-only` | refused | refused | allowed |

In every mode, an authentication signature that IS presented MUST be verified. The mode governs
what happens when identity is **absent**, never whether a bad signature is tolerated: a
half-verified identity is worse than no identity, because it invites trust it has not earned.

---

## Merchant receipt

A signed record of one commercial event, chained to the previous one.

```json
{
  "body": {
    "v": "agentgate-receipt-1",
    "seq": 42,
    "prev": "9f2c…",
    "event": "order.settled",
    "at": "2026-08-29T12:00:04.117Z",
    "store": { "name": "Shop", "url": "https://shop.example", "signer": "GSIGNER…" },
    "order": { "id": "ord_…", "cartId": "cart_…", "status": "paid", "externalOrderId": "1042" },
    "terms": {
      "lines": [{ "itemId": "mug", "title": "Ceramic Mug", "quantity": 1,
                  "unitPriceMinor": "99000000", "lineTotalMinor": "99000000" }],
      "totalMinor": "99000000",
      "payTo": "GMERCHANT…",
      "network": "stellar:pubnet",
      "asset": "USDC",
      "assetAddress": "C…"
    },
    "policy": { "decision": "allowed", "evaluatedAt": "2026-08-29T12:00:01.002Z" },
    "approval": { "id": "apr_…", "status": "approved", "snapshotHash": "7ab1…",
                  "resolvedAt": "2026-08-29T12:00:03.400Z" },
    "agent": { "authenticated": true, "attested": true,
               "agentKey": "GAGENT…", "owner": "GOWNER…" },
    "payment": { "txHash": "6e50…", "network": "stellar:pubnet", "asset": "USDC",
                 "amountMinor": "99000000", "payer": "GBUYER…",
                 "ts": "2026-08-29T12:00:04.010Z" },
    "adapterVersion": "agentgate-adapter-2026-08",
    "traceId": "…"
  },
  "hash": "<lowercase hex sha256 of canonical(body)>",
  "signature": "<base64 Ed25519>"
}
```

`hash` and `signature` sit **outside** `body`, so a verifier recomputes the hash from the body it
was handed rather than from a field the issuer chose. The signature is computed over:

```
"agentgate-receipt-1" ‖ LF ‖ hash
```

All monetary amounts are decimal **strings** of integers in the asset's minor units. Never
floating point, and never a JSON number: receipts cross language boundaries, and JSON numbers lose
integers above 2^53.

The signing key MUST NOT be a key that receives payments. It exists to sign statements; giving it
custody of funds trades an auditing property for a security liability. Servers SHOULD publish it
in `PaymentRequired` (`receiptSigner`) and at a stable endpoint.

### Events

| `event` | Written when |
| --- | --- |
| `order.settled` | payment settled and the order was placed in the merchant's system |
| `order.held` | payment settled but did not match the quoted terms; the order was NOT placed |
| `order.failed` | settlement failed after verification; nothing was charged |
| `policy.denied` | the merchant's policy refused the sale |
| `approval.requested` | the order was parked for a human decision |
| `approval.resolved` | a human approved or rejected, **or the deadline passed with no answer** |

Implementations MUST write receipts for the negative events, not only for `order.settled`. This is
the substantive requirement of this section. A chain containing only successful sales is a
marketing document: it cannot answer why an order was never fulfilled, and it lets a merchant
present a curated history as a complete one.

The last row matters for the same reason. Silence on an approval is a decision with commercial
consequences, and it MUST be recorded as one.

### Human approval

Where a merchant policy parks an order for human review, the server MUST NOT issue a
`PaymentRequired` for it. It responds `202 Accepted` with the approval identifier and a polling
location. The client is charged nothing while a human decides, and is charged only against the
approved snapshot.

An approval commits to a hash of the exact order (`snapshotHash`). If the order changes after
approval, the approval is void and the client MUST re-quote.

---

## Verification

### Offline (REQUIRED)

For a single receipt, a verifier MUST, in order:

1. Parse against the schema; otherwise reject (`RECEIPT_MALFORMED`).
2. Recompute `sha256(canonical(body))` and compare with `hash`. On mismatch, reject
   (`RECEIPT_TAMPERED`) and stop: the signature covers the hash, so nothing further is meaningful.
3. Verify `signature` against `body.store.signer` (`RECEIPT_SIGNATURE_INVALID`).
4. Where `terms` is present, check `totalMinor` equals the sum of `lineTotalMinor`
   (`TOTAL_MISMATCH`).
5. Where `event` is `order.settled` and both `terms` and `payment` are present, check the
   payment's amount, asset and network against the terms (`PAYMENT_MISMATCH`).

For a run of receipts, a verifier MUST additionally check, for each consecutive pair, that `seq`
increments by exactly one (`CHAIN_SEQUENCE_GAP`), that `prev` equals the previous `hash`
(`CHAIN_LINK_BROKEN`), and that `store.signer` is unchanged (`CHAIN_SIGNER_CHANGED`). A receipt
with `seq` of 1 MUST carry `prev` of `"genesis"`.

Verification is relative to the receipts presented. A verifier holding a partial run MUST report
gaps rather than assume it holds everything: an incomplete chain is a fact worth surfacing, not an
error to suppress.

### On-chain (OPTIONAL)

For a receipt carrying `payment`, a verifier MAY confirm settlement against the network named in
`payment.network`: that a transaction with `txHash` exists and succeeded, and that it credited
`terms.payTo` with `payment.amountMinor` of `payment.asset`.

Verifiers MUST treat an unreachable node as **unknown**, never as **invalid**. Offline
verification stands on its own; a spec that let a network outage turn valid evidence into invalid
evidence would be unusable in exactly the situation evidence is needed.

### Error codes

`RECEIPT_NOT_FOUND`, `RECEIPT_MALFORMED`, `RECEIPT_TAMPERED`, `RECEIPT_SIGNATURE_INVALID`,
`CHAIN_SEQUENCE_GAP`, `CHAIN_LINK_BROKEN`, `CHAIN_SIGNER_CHANGED`, `TOTAL_MISMATCH`,
`PAYMENT_MISMATCH`, `AGENT_IDENTITY_REQUIRED`, `AGENT_ATTESTATION_INVALID`, `AGENT_REVOKED`.

---

## Audit export

An implementation SHOULD offer an export for a period containing the receipts, the verification
result **for exactly those receipts**, and a summary. The export MUST carry the verification
verdict rather than assert validity: an export that concealed a broken link would defeat its own
purpose.

---

## What this extension proves, and what it does not

**Proves.** That the server committed to these terms, this policy outcome, this approval and this
settlement at the time it signed; that it has not changed its account of them since; and, with the
optional on-chain check, that the ledger agrees about the money.

**Does not prove.** That the merchant described its catalog honestly at the moment of sale. A
merchant can always misrepresent a product; what it cannot do is tell the buyer one story and the
auditor another. Nor does it prove delivery, satisfaction, or the legal identity of any party: an
attestation proves delegation, not identity, and this extension is not KYC.

Stating the boundary is normative content, not modesty. A receipt format that implies more than it
proves is worse than none, because it invites reliance it has not earned.

---

## Security considerations

- **Replay.** Request authentication is delegated to RFC 9421, whose replay protections apply.
  Attestations are not request-bound and MUST NOT be treated as authentication on their own: an
  attestation says who vouches for a key, never that this request came from it.
- **Chain truncation.** Chaining detects edits and deletions inside a run. Dropping the **tail** is
  detectable only by a party holding a later receipt. Buyers SHOULD retain their own copies;
  merchants under external audit SHOULD publish the head hash periodically.
- **Key compromise.** An attested key is exactly as trustworthy as its holder. Owners SHOULD keep
  attestation keys separate from spending keys and MAY use a key never exposed online. Revocation
  is the fast path; short attestation lifetimes are the slow one.
- **Signer rotation.** A new signing key starts a new chain and is reported as
  `CHAIN_SIGNER_CHANGED`. Receipts under the old key stay verifiable but cannot be extended.
- **Privacy.** Receipts name an agent key, an owner key and a payer address, and are therefore
  correlatable across merchants. They MUST NOT carry buyer contact details, shipping addresses or
  other personal data. Agents that require unlinkability SHOULD rotate identity keys per merchant,
  at the cost of re-attestation. Note the deliberate difference from `offer-receipt`, which omits
  the transaction reference for this reason: a merchant receipt includes it because its purpose is
  the merchant's own auditability, and merchants SHOULD treat receipts as confidential records
  released to the counterparty and to auditors, not published.
- **Availability.** Writing a receipt MUST NOT be able to fail a paid order. Implementations
  record the failure and complete the order; the omission is then visible as a sequence gap.
  Evidence must never become a second point of failure in the payment path.
- **Not a ledger.** Receipts are the merchant's own statements. Their value comes from being
  unrewritable and independently checkable, not from consensus.

---

## Reference implementation

[AgentGate](https://github.com/NovaCorpAI/agentgate) (Apache-2.0), a library that turns a site
already selling in fiat into an endpoint agents can buy from. Running against Stellar with the
Built on Stellar facilitator.

| Component | Package | Conformance vectors |
| --- | --- | --- |
| Owner attestation, modes, revocation | `@agentgate/identity` | `src/identity.test.ts` |
| Merchant receipts, chain, verification, export | `@agentgate/receipts` | `src/receipts.test.ts` |
| Merchant policy (`policy.decision`) | `@agentgate/policy` | `src/policy.test.ts` |
| Human approval (`202`, snapshot hash, expiry) | `@agentgate/approvals` | `src/approvals.test.ts` |
| HTTP surface | `@agentgate/site` | `src/{identity,receipts,policy,approvals}.test.ts` |

`@agentgate/receipts` includes a conformance test that verifies a receipt against a real Stellar
testnet payment on public Horizon.

### Known divergence

The reference implementation currently authenticates agent requests with its own canonical form
(`AGENTGATE-REQUEST-V1` over method, path, body hash, timestamp and nonce) rather than RFC 9421.
This predates the alignment described in § Relationship to existing extensions. The normative
requirement in this document is RFC 9421; accepting RFC 9421 signatures alongside the existing
form is tracked as implementation work, not as a change to this specification.

---

## Open questions for the working group

1. Should the merchant receipt be defined as a **profile of** `offer-receipt` (adding `seq`,
   `prev`, and the commercial context to its envelope) rather than a sibling artifact? The authors
   lean yes, and defer to the group on envelope ownership.
2. Is EIP-712 worth supporting for the receipt envelope in EVM deployments, or is canonical JSON
   plus a `format` discriminator sufficient across chains?
3. Should owner attestations reuse the `/.well-known/http-message-signatures-directory` key set
   rather than carrying the owner key inline?
4. Is there appetite for a shared verifier CLI, so no party has to trust the other's
   implementation of § Verification?
