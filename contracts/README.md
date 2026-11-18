# AgentPOS mandate contracts (Soroban)

[Español](./README.es.md)

A person lets their buying agent spend within a mandate: how much per payment, how much per
period, and at which sellers. AgentPOS already checks that mandate in software before every
signature. These contracts are its on-chain counterpart: the limit is checked by the
network inside the account's `__check_auth`, so it holds even if the agent's key leaks.

**Status: testnet only, not audited.** Nothing here goes to mainnet before an audit.

## What is here

| Crate | What it is |
| --- | --- |
| `mandate-account` | The human's smart account. An OpenZeppelin `stellar-accounts` smart account that is created with one owner rule. |
| `mandate-policy` | The mandate as a smart account policy: cap per payment, cap per period, seller allowlist. |
| `ed25519-verifier` | Stateless Ed25519 verifier for session keys. One deployment serves every account. |

Most of this is composition. The account, the context rules, the signature flow and the
rolling spending window are OpenZeppelin's (`stellar-accounts` 0.8.0, pinned). What AgentPOS
adds is the mandate policy and the way the pieces are arranged.

## How the mandate maps to the chain

| Mandate rule | Where it is enforced |
| --- | --- |
| Only USDC transfers | The session's context rule is scoped to the USDC contract (`CallContract`), and the policy accepts only `transfer(from = account, to, amount)` |
| Cap per payment | `mandate-policy` (`OverPaymentCap`, 4105) |
| Cap per period | `mandate-policy`, reusing OpenZeppelin's spending limit (`SpendingLimitExceeded`, 3221) |
| Seller allowlist | `mandate-policy` (`SellerNotAllowed`, 4106) |
| Session expiry | The context rule's `valid_until` ledger, checked by the account |
| Revocation | The owner removes the context rule; the next payment finds no rule |
| Owner-only changes | Management calls need the account's own authorization, which only the owner rule can give |

Owner operations:

- **Issue session:** `add_context_rule(CallContract(usdc), name, valid_until, [session key], {policy: MandateParams})` on the account.
- **Set policy:** `set_mandate(per_payment_cap, period_cap, sellers, context_rule_id, smart_account)` on the policy.
- **Revoke session:** `remove_context_rule(context_rule_id)` on the account.

Amounts are integers in the token's smallest unit (USDC has 7 decimals on Stellar).

## See it run

One story, step by step, against the contracts: the agent buys within its mandate, tries
to go past it, its key leaks, the owner revokes.

```bash
cd contracts && ./demo.sh          # add --wasm to run it against the built WASM
```

It is a test like the others (`mandate-policy/tests/mandate_demo.rs`): real signatures, the
real authorization path, every step asserted. It prints what happens in plain words.
`AGENTPOS_DEMO_PAUSE_MS=1700` pauses between steps, for a recording;
`video/tapes/scene-mandate.tape` records it.

## Acceptance matrix

`mandate-policy/tests/mandate_matrix.rs` runs every case through the host's real
authorization path: each call carries a Soroban authorization entry for the account, signed
with an Ed25519 key, and passes through `__check_auth`, the verifier and the policy. The
token is a Stellar Asset Contract, like USDC. Each rejection is asserted together with its
contract error code, and with the balance and the period total left untouched.

| Case | Expected |
| --- | --- |
| Payment within the caps to an allowed seller | accepted |
| Payment of exactly the cap per payment | accepted |
| Payments that add up to exactly the cap per period | accepted |
| Payment after the period rolls over | accepted |
| Owner sets the policy, the new terms apply | accepted |
| Owner issues a second session with its own mandate | accepted |
| Owner revokes the session | accepted |
| Owner pays under the owner rule, outside the agent's mandate | accepted |
| Payment over the cap per payment | rejected, 4105 |
| Payment over the cap per period | rejected, 3221 |
| Payment to a seller that is not allowed | rejected, 4106 |
| Payment after the session expired | rejected, 3002 |
| Payment after the session was revoked | rejected, 3000 |
| Policy change signed by the agent | rejected, 3002 |
| Policy change signed by the agent claiming the owner rule | rejected, 3002 |
| Session issued by the agent | rejected, 3002 |
| Session revoked by a non-owner | rejected, 3002 |
| Session extended by the agent | rejected, 3002 |
| Token call that is not a transfer (`approve`) | rejected, 4103 |
| Payment without the session signature | rejected, 4107 |
| Payment signed by an unknown key | rejected, 3016 |
| Payment of zero | rejected, 4104 |
| Payment in a token the session is not scoped to | rejected, 3002 |
| Mandate with invalid terms | rejected, 4101 |

