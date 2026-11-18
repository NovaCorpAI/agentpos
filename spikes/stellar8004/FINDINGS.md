# Stellar 8004 spike: findings

[Español](./FINDINGS.es.md)

The spike asked one question: can AgentPOS use the Stellar 8004 registries (Trion Labs) for
an agent's identity and reputation, with what it has today? It ran on testnet in
November 2026 with throwaway keys.

## What worked

| Step | Result |
| --- | --- |
| The agent's owner registers the agent (`register_with_uri`) | agent ID 184, tx [`5ba476f9…8c726`](https://stellar.expert/explorer/testnet/tx/5ba476f921d0ba4427eb712220bda7c2d1a536409e6b60db15c209681288c726) |
| A store, from its own key, writes feedback with the SHA-256 of a receipt (`give_feedback`) | tx [`23dfcd67…ecfe`](https://stellar.expert/explorer/testnet/tx/23dfcd67e7ad82b2dd54f5b2473b9a65a71c74330c8324dc860fc909c426ecfe) |
| Anyone reads the reputation summary, with no key (`get_summary`) | 1 record, value 100 |

So the three calls AgentPOS needs exist and work: register, write feedback tied to a
receipt, read it back. The receipt hash in the feedback record lets a reader check a
reputation entry against the receipt it refers to.

## What we learned

1. **The SDK versions do not match.** `@trionlabs/stellar8004` 0.0.13 depends on
   `@stellar/stellar-sdk` ^17.4.0. AgentPOS is on 16.4.1, and so is `@x402/stellar`, up to
   its latest release (2.31.0, which depends on ^16.4.1). That is why this spike lives
   outside the pnpm workspace, with its own lockfile.
2. **The package is young.** Version 0.0.13, and it expects a browser wallet
   (`@stellar/freighter-api`) as a peer dependency. The spike signs with a plain keypair
   through `wrapBasicSigner`, which worked.
3. **The summary is read per feedback author.** The spike asked for the summary of the
   feedback written by the store's address. Who counts as a credible author is a decision
   for whoever reads, not something the registry settles.
4. **The agent profile is public.** The spike registers a profile with no personal data,
   as a data URI. Anything put there is on-chain for good.

## Moving AgentPOS to SDK 17: how hard

The size of the change in our code is modest: 59 source files import the SDK, across 8
packages. We have not read the SDK 17 changelog, so we do not know how many of those
break.

The real obstacle is not ours. Payments go through `@x402/stellar`, which is on SDK 16.
If AgentPOS moved to 17 today, two copies of the SDK would be loaded, and objects built
with one (keys, transactions) would be handed to the other. That is the kind of mismatch
that fails at run time, in the payment path. We avoided exactly this in release 0.1.6.

## Options for the identity work

| Option | What it means | Cost and risk |
| --- | --- | --- |
| A. Keep 8004 in its own package on SDK 17 | The identity package talks to the rest of AgentPOS with plain data (addresses, hashes, IDs), never SDK objects | Two SDK copies installed, isolated from each other. Works today. |
| B. Call the registries with SDK 16, without the Trion Labs package | The three calls are ordinary contract calls | No new dependency and one SDK. Not tried in this spike: needs its own check. |
| C. Wait for `@x402/stellar` to move to SDK 17, then migrate everything | One SDK, the vendor's package as is | Depends on a date we do not control. |

Our reading: A works now and B is worth an hour of checking before the identity work
starts, because it removes a 0.0.x dependency from the picture. C is not a plan.

## Not covered

- Mainnet. The spike is testnet only.
- Updating or revoking feedback, and agent metadata changes.
- Cost of each call in fees.
- How a store decides which agents to trust from a summary.

## Run it

```bash
cd spikes/stellar8004 && npm install && npm run spike
```

It prints the agent ID, both transaction hashes and the summary. CI runs it on `main`.
