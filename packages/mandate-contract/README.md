# @agentpos/mandate-contract

[Español](./README.es.md)

Client for the AgentPOS mandate contracts on Soroban: deploy them, issue and revoke an
agent's session, set its mandate, read what it has spent, and sign a payment the way the
account expects. The contracts themselves, and what they enforce, are in
[`contracts/`](../../contracts/README.md).

**Status: testnet only, not audited.** Not published to npm yet.

## What it does

| Function                                               | What it is                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `deployContract`, `deployMandateAccount`, `uploadWasm` | Put the contracts on the network                                                |
| `issueSession`                                         | Owner operation: a session for the agent's key, with its mandate and its expiry |
| `setMandate`                                           | Owner operation: change the caps and the sellers of a session                   |
| `revokeSession`                                        | Owner operation: remove the session; the next payment finds no rule             |
| `getMandate`                                           | Read a session's caps, sellers and what it spent in the current period          |
| `signMandateAuthEntry`                                 | Sign an authorization entry of the account, as the owner or as the agent        |

Every key is a local `Keypair` the caller holds. Nothing here stores a key or sends one
anywhere. The fee payer of a transaction only pays network fees; it has no power over the
account.

## Paying with x402 from the account

The account signs with its own format, so the stock x402 client cannot sign for it. The
core's adapter has a client scheme that builds the same payment and lets the account sign:

```ts
import { createContractAccountScheme } from "@agentpos/core";
import { signMandateAuthEntry } from "@agentpos/mandate-contract";

const scheme = createContractAccountScheme({
  address: account, // the mandate account, C...
  authorize: (entry, validUntilLedger, networkPassphrase) =>
    signMandateAuthEntry(
      entry,
      { account, contextRuleId: session, verifier, keys: [agentKey] },
      validUntilLedger,
      networkPassphrase,
    ),
});
```

Verify and settle stay the facilitator's. A payment the mandate refuses never gets signed
into a payable transaction: the scheme throws `PAYMENT_REJECTED`, and
`details.contractCode` carries the contract's reason (4105 over the cap per payment, 3221
over the cap per period, 4106 seller not allowed, 3002 session expired, 3000 session revoked).

## Run it on testnet

Requirements: the contracts built to WASM (`stellar contract build` in `contracts/`), and
in the environment `AGENTPOS_FACILITATOR_API_KEY` and, to fund the account,
`SMOKE_USDC_SOURCE_SECRET` (an account that holds testnet USDC, see
<https://faucet.circle.com>).

```bash
pnpm --filter @agentpos/mandate-contract deploy:testnet   # contracts, account, one session
pnpm --filter @agentpos/mandate-contract gate:x402        # pay within the cap, then over it
```

`deploy:testnet` generates throwaway testnet keys, keeps them in `.agentpos/` (git-ignored)
and writes the contract ids to `contracts/deployments/testnet.json`. `gate:x402` pays
0.5 USDC from the account through the facilitator and prints the settled transaction, then
tries 1.5 USDC against a cap of 1 and prints the refusal.

`scripts/probe-no-policy.ts` is the probe that isolated the one thing a facilitator does not
accept from a smart account: a contract event emitted while authorizing. It is kept as a
record of that finding.

## Known limits

- Signers are Ed25519 keys behind the verifier contract. Passkeys and delegated signers are
  not supported yet.
- One context rule per signature: a transaction that needs the account to authorize two
  different contexts is not supported.
- Testnet only. The scripts exit on any other network.