## Beyond the matrix

The matrix shows that each rule rejects what it should. Four more suites go after
everything around the rules, and mutation testing checks the suites themselves.

### Adversarial tests

`mandate-policy/tests/mandate_adversarial.rs`. What a thief with the session key, a
careless relayer or the owner of another account can try.

| Attempt | Result |
| --- | --- |
| Replaying a signed payment | refused (the nonce is spent); paid once |
| Raising the amount after the agent signed | refused (the signature no longer matches) |
| Swapping the recipient for another allowed seller after signing | refused |
| Submitting a payment under a looser session than the one the agent signed for | refused (the signature binds the rule) |
| Attaching the agent's signature of another payment | refused |
| The agent removes the policy from its own session | rejected, 3002 |
| The agent adds a signer to the owner rule | rejected, 3002 |
| The agent reaches the policy through the account's `execute` | rejected, 3002 |
| A session rule with the policy and no signer at all, paid without a signature | rejected, 4107 |
| A session with two signers, paid with one signature | rejected, 4107 |
| A token call with the shape of a transfer and another name (`burn_from`) | rejected, 4103 |
| A payment declared under another contract's call, which could return without paying and still spend the budget | rejected, 3002 |
| Calling the policy's `enforce`, `install`, `uninstall` or `set_mandate` without the account's authorization | refused; state untouched |
| The owner of another account changes this account's mandate | refused |

And the accounting:

- Two accounts share one policy contract and none of its state.
- A payment that fails downstream (not enough balance) consumes none of the period.
- Lowering the period cap below what was already spent blocks payments until the window
  moves on; past payments still count.
- Revoking wipes the mandate's state, and a new session starts with a clean period.
- The period is a rolling window: a payment stops counting exactly `period_ledgers` after
  it was made, not at a fixed reset.
- The seller list holds exactly 32 addresses: 32 are accepted, 33 are refused (4102).

### Model test

`mandate-policy/tests/mandate_model.rs`. The mandate is written a second time, the naive
way: a list of accepted payments and six conditions. A generator then produces 320
operations from 8 fixed seeds (payments of any amount, including zero, negative and one
unit over each cap; to allowed and not allowed parties; signed by the agent, by an unknown
key or by nobody; at ledgers that land before, on and after the period boundary and the
session expiry). After every operation the contracts and the model must agree on the
answer, on both balances and on the period total. A failure names its seed and step, so it
reproduces exactly.

### Storage lifetime

`mandate-policy/tests/mandate_storage.rs`. Soroban storage is rented: an entry that is not
renewed gets archived. A mandate keeps two entries per session, its terms and the period's
history. The other suites give every entry a lifetime longer than the test, so these five
tests use short lifetimes and read the entries directly.

- A new mandate starts with the network's minimum lifetime.
- A payment, or reading the mandate, renews both entries to 30 days.
- Nothing is renewed while more than 29 days remain, so the agent does not pay rent on
  every purchase.
- A session left idle for longer than its storage keeps the same terms: a payment over the
  cap or to another seller is still refused. This is what the test host does, where an
  archived entry is brought back when it is read. It has not been checked on testnet yet.

### The same tests against the WASM

By default the contracts run as native Rust inside the test host. With
`AGENTPOS_WASM_DIR` pointing at the built `.wasm` files, every suite above runs against
those artifacts instead, which is what gets deployed. CI runs both.

### What enforcement costs

Metered by the host with the WASM contracts (`mandate_costs.rs`), for the whole
transaction: the token transfer, the account's `__check_auth`, the Ed25519 verification and
the policy.

| Operation | CPU instructions | Ledger entries written | Bytes written |
| --- | --- | --- | --- |
| Agent payment, first of the period | 2,580,802 | 4 | 912 |
| Agent payment, fourth of the period | 2,607,605 | 4 | 1,152 |
| Agent payment over the cap (rejected) | 2,259,385 | 0 | 0 |
| Owner sets the policy | 3,062,095 | 3 | 1,000 |
| Owner issues a session | 3,668,047 | 7 | 1,692 |
| Owner revokes a session | 3,128,711 | 7 | 776 |

Each payment adds one entry to the period's history (about 80 bytes) until it leaves the
window. CI fails if a payment goes over 4,000,000 instructions; that is our own regression
ceiling, not a network limit.

### Mutation testing

