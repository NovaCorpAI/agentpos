# @agentpos/buyer-web

The buyer-side web platform: a human configures their buying agent's **mandate** (spending
limits, allowed stores, physical goods or not) and then watches and decides what the agent
does. The agent proposes purchases with real quotes; the human approves or rejects them.

Three server-rendered pages, zero frontend framework, zero CDN assets:

| Page         | What it does                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/`          | Mandate editor: max per purchase, max per period, allowed stores, physical goods, contact email, linked wallet (public address).     |
| `/proposals` | Pending proposals with Approve / Reject; approved ones show as **approved, awaiting signature** with the exact payment instructions. |
| `/activity`  | Append-only activity log plus the full proposal history.                                                                             |

## The custody rule, plainly

**This server never stores, asks for, or touches a secret key.** The profile holds a public
wallet address (`G...`) and nothing else about the wallet; pasting a secret (`S...`) into the
form is refused with `SECRET_IN_CONFIG`. Consequently, approving a proposal does **not** pay:
it marks the proposal approved and hands back the checkout URL, the amount and the exact
`agentpos-buyer` command to run **on the machine that holds the key**. The UI says
"approved, awaiting signature" because that is exactly what is true. No completed purchase is
ever faked.

## Service layer (channel-agnostic)

`src/service.ts` exports `BuyerWebService` with `searchOffers(query)`,
`propose(itemId, storeUrl, quantity?)`, `approve(proposalId)`, `reject(proposalId)` and
`status()`. The web pages call these functions and nothing else; the WhatsApp channel
(`src/whatsapp/`, below) calls exactly the same five functions. The JSON API under `/api`
mirrors them one-to-one.

Mandate validation reuses `mandateSchema` from `@agentpos/mcp-buyer` verbatim, and
`propose()` evaluates the mandate against a real store quote **before** the human is
bothered: a proposal that could never be paid is refused with a typed error
(`MANDATE_EXCEEDED`, `SELLER_UNVERIFIED`, ...), not queued.

## Storage

`node:sqlite` (no native dependencies) behind `BuyerWebStorage`: `profiles` (mandate +
public wallet address), `proposals` (pending / approved / rejected / expired) and
`activity`, which is append-only by construction: the class exposes insert and select for it
and nothing else.

## WhatsApp channel

The same five service calls, over WhatsApp: the buyer texts the bot to search products, gets
a purchase proposal with a frozen quote, and approves or rejects it. Self-hosted, one
WhatsApp number per deployment; **the deployment owner is the only legitimate user**. Routes
are mounted only when a provider's environment variables are present.

**The bot never holds keys.** Approving via WhatsApp only marks the proposal
**approved, awaiting signature**, exactly like the web UI: the reply hands back the
`agentpos-buyer` command, and signing happens on the machine with the wallet. The webhook
credentials below are messaging credentials; they cannot move money.

### Commands (Spanish-first, English aliases)

| Command                                 | What it does                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| `buscar <texto>` / `search <text>`      | Search the mandated stores; numbered list (max 5) with title, price USDC, store.  |
| `comprar <n> [cantidad]` / `buy <n>`    | Propose buying result `n`; replies the frozen quote and asks for `si` / `no`.     |
| `si` / `yes`                            | Approve the pending proposal: "aprobada, en espera de firma" + payment command.   |
| `no`                                    | Reject the pending proposal.                                                      |
| `estado` / `status`                     | Status of your last proposal.                                                     |
| `ayuda` / `help` (or anything else)     | The command list.                                                                 |

Search result numbers and the pending proposal live in memory with a 30 minute TTL: a
restart or an expired entry only means searching again (proposals themselves are in SQLite).

### Allowlist

`WHATSAPP_ALLOWED_NUMBERS` (comma-separated E.164, e.g. `+56912345678`) is required whenever
a provider is configured. Only those numbers can use the bot; anyone else gets one polite
refusal and is then ignored. `whatsapp:+...` prefixes are normalized before comparing.

### Meta WhatsApp Cloud API

1. Create a Meta app with the WhatsApp product; note the **phone number id**, a permanent
   **access token** and the **app secret** (Meta app dashboard).
2. Set the webhook URL to `https://<your host>/whatsapp/meta` and subscribe to `messages`.
   Pick any string as the **verify token**; Meta's GET handshake echoes the challenge only
   when the token matches. Every POST is verified as HMAC-SHA256 of the raw body
   (`X-Hub-Signature-256`) with the app secret; bad signatures get 401.
3. Environment: `META_VERIFY_TOKEN`, `META_APP_SECRET`, `META_ACCESS_TOKEN`,
   `META_PHONE_NUMBER_ID` (all four, or none), plus `WHATSAPP_ALLOWED_NUMBERS`.

### Twilio (sandbox: quickest demo)

1. In the Twilio console open **Messaging > Try it out > WhatsApp sandbox**, join the sandbox
   from your phone, and point the inbound webhook to `https://<your host>/whatsapp/twilio`.
2. Environment: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`
   (e.g. `whatsapp:+14155238886`), `TWILIO_WEBHOOK_URL` (all four, or none), plus
   `WHATSAPP_ALLOWED_NUMBERS`. `TWILIO_WEBHOOK_URL` must be the exact public URL Twilio posts
   to; it is what `X-Twilio-Signature` validation is computed over, which matters behind a
   proxy or tunnel.

Logs never contain tokens, phone numbers or message contents: event codes plus an 8-char
sha256 sender hash only.

## Run

```sh
pnpm --filter @agentpos/buyer-web dev     # http://localhost:8788
```

Environment (all optional):

- `BUYER_WEB_PORT` - default `8788`
- `BUYER_WEB_DB` - SQLite file, default `~/.agentpos/buyer-web.sqlite`
- `AGENTPOS_NETWORK` - `testnet` (default) or `mainnet`
- WhatsApp (optional, see above): `WHATSAPP_ALLOWED_NUMBERS`, `META_VERIFY_TOKEN`,
  `META_APP_SECRET`, `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_WEBHOOK_URL`

There is deliberately no environment slot for any wallet key or passphrase.

## Test

```sh
pnpm --filter @agentpos/buyer-web test
```

The tests spin a real AgentPOS store in-process (the `packages/mcp-buyer` demo-test
pattern), so proposals carry genuine quotes from genuine carts.
