# Issue draft for `coinbase/x402`

Their `specs/CONTRIBUTING.md` asks for an issue **before** the PR: state the problem, the
approach, and why existing options fall short. Paste the body below as a new issue on
https://github.com/coinbase/x402/issues, then link the PR to it.

Post it from the founder's own GitHub account. Two things to fill in first:

- `<STORE URL>` — a live store the maintainers can curl. Until G2 clears, either leave the whole
  parenthetical out or point at a testnet store; **do not** link something that will 404 or
  answer 502. A broken link in the first paragraph costs more credibility than the demo buys.
- Decide whether to mention Stellar in the title. It is honest and it explains the receipts angle,
  but it also invites "this is a Stellar thing" as a first reaction when the proposal is
  chain-agnostic. Recommended: keep it out of the title, and put it where it belongs, in the
  implementation section.

---

**Title:** Extension proposal: commercial context for a payment (owner attestation + chained
merchant receipts)

---

We have been running x402 in production for a storefront use case (physical and digital goods
sold by an existing merchant, not API calls), and hit a gap we could not close with the existing
extensions. Before writing a spec we would like to check whether the group agrees it is a gap, and
whether the shape below is the right one.

### The problem

x402 answers *"is this payment valid?"*. A merchant selling to autonomous buyers is asked a
different question afterwards, by people who will not accept a log line as an answer:

- a buyer disputing a charge: *"I never authorised that agent to spend this"*;
- an accountant reconciling a period: *"show me every sale, and every sale you refused, with the
  terms as offered"*;
- a bank or regulator assessing an automated counterparty: *"how do you decide what an agent may
  buy, and who reviews the exceptions?"*

The transaction hash proves value moved. It does not carry what was bought, at what price, under
what rules, with whose permission, or on whose authority. Today every implementation answers with
application logs: mutable, private, and worthless as evidence precisely because the party being
asked is the party that can rewrite them.

### Why the existing extensions do not close it

We looked before proposing, and two of them cover more than we expected:

- **`http-message-signatures`** covers agent request authentication over RFC 9421. We adopted it
  as-is and are **not** proposing anything in that area. What it does not cover is *who authorised
  the agent to act*, and how that authorisation is withdrawn.
- **`extension-offer-and-receipt`** covers signed offers and per-payment signed receipts,
  third-party verifiable. That is genuinely useful and we would rather extend it than duplicate
  it. Two things it does not do, both deliberate on its part:
  1. Receipts are **self-contained, not chained**. A merchant can therefore drop or rewrite a past
     sale and no holder of a later receipt can tell.
  2. Receipts record **that a payment happened**. A merchant's evidentiary burden is mostly about
     the cases where one did not: a sale refused by policy, a payment held because the settled
     terms did not match the quote, a human approval that expired because nobody answered.

So the delta we would like to specify is narrow:

1. **Owner attestation** — a signed statement that an agent key acts on behalf of an owner, with
   revocation semantics that take effect on the next request rather than at a cache expiry, and no
   central registry to depend on. (A revocation mechanism whose failure mode is "the service was
   down, so we honoured the compromised key" is worse than none.)
2. **Chained merchant receipt** — a signed record per commercial event carrying the offered terms,
   the merchant policy outcome, the human approval if there was one, the agent identity, and the
   settlement; each committing to the hash of the previous one; **including the events where no
   payment happened**.

Chaining does not prevent tampering. It makes tampering detectable by whoever holds a later
receipt, which is the property that actually matters here.

### What we are not claiming

The spec states its own boundary, and we would want that kept in any merged version: a receipt
proves the merchant cannot change its account of a sale afterwards. It does **not** prove the
account was true to begin with, that anything was delivered, or the legal identity of any party.
An attestation proves delegation, not identity; this is not KYC. A receipt format that implies
more than it proves is worse than none, because it invites reliance it has not earned.

### Draft and implementation

Draft spec, written in the format of `specs/extensions/`:
`specs/extensions/agent-commerce-receipts.md` in
https://github.com/NovaCorpAI/agentgate

Reference implementation is Apache-2.0 and running, not a sketch: `@agentgate/identity` and
`@agentgate/receipts`. It verifies RFC 9421 with conformance tests against Appendix B.2.6
verbatim (the published signature base is reproduced byte for byte and the RFC's own Ed25519
signature verifies against it), and receipt verification is exercised against a real settled
payment on a public explorer. Settlement is on Stellar via the Built on Stellar facilitator, but
nothing in the proposal is chain-specific: the receipt is canonical JSON plus a signature, and the
optional on-chain confirmation step is defined in terms of "the ledger credited this address with
this amount of this asset".

### Open questions we would rather the group decide

1. Should the merchant receipt be a **profile of** `offer-receipt` (adding `seq`, `prev` and the
   commercial context to its envelope) rather than a sibling artifact? We lean yes, and defer on
   envelope ownership.
2. Is EIP-712 worth supporting for the receipt envelope on EVM deployments, or is canonical JSON
   with a `format` discriminator sufficient across chains?
3. Should owner attestations reuse the `/.well-known/http-message-signatures-directory` key set
   instead of carrying the owner key inline?
4. Is there appetite for a shared verifier CLI, so no party has to trust another's implementation
   of the verification rules?

Happy to split this into two smaller extensions (attestation, receipts) if the group prefers, or
to drop the attestation half entirely if identity delegation is already being handled elsewhere
and we missed it.
