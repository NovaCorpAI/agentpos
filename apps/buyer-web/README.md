# @agentpos/buyer-web

The buyer-side web platform: a human configures their buying agent's **mandate** (spending
limits, allowed stores, physical goods or not) and then watches and decides what the agent
does. The agent proposes purchases with real quotes; the human approves or rejects them.

Three server-rendered pages (Spanish-first UI, "Espacio del comprador"), zero frontend
framework, zero CDN assets:

| Page         | What it does                                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`          | Home: mandate state (limits, period, approved vs available with a budget bar, shipping city and country), the **market call** (below) that can turn any offer into a proposal, the mandate editor with its shipping section, and the channel status (WhatsApp, signing bridge). |
| `/proposals` | Proposal cards by state: pendiente (Aprobar / Rechazar), aprobada **esperando firma** (with the exact payment instructions and any failed-attempt reason), pagada (transaction link + order id). A physical proposal says which city and country it ships to.                   |
| `/activity`  | Proposal history plus the append-only activity log as a readable timeline.                                                                                                                                                                                                      |

## The custody rule, plainly

**This server never stores, asks for, or touches a secret key.** The profile holds a public
wallet address (`G...`) and nothing else about the wallet; pasting a secret (`S...`) into the
form is refused with `SECRET_IN_CONFIG`. Consequently, approving a proposal does **not** pay:
it marks the proposal approved and hands back the checkout URL, the amount and the exact
`agentpos-buyer` command to run **on the machine that holds the key**. The UI says
"approved, awaiting signature" because that is exactly what is true. No completed purchase is
ever faked.

## The market call

The home search box is a **llamado al mercado**: one request, asked of every store in the
mandate at the same time, answered with offers that can be compared side by side.

The form takes free text, up to three free `clave=valor` characteristics (attribute names
differ from store to store, so they are typed, not picked from a fixed list), a maximum unit
price, a quantity and a product type (any / physical / digital). It is a plain GET form, so
the whole call lives in the URL and can be shared or bookmarked:
`/?q=lamina&attr=Fondo%3Dblanco&attr=Passepartout%3Dcon&max=40&qty=2`. The same parameters
answer JSON at `GET /api/market`.

The result has three parts, and each one exists to avoid a specific kind of lie:

- **The comparison.** One row per offer, cheapest total first: store, product with the
  attributes that matched, unit price, total for the quantity, whether your mandate can pay
  it, and the same **Proponer compra** action as before.
- **Quien respondio.** Every store and what it did: respondio, no respondio a tiempo, error,
  "no entiende los filtros" (a store older than structured search: it was asked plainly and
  filtered here) or "fuera de tu mandato, no se consulto". A store that fails never fails the
  call, and it is never dropped silently either.
- **Afinar el pedido.** The attribute values every store offers, merged and counted
  ("Fondo: blanco 3, negro 2"), each one a link that adds the filter and asks again.

An offer your mandate cannot pay is **shown**, marked "no" with the reason (supera tu maximo
por compra, supera lo que queda del periodo, es un producto fisico, la tienda no esta en tu
lista). Hiding the cheapest option because of a limit would be the confusing thing to do.
Payability here is judged against what this platform can honestly account for: the proposals
you already approved this period. Nothing on this page pays anything.

## Service layer (channel-agnostic)

`src/service.ts` exports `BuyerWebService` with `marketCall(input)`, `searchOffers(query)`,
`propose(itemId, storeUrl, quantity?)`, `approve(proposalId)`, `reject(proposalId)` and
`status()`. The web pages call these functions and nothing else; the WhatsApp channel
(`src/whatsapp/`, below) calls exactly the same ones. The JSON API under `/api`
mirrors them one-to-one.

Mandate validation reuses `mandateSchema` from `@agentpos/mcp-buyer` verbatim, and
`propose()` evaluates the mandate against a real store quote **before** the human is
bothered: a proposal that could never be paid is refused with a typed error
(`MANDATE_EXCEEDED`, `SELLER_UNVERIFIED`, ...), not queued.

### Shipping, when physical goods are allowed

A store refuses a physical cart without an address and a contact email (`SHIPPING_REQUIRED`),
so `saveProfile()` refuses to store that combination in the first place. With
`allowPhysicalGoods: true`, `SaveProfileInput.shipping` must be complete (`name`, `line1`,
`city`, `postalCode`, `country` as ISO-2, plus `line2` / `region` / `phone` if useful) and
`email` must be set; each missing field gets its own typed error naming it. With the flag off
the address is optional, and an address already on file survives a save that omits it. The
browser only hides the section (CSS, no script): the server is the authority.

The address is persisted in the buyer-web profile and handed to `BuyerService` as the
mcp-buyer `Profile.shipping` / `Profile.buyer`, the same path the CLI uses, so `createCart()`
sends it to the store with the mandate's locked-address rule intact. Pages, the activity log
and log lines only ever carry its **city and country**. A profile saved before this rule
existed (physical goods on, no address) is reported by `status().physicalWithoutShipping`, is
shown as a warning banner on `/`, and makes physical proposals fail immediately with
`SHIPPING_REQUIRED` instead of at payment time.

## Storage

`node:sqlite` (no native dependencies) behind `BuyerWebStorage`: `profiles` (mandate,
shipping address, public wallet address), `proposals` (pending / approved / rejected / expired) and
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

| Command                              | What it does                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| `buscar <texto>` / `search <text>`   | Search the mandated stores; numbered list (max 5) with title, price USDC, store. |
| `comprar <n> [cantidad]` / `buy <n>` | Propose buying result `n`; replies the frozen quote and asks for `si` / `no`.    |
| `si` / `yes`                         | Approve the pending proposal: "aprobada, en espera de firma" + payment command.  |
| `no`                                 | Reject the pending proposal.                                                     |
| `estado` / `status`                  | Status of your last proposal.                                                    |
| `ayuda` / `help` (or anything else)  | The command list.                                                                |

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

## Signing bridge

Approving on the web or WhatsApp **queues** the purchase; money only moves where the wallet
key lives. That is the whole zero-custody design: this server stores a public address and a
queue, the buyer's own machine holds the key and does the paying.

The bridge has two halves:

1. **buyer-web (this app)** exposes a pending-signature feed when `SIGNER_TOKEN` is set
   (min 24 characters, e.g. `openssl rand -hex 24`; without it the routes are not mounted
   at all):
   - `GET /api/signer/queue` - approved-and-unpaid proposals, each with
     `proposalId, storeUrl, itemId, quantity, amount, amountMinor` (the quoted total the
     human approved).
   - `POST /api/signer/paid` `{ proposalId, txHash, orderId }` - marks a proposal paid
     (idempotent; refused with a typed 409/410 for anything not approved).
   - `POST /api/signer/failed` `{ proposalId, code, message }` - records why a payment
     attempt failed; the proposal stays approved and the reason is shown on `/proposals`,
     `/activity` and in the WhatsApp `estado` reply.

   All three require `Authorization: Bearer <SIGNER_TOKEN>` (compared in constant time).
   The token authorizes the buyer's OWN signer daemon and nothing else; it cannot approve
   proposals, and possessing it still moves no money.

2. **The watcher** runs on the machine that holds the wallet (the same one where
   `agentpos-buyer init` created the encrypted keyfile):

   ```sh
   export AGENTPOS_SIGNER_TOKEN=<same value as SIGNER_TOKEN>   # env only, never a flag
   export AGENTPOS_BUYER_PASSPHRASE=<your keyfile passphrase>
   agentpos-buyer watch https://your-buyer-web.example          # polls every 15s
   ```

   It pays each queued proposal through the exact same `BuyerService` a direct purchase
   uses, so the local profile mandate (maxPerTx, allowed sellers, period ceiling) still
   applies: the queue never bypasses it. It refuses to pay more than the human approved
   (`REQUOTE_REQUIRED` if the store re-quotes higher), reports every outcome back, and
   never retries a failed proposal in a loop. `--once` processes the queue a single time
   (cron users), `--interval <seconds>` changes the poll rate. See the
   `@agentpos/mcp-buyer` README for details.

Once the watcher reports a payment, the proposal shows as **paid** with its transaction
hash on the web, and WhatsApp `estado` answers "pagada" with the same hash.

## Run

```sh
pnpm --filter @agentpos/buyer-web dev     # http://localhost:8788
```

Environment (all optional):

- `BUYER_WEB_PORT` - default `8788`
- `BUYER_WEB_DB` - SQLite file, default `~/.agentpos/buyer-web.sqlite`
- `AGENTPOS_NETWORK` - `testnet` (default) or `mainnet`
- `SIGNER_TOKEN` - enables the signing bridge (`/api/signer/*`, see above); min 24 chars
- WhatsApp (optional, see above): `WHATSAPP_ALLOWED_NUMBERS`, `META_VERIFY_TOKEN`,
  `META_APP_SECRET`, `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_WEBHOOK_URL`

There is deliberately no environment slot for any wallet key or passphrase.

## Deploy

`deploy/` holds the production assets for `https://agente.agentposhq.com` (the owner's buyer
space on the shared VPS, behind the single Caddy that fronts every public hostname over the
external `edge` network):

- `deploy/Dockerfile` - multi-stage `node:22-alpine`, builds only what `@agentpos/buyer-web`
  needs from the workspace, runs as the non-root `node` user, SQLite in `/data`, port `8788`.
- `deploy/docker-compose.prod.yml` - one `buyer-web` service on `edge`, never published to the
  host, `/root/.agentpos/buyer-web:/data`, env passthrough for exactly what `src/config.ts`
  reads.
- `deploy/Caddyfile.snippet` - the `agente.agentposhq.com` vhost to append to the facilitator
  Caddyfile on the VPS.
- `deploy/README.md` - the operator's command sequence and the post-deploy checks.

The host serves a **private** surface (the owner's mandate, proposals and activity, with no
login), so it is never linked publicly.

## Test

```sh
pnpm --filter @agentpos/buyer-web test
```

The tests spin a real AgentPOS store in-process (the `packages/mcp-buyer` demo-test
pattern), so proposals carry genuine quotes from genuine carts.