The suites above test the contracts. Mutation testing tests the suites: cargo-mutants
breaks the code one small change at a time (a `>` turned into `>=`, an `&&` into `||`, a
function body emptied) and runs every suite against each change. A change that no test
notices is a gap in the tests.

Over the three contracts it makes 53 changes. 9 do not compile and the tests notice the
other 44; none goes unnoticed. The first full run left 3 unnoticed, and each became a test:
the seller list at its limit, and a token call with the shape of a transfer and another
name. An earlier partial run had found that nothing tested a session with a missing
signature when there are several signers, and that nothing tested storage renewal.

It runs in `.github/workflows/mutants.yml` and fails if any change goes unnoticed. It
shows that the tests notice these changes. It does not show that the contracts are
correct, and it is no substitute for an audit.

## Security notes

What the design relies on, stated so a reviewer can check it. The full list of properties,
each with its test, and the questions still open are in [AUDIT-PREP.md](./AUDIT-PREP.md).

- **The limit is in the authorization path.** The policy runs inside the account's
  `__check_auth`. There is no entry point that moves funds and skips it; a transfer that
  the mandate refuses never reaches the token.
- **Checks fail closed.** Anything the policy does not recognize is refused: another
  function, another token, a missing argument, an address it cannot read, a missing
  signature. If the mandate's storage entry were ever missing, payments are refused
  (`NotInstalled`), not allowed.
- **A rule with a policy defers signer validation to the policy.** That is how
  OpenZeppelin's account works. The mandate therefore requires every signer of the session
  rule to have signed; without that check a payment within the caps would need no
  signature at all. `reject_12` pins it.
- **The policy contract has no owner and no upgrade path.** Its state is keyed by
  `(account, context rule)` and every write requires that account's authorization.
- **The reused policy is used through its public functions only.** The period cap is
  installed, enforced, changed and removed by calling OpenZeppelin's spending limit
  functions; the mandate never writes that policy's storage. The library version is
  pinned all the same.
- **What the owner can still get wrong.** The owner rule can do anything, by design. Two
  owner actions weaken a session and are worth a confirmation screen in any wallet:
  `remove_policy` on a session rule leaves the session key with no mandate at all, and
  `update_context_rule_valid_until` extends a session. Revoke by removing the rule, never
  by removing the policy.
- **Not reviewed by a third party.** These are the author's own tests. An audit comes
  before any mainnet deployment.

## Build and test

Requirements: Rust stable with the `wasm32v1-none` target, and
[stellar-cli](https://developers.stellar.org/docs/tools/cli/install-cli) 25.2 or later for
the WASM build.

```bash
cd contracts
cargo test --workspace -- --test-threads=1   # every suite, one line per case
stellar contract build                       # WASM in target/wasm32v1-none/release/

# the same suites against the WASM, printing the metered costs
AGENTPOS_WASM_DIR="$PWD/target/wasm32v1-none/release" \
  cargo test --workspace -- --nocapture --test-threads=1
```

On Windows with the GNU toolchain the tests do not link (a dependency also builds as a DLL
and exceeds the export limit). Use WSL or Docker:

```bash
docker run --rm -v "$PWD:/work" -w /work rust:1 cargo test --workspace -- --test-threads=1
```

CI runs format, clippy, the WASM build and every suite, natively and against the WASM, on
every pull request (job `contracts` in `.github/workflows/ci.yml`). Mutation testing runs
apart (`.github/workflows/mutants.yml`) on pull requests that touch `contracts/`.

## Known limits

- Not audited and not deployed yet. Testnet only until an audit.
- A payment to a muxed address (`M...`) is refused: the allowlist compares plain addresses.
- The period is a rolling window measured in ledgers, not calendar days.
- A session with more than 815 payments inside one period is refused until old payments
  leave the window (a limit of the reused OpenZeppelin policy).
- The owner rule has no expiry. Removing it locks the account, as in any OpenZeppelin smart
  account.

## Stellar 8004 spike

`../spikes/stellar8004` registers an agent in the Stellar 8004 identity registry, writes
feedback from a separate store key with the SHA-256 of a receipt, and reads the reputation
summary back, on testnet, with throwaway keys:

```bash
cd spikes/stellar8004 && npm install && npm run spike
```

What it showed and what it means for the identity work is in
[FINDINGS.md](../spikes/stellar8004/FINDINGS.md). It is kept apart from the pnpm workspace because `@trionlabs/stellar8004` 0.0.13 needs
`@stellar/stellar-sdk` 17, while the AgentPOS packages are on 16.
