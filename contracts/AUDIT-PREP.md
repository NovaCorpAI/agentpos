# Audit preparation: AgentPOS mandate contracts

[Español](./AUDIT-PREP.es.md)

What a reviewer needs before reading the code: what is in scope, what the contracts rely
on, which properties they claim and the test that pins each one, and what is still open.

This is the author's own preparation. No third party has reviewed these contracts. They
are not deployed.

## Scope

| Crate | Lines | Role |
| --- | --- | --- |
| `mandate-policy/src/lib.rs` | 375 | The mandate: cap per payment, cap per period, seller allowlist. Almost all the logic that is ours. |
| `mandate-account/src/lib.rs` | 76 | The smart account. A constructor that creates the owner rule; everything else is OpenZeppelin's. |
| `ed25519-verifier/src/lib.rs` | 33 | Stateless Ed25519 signature check for session keys. |

Out of scope, and relied on as they are:

- OpenZeppelin `stellar-accounts` 0.8.0 (pinned with `=0.8.0`): the account, the context
  rules, the signature flow and the spending limit policy.
- The Stellar Asset Contract of the token.
- The Soroban host: authorization entries, nonces, storage.

## What the design relies on

1. The host calls the account's `__check_auth` for every call the account must authorize,
   and nothing moves the account's tokens without it.
2. OpenZeppelin's account matches each call to a context rule before any policy runs, and
   rejects a call that no rule matches or whose rule has expired.
3. For a rule with policies, the account does not check the signers itself. Its
   documentation says so: the policy is responsible. Our policy does it.
4. The owner's key is safe. The owner rule can do anything, by design.
5. The token behaves as a Stellar Asset Contract: `transfer(from, to, amount)` moves
   `amount` from `from` to `to` and nothing else.

## Properties and the tests that pin them

All tests are in `mandate-policy/tests/`. They build real authorization entries signed
with Ed25519 and go through the host into `__check_auth`. Each one runs natively and
against the built WASM.

| # | Property | Test |
| --- | --- | --- |
| 1 | A session key moves tokens only with `transfer` from the account | `reject_11`, `attack_13` |
| 2 | Never more than the cap per payment | `reject_01`, `accept_02`, model test |
| 3 | Never more than the cap per period, over a rolling window | `reject_02`, `accept_03`, `accept_04`, `safety_05`, model test |
| 4 | Only to sellers in the list | `reject_03`, model test |
| 5 | Only in the token the session is scoped to | `reject_15` |
| 6 | Only while the session is valid and not revoked | `reject_04`, `reject_05`, `accept_07` |
| 7 | Every signer of the session rule must sign | `reject_12`, `reject_13`, `attack_11`, `attack_12` |
| 8 | A signature covers one payment, one rule, one use | `attack_01` to `attack_05` |
| 9 | A session key cannot change its mandate, its rule or the owner rule | `reject_06` to `reject_10`, `attack_06` to `attack_08` |
| 10 | The policy's entry points do nothing without the account's authorization | `attack_09`, `attack_10` |
| 11 | Accounts that share the policy contract share no state | `safety_01` |
| 12 | A refused or failed payment consumes none of the period | the rejected payments in `reject_*` assert it, `safety_02` |
| 13 | A session cannot authorize a payment nested under another contract's call | `attack_14` |
| 14 | Changing the mandate keeps the payments already made in the period | `accept_05`, `safety_03` |
| 15 | Revoking wipes the mandate's state | `safety_04` |
| 16 | The mandate's storage is renewed on use, and an idle session keeps its terms | `storage_01` to `storage_05` |
| 17 | Invalid terms are refused at issue and at change | `reject_16`, `safety_06` |

The model test (`mandate_model.rs`) checks properties 2, 3, 4, 6 and 7 together: 320
operations from 8 fixed seeds, compared step by step with a second, naive implementation
of the mandate.

Mutation testing (`.github/workflows/mutants.yml`) changes the three contracts in 53
places. 9 changes do not compile and the tests notice the other 44.

## What we checked against the library we reuse

- **Signer validation is deferred to the policy.** Documented in the library
  (`smart_account/mod.rs`, authorization flow, step 4.b). OpenZeppelin's own spending limit
  policy accepts a payment when at least one signer signed. Ours requires all of them
  (property 7).
- **The period counts authorized amounts, not executed transfers.** Known upstream:
  [stellar-contracts issue 908](https://github.com/OpenZeppelin/stellar-contracts/issues/908),
  open since September 2026. A transfer declared under another contract's call still
  consumes budget if that contract returns without making it. A session of this mandate
  cannot build such a tree (property 13). The owner rule can, and the owner is not bound
  by the mandate anyway.
- **The period cap is changed through the library's function.** `set_mandate` calls
  `spending_limit::set_spending_limit` and never writes that policy's storage. That call
  is also the authorization of `set_mandate`. We observed that asking for the account's
  authorization a second time in the same call makes the host refuse it, so it is asked
  once.
- **History limit.** The library keeps at most 815 payments per period and refuses the
  next one until old payments leave the window.

## Open questions for a reviewer

These are not covered by a test, or only partly.

1. **Nothing is deployed.** Every result comes from the Soroban test host, natively and
   with the WASM. Behaviour on testnet has not been observed.
2. **Idle sessions on a real network.** `storage_05` shows that an archived entry comes
   back with its content in the test host. Restoration on the network, and who pays for
   it, has not been checked.
3. **Storage of the account itself.** We tested the lifetime of the mandate's two entries.
   The lifetime of the account's own entries (rules, signers) is the library's and we have
   not examined it.
4. **Duplicate signers.** Property 7 compares counts. It is sound because the library
   builds the list of authenticated signers as a subset of the rule's signers and refuses
   duplicate signers in a rule. We read that in the source; no test of ours forces it.
5. **Amounts near the limits of `i128`.** Caps and amounts are `i128`. The period total is
   summed by the library. No test uses values near the maximum.
6. **No upgrade path.** A defect in the policy means deploying a new one and issuing the
   sessions again. This is a choice, not an oversight, and it has a cost.
7. **The owner key.** One Ed25519 key, no recovery. Losing it locks the account.
8. **Cost in fees.** Instructions and bytes are measured (README). The fee and the rent in
   XLM are not estimated.
9. **The seller list** is compared by address. A payment to a muxed address is refused,
   and a seller that changes its address stops being allowed.

## Reproduce

```bash
cd contracts
cargo test --workspace -- --test-threads=1
stellar contract build
AGENTPOS_WASM_DIR="$PWD/target/wasm32v1-none/release" \
  cargo test --workspace -- --nocapture --test-threads=1
cargo mutants --workspace --test-workspace true --no-shuffle
```

CI runs all of it on every pull request that touches `contracts/`, and prints the SHA-256
of each built WASM.
