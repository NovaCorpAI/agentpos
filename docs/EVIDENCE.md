# Evidence

Every claim we make about AgentPOS in production, next to something you can open and check
yourself. Nothing here needs our software, an account, or our word.

## The live store

| What                                 | Where                                              |
| ------------------------------------ | -------------------------------------------------- |
| Demo store (WooCommerce, mainnet)    | <https://demo.agentposhq.com>                      |
| What an agent reads first            | <https://demo.agentposhq.com/.well-known/ucp>      |
| Catalog, as published by the sidecar | <https://demo.agentposhq.com/agentpos/catalog>     |
| Status, network and receipt signer   | <https://demo.agentposhq.com/agentpos/health>      |
| The same store, described for an LLM | <https://demo.agentposhq.com/llms.txt>             |

The manifest names the network (`stellar:pubnet`), the asset (USDC, contract
`CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`) and the merchant's own wallet:

```
GDTD355XEM6S5DAZGZUO46I3X6YYB4EBHP2UPKA6F7NVGTRCQ7SZNG5P
```

## Real purchases, settled on Stellar mainnet

Four purchases paid over x402 by an agent and settled in USDC. Each one is a single Soroban
transaction that moves the money from the buyer's wallet straight to the merchant's wallet; the
facilitator submits it and pays the network fee, and never holds the funds.

| Date (UTC)       | Amount | Ledger   | Network fee | Transaction |
| ---------------- | ------ | -------- | ----------- | ----------- |
| 2026-09-02 17:29 | 3 USDC | 64242418 | 0.0023479 XLM | [`866070a9…19e081`](https://stellar.expert/explorer/public/tx/866070a9260f369da40690f1329a8003d1cdbe8c15e6aa822e06bd0fec19e081) |
| 2026-09-04 03:16 | 1 USDC | 64263818 | 0.0023479 XLM | [`35642adc…360cd5`](https://stellar.expert/explorer/public/tx/35642adcd8217d24288c41cae3a829c8d03844ab1a4483e74b2a923bdb360cd5) |
| 2026-09-04 18:09 | 1 USDC | 64273287 | 0.0023579 XLM | [`87e22922…3e33ec`](https://stellar.expert/explorer/public/tx/87e22922a04df1fea64d2fa18b443831a02affe10ce5e5ebabc585da153e33ec) |
| 2026-09-05 05:25 | 1 USDC | 64280616 | 0.0023579 XLM | [`2e21e44d…ef1098`](https://stellar.expert/explorer/public/tx/2e21e44dba74618d8f9a865a313ffa28d6a78c26fe898b2616f40eff6def1098) |

Who is who in those transactions:

- Buyer (the agent's wallet): `GBANBETB6WQKOBISHGKE3ODA435CO5FJYHFUZG4IYZAJYTSGMN5AFTVS`
- Merchant (receives the USDC): `GDTD355XEM6S5DAZGZUO46I3X6YYB4EBHP2UPKA6F7NVGTRCQ7SZNG5P`
- Facilitator (submits, pays the fee): `GDCZ3LXHBPA22E4XLPINIDDICBL5OEJ5RLB5CKJMNF45GUUMW2HO2WCB`

**What this proves, and what it does not.** The buyer in all four is our own reference agent
buying from our own demo store. It proves the whole path works on mainnet with real USDC
(discovery, quote, 402, signature, settlement, order). It is not traction and we do not present
it as such.

## Check it yourself in two minutes

No wallet, no install. This walks the store exactly as an agent does, up to the moment of paying.

```bash
# 1. The catalog the merchant confirmed and published
curl -s https://demo.agentposhq.com/agentpos/catalog

# 2. Quote a cart: the store answers with the price, the asset, the network and its own wallet
curl -s -X POST https://demo.agentposhq.com/agentpos/cart \
  -H "content-type: application/json" \
  -d '{"items":[{"itemId":"apoya-agentpos-ap-support","quantity":1}]}'

# 3. Ask to check out without paying: copy the "checkout" URL from step 2
curl -i -X POST "https://demo.agentposhq.com/agentpos/checkout?cart=<cartId>"
```

Step 3 answers `HTTP/1.1 402 Payment Required` with a `Payment-Required` header: the x402 v2
challenge an agent signs. No order exists at this point, and none is created until a payment
settles on the ledger.

To see the merchant's side of the ledger, open the wallet on any explorer:
<https://stellar.expert/explorer/public/account/GDTD355XEM6S5DAZGZUO46I3X6YYB4EBHP2UPKA6F7NVGTRCQ7SZNG5P>

## Testnet, on every push

The full loop (a WooCommerce store in docker, an agent that buys, settlement through the
facilitator, the order created in WooCommerce) runs in CI against Stellar testnet on every push
to `main`: see the `e2e-testnet` and `smoke-testnet` jobs under
[Actions](https://github.com/NovaCorpAI/agentpos/actions). Recorded runs with their hashes are
in [`GATE-G1.md`](GATE-G1.md).

## What is not proven yet

- **No external audit.** The code is reviewed and tested by us only.
- **The buyer's mandate is enforced off-chain**, in the buyer's own process, before anything is
  signed. Moving it into a Soroban smart-account policy that the network enforces is the next
  piece of work, not something that exists today.
- **One connector in production**: WooCommerce. Shopify is planned.
- **No third-party merchants yet.** The only store on mainnet is our demo store.
