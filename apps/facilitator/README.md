# @agentgate/facilitator

A minimal, self-hostable **x402 facilitator for Stellar**: `/verify`, `/settle`, `/supported`.

It reimplements nothing. Verification and settlement are `ExactStellarScheme` from
`@x402/stellar/exact/facilitator` (Apache-2.0, the official SDK) wired to `x402Facilitator` from
`@x402/core`. This service is the HTTP surface, the authentication and the guardrails around them.

## Why this exists

Because a store's ability to sell should not depend on one hosted service run by someone else,
with no alternative and no SLA. We learned that the hard way: see
[`docs/INCIDENT-mainnet-facilitator.md`](../../docs/INCIDENT-mainnet-facilitator.md) and the
analysis in [`docs/EVAL-facilitador-propio.md`](../../docs/EVAL-facilitador-propio.md).

## What it is not

**It is not a business.** AgentGate does not want to operate facilitators for other people. This
exists so that we can run our own CI deterministically, unblock our own mainnet, and give anyone
who wants one a starting point that is not 800 lines of someone else's framework.

**It never holds anyone's funds.** The payment moves buyer → seller inside the transaction this
service submits. What this service holds is XLM to pay fees with, and that is the only balance it
should ever have. If you find yourself adding a feature that makes it hold merchant or buyer
funds, stop: that is a different product with a different regulatory posture.

## Who pays the fees, and from which account

The x402 Stellar scheme has the facilitator sponsor transaction fees (`areFeesSponsored: true` is
the only value the spec supports today), so **whoever runs the facilitator pays**. There is no
protocol-level way to charge the buyer.

That leads to one rule and two consequences:

- **A merchant who wants to bear their own costs runs their own facilitator.** It is a container
  and two env vars on the store side. AgentGate's instance is for our own CI and demo store; we
  do not operate one for merchants, and the fee account is not a cost centre we want.
- **The fee account is its own account.** Not the merchant's `payTo` (their revenue), not a
  buyer's wallet, not anything else you hold. It holds XLM for fees and nothing more, so the worst
  case of a compromise is a drained fee balance.

Separation is enforced, not just written down: `verify` and `settle` refuse a payment whose
`payTo` is the fee account itself (`SPEC_MISMATCH`), and `/health` warns with `foreignBalances`
if that account ever holds anything other than XLM.

### Create the fee account

```bash
pnpm --filter @agentgate/facilitator keygen --network mainnet
```

It writes `~/.agentgate/facilitator/mainnet.env` (owner-only) and prints **only the public
address**. The secret never reaches the terminal, and therefore never reaches a scrollback, a
screenshot or a chat transcript. Send XLM to that address; 20 to 30 XLM lasts thousands of
settlements. It refuses to overwrite an existing file unless `--force`, because silently replacing
a funded key strands its balance.

## Run it

```bash
export AGENTGATE_FACILITATOR_NETWORK=testnet
export AGENTGATE_FACILITATOR_SIGNER_SECRET=S...        # pays fees; holds nothing else
export AGENTGATE_FACILITATOR_ASSETS=CBIELTK6...        # contract ids you will settle
export AGENTGATE_FACILITATOR_KEYS=key-one,key-two      # Bearer tokens you hand to your stores
pnpm --filter @agentgate/facilitator dev
```

It prints the fee-paying address on startup. **Fund that account with XLM and nothing else.**

Point a store at it:

```bash
AGENTGATE_FACILITATOR_URL=https://facilitator.example
AGENTGATE_FACILITATOR_API_KEY=key-one
```

No code change is needed on the store side; the URL has always been configurable.

### Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `AGENTGATE_FACILITATOR_SIGNER_SECRET` | yes | Stellar secret (`S...`) that signs and pays fees. Environment only, never a file. |
| `AGENTGATE_FACILITATOR_KEYS` | yes | Comma-separated Bearer tokens, 16+ chars each. |
| `AGENTGATE_FACILITATOR_ASSETS` | yes | Comma-separated contract ids (`C...`) this facilitator will settle. |
| `AGENTGATE_FACILITATOR_NETWORK` | no | `testnet` (default) or `mainnet`. |
| `AGENTGATE_FACILITATOR_RPC_URL` | on mainnet | Soroban RPC. Mainnet refuses to guess. |
| `AGENTGATE_FACILITATOR_MAX_FEE_STROOPS` | no | Per-transaction fee ceiling; verify refuses above it. Default 50,000. |
| `AGENTGATE_FACILITATOR_MIN_BALANCE_STROOPS` | no | `/health` goes 503 below this. Default 50,000,000 (5 XLM). |
| `PORT` | no | Default 8403. |

Three of those are refusals to start, not warnings, and each is deliberate:

- **No asset allowlist → refuses to start.** An empty allowlist lets anyone holding a key spend
  your fee balance settling arbitrary tokens.
- **Mainnet with no RPC → refuses to start.** A public RPC that rate-limits or lags is a bad
  thing to discover while someone's money is in flight.
- **No API keys → refuses to start.** A facilitator open to the internet is an open relay for
  your fees.

## Operating it

`GET /health` is unauthenticated on purpose: whoever depends on this service must be able to see
that it is alive, and that its fee account still has a balance, **before** a payment fails for
that reason.

```json
{
  "ok": true,
  "network": "stellar:testnet",
  "signer": "GABC...",
  "feeAccount": { "balanceStroops": "1000000000", "funded": true, "note": "..." }
}
```

It answers `503` when the fee account is below the minimum, and stays `200` with
`funded: undefined` when Horizon itself is unreachable. A Horizon outage must not take the
facilitator down with it.

Costs, measured rather than estimated: a real USDC settlement on our testnet e2e paid **23,073
stroops (0.0023 XLM)**. At a thousand sales a month that is about 2.3 XLM. The cost of running
this is attention, not money.

### A difference you will notice

`/supported` reports `signers` keyed by the wildcard `stellar:*` rather than the concrete network,
because that is what the SDK's scheme returns for a Stellar facilitator. The hosted Built on
Stellar facilitator keys it by the concrete network. Nothing depends on it: a store checks
`kinds[]`, which carries the concrete network in both. Verified against a real store health check
before shipping.

## Failure shapes

A scheme failure answers `200` with `{ isValid: false }` or `{ success: false }`, not a `500`.
That is not sloppiness: the x402 client distinguishes "your payment is not acceptable" from "this
service is broken" by the body, and a `500` gets retried as if the service were merely flaky.

Refusals that are about the request itself do use status codes, with machine-readable codes:
`401` (`APPROVAL_UNAUTHORIZED`), `422` (`SPEC_MISMATCH`, wrong network or asset), `400`
(`CONFIG_INVALID`, not an x402 facilitator request).

## Security

- The signing key is hot by necessity. Give it XLM for fees and nothing else, so the worst case
  of a compromise is a drained fee balance rather than a drained treasury.
- Rotate `AGENTGATE_FACILITATOR_KEYS` by adding the new key, moving stores over, then removing
  the old one. Key comparison is constant-time.
- Put it behind TLS and a rate limiter. This service does not rate limit itself.
