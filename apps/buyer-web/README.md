# @agentpos/buyer-web

The buyer-side web platform: a human configures their buying agent's **mandate** (spending
limits, allowed stores, physical goods or not) and then watches and decides what the agent
does. The agent proposes purchases with real quotes; the human approves or rejects them.

Server-rendered pages (Spanish-first UI, "Sala de control"), zero frontend framework,
zero CDN assets, no client JavaScript:

| Page         | What it does                                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`          | The **mandate** as a contract: a sealed card with the limits in large type and a period-consumption bar (approved vs available, with the real numbers). Editing it is folded away in a `<details>` below it. Then the **market call** (below) that can turn any offer into a proposal, and the channel status (WhatsApp, signing bridge). |
| `/proposals` | Decisiones. One card per proposal, coloured by state: esperando tu decisión (amber), esperando firma (violet, with the exact payment instructions and any failed-attempt reason), pagada (green, transaction link + order id). Approve and reject are both full-width, both repeat the amount and the store, and a separator always stands between them: they are never adjacent in the DOM. A physical proposal says which city and country it ships to. |
| `/activity`  | Proposal history, the append-only activity log as a readable timeline, and the **Accesos** panel (logins, refusals and approvals).                                                                                                                                              |
| `/cuenta`    | The account: change the password (current + new twice), and generate the ten recovery codes. Shows how many are left, never a code. The codes themselves render as a printable sheet (monospace grid, `@media print`).                                                          |
| `/setup`     | First run only: creates the one owner account. Answers 404 forever after that.                                                                                                                                                                                                  |
| `/login`     | The way in. `/logout` (POST) destroys the session row.                                                                                                                                                                                                                          |
| `/recuperar` | The way back in: email plus a recovery code, or a six-digit code over WhatsApp. `/recuperar/nueva-clave` is the only page a recovery session reaches.                                                                                                                          |

## Its own identity

One brand, four temperaments (`docs/DISENO.md`). This one is "poder con límites": a personal
control room for money, not another admin site.

- **Violet `#9a7cf5`** for anything agentic, **green `#26d0a0`** only for money and settled
  facts, **amber** for what is waiting on a human decision, **muted red** for a mandate block
  or a failed attempt. Every state colour resolves through a token in `STATE_TOKENS`
  (`src/pages.ts`); no page writes a colour of its own, and `identity.test.ts` enforces it.
- **The mandate is the centrepiece**, editing it is secondary.
- **Decisions have weight**: the password confirmation is presented as step 1 of 2, the
  approve button as step 2, and the destructive button never sits next to it.
- **Spanish with its accents.** "contraseña", "máquina", "dueño". `identity.test.ts` scans the
  rendered text of every page for the usual unaccented spellings and fails on any of them.
- Accessible and self-contained: AA contrast, visible focus, 44 px targets, responsive, and
  motion only where it clarifies (and none at all under `prefers-reduced-motion`).

## The custody rule, plainly

**This server never stores, asks for, or touches a secret key.** The profile holds a public
wallet address (`G...`) and nothing else about the wallet; pasting a secret (`S...`) into the
form is refused with `SECRET_IN_CONFIG`. Consequently, approving a proposal does **not** pay:
it marks the proposal approved and hands back the checkout URL, the amount and the exact
`agentpos-buyer` command to run **on the machine that holds the key**. The UI says
"approved, awaiting signature" because that is exactly what is true. No completed purchase is
ever faked.

## Who gets in

This surface can raise a spending limit and approve a payment that the owner's own machine
then signs, so it has a real login of its own. No reverse proxy gate is required in front of
it, and none should be relied on.

**One owner, one account.** The first visit to a fresh installation sends every page to
`/setup`, which creates the single owner account (email + password, minimum 12 characters,
typed twice) and logs it in. After that `/setup` answers `404 SETUP_DONE` forever: a second
account here would be a second person who can spend the first one's money.

**Passwords** are stored as `node:crypto` scrypt hashes (`scrypt$N$r$p$<salt>$<hash>`, a
fresh 16-byte salt per account, constant-time compare) in the `owner_account` table. A login
against an unknown email verifies against a throwaway hash, so timing says nothing about
which accounts exist, and an unknown email and a wrong password get the same sentence:
"Correo o contrasena incorrectos".

**Sessions** are rows in `sessions`. The cookie (`agentpos_buyer_session`, `HttpOnly`,
`SameSite=Strict`, `Secure` whenever the request arrives over https, `Path=/`) carries a
random 32-byte id and nothing else: no signed payload, no claim the server has to trust.
Default lifetime 12 hours, sliding on every authenticated request; `POST /logout` deletes the
row, which ends the session everywhere at once.

**CSRF.** Every session carries its own random token, rendered as a hidden `_csrf` field in
every form and accepted as the `x-csrf-token` header (or a `_csrf` member of a JSON body) on
the API. Every state-changing request compares it in constant time and answers a typed
`403 CSRF_INVALID` when it does not match.

**Login throttle.** Failures are counted per client address and per account; from the sixth
the login is locked out with an escalating delay (30 s, doubling, capped at 15 minutes) and
answers `429 LOGIN_RATE_LIMITED` with `Retry-After`. A correct password clears both counters,
and a quarter of an hour without failures forgets them.

**Approving asks for the password again.** Above the mandate's `requireConfirmAboveUsdc` (and
for any amount when that is unset) the approval form carries a password field, with the
amount and the store written next to it; the rest of the session stays signed in. A wrong
password answers `403 REAUTH_FAILED` and the proposal stays pending.

**Changing the password** lives on `/cuenta`: current password, then the new one twice. It
closes every **other** session and keeps the one doing the change, and lands in the access
log as `password_changed`.

## Getting back in after a lost password

There is deliberately **no email reset**. This is software people run on their own box, and
a self-hosted box has no mail server; a reset path that silently needs SMTP is a reset path
that fails the day it is needed. No SMTP client is a dependency of this package, and none
will be. Three paths that do work instead, in the order the pages offer them:

**1. Recovery codes (always available, no infrastructure).** Ten codes, generated from
`/cuenta` ("Generar codigos nuevos"), shown in full exactly once on a page that says so.
Format `ABCD-EFGH-JKLM`: 12 symbols from a 32-character alphabet with no `I`, `O`, `0` or
`1`, drawn from `crypto.randomBytes`, 60 bits each. Only their scrypt hashes are stored, one
row per code in `recovery_codes`, with `used_at`. Spending one is an `UPDATE ... WHERE
used_at IS NULL`, so a replay of the same code loses the race and is refused like any wrong
code. Generating a new set retires the whole old one. An installation that predates this
feature gets a dismissible banner on every page until a set exists.

**2. A code over WhatsApp (when the channel is configured).** With
`WHATSAPP_ALLOWED_NUMBERS` and a provider set, `/recuperar` also offers "enviar codigo a mi
WhatsApp": six digits, valid ten minutes, three attempts, at most one send per 60 seconds,
delivered through the **same** transport the bot replies with (there is no second send
path) and only ever to an allowlisted owner number. The page always answers "si la cuenta
existe, enviamos el codigo", whether the email matched or not.

**3. The operator's one-time URL (last resort).** On the server:

```sh
node dist/auth/recover-cli.js https://agente.example    # pnpm --filter @agentpos/buyer-web recover-url
```

It prints a single-use URL good for 15 minutes, stores only its scrypt hash, says in its own
output that it bypasses the password, and writes both the issue and the use to the access
log. This replaces "edit the env vars and restart" as the documented way back in;
`BUYER_WEB_OWNER_*` remains the way to replace the account entirely.

**What a recovery session may do: one thing.** Proving a code opens a session marked
`scope = 'recovery'`, good for 15 minutes and not sliding. Every route except
`/recuperar/nueva-clave` (and `/logout`) answers it `403 RECOVERY_SCOPE_LIMITED`: no
mandate, no proposals, no approval, no JSON API. Setting the new password then deletes
**every** session, this one and any an intruder was holding, and the owner logs in fresh.

**What no recovery route reveals.** A wrong code, a spent code, an expired code and an email
with no account here are one refusal with one sentence, `401 RECOVERY_INVALID`, and all of
them pay for a scrypt derivation so the clock says nothing either. `/recuperar` is throttled
per client address and per account with the same escalating lockout as the login, on its own
counters, so failing here does not lock the owner out of `/login`.

### The route matrix

| Route                                                                             | Anonymous                | CSRF token |
| --------------------------------------------------------------------------------- | ------------------------ | ---------- |
| `GET /health`                                                                     | 200                      | n/a        |
| `GET /setup`, `POST /setup`                                                       | 200 (404 once it exists) | no         |
| `GET /login`, `POST /login`                                                       | 200                      | no         |
| `GET /recuperar`, `POST /recuperar`                                               | 200                      | no         |
| `POST /recuperar/whatsapp`, `GET/POST /recuperar/operador`                        | 200                      | no         |
| `GET/POST /recuperar/nueva-clave`                                                 | `302 /recuperar`         | **yes**    |
| `GET /`, `/proposals`, `/activity`, `/cuenta`                                     | `302 /login?next=...`    | n/a        |
| `POST /profile`, `/proposals`, `/proposals/:id/approve`, `/:id/reject`, `/logout` | `302 /login`             | **yes**    |
| `POST /cuenta/clave`, `/cuenta/codigos`, `/cuenta/recordatorio`                   | `302 /login`             | **yes**    |
| `GET /api/status`, `/api/offers`, `/api/market`, `/api/proposals`                 | `401 AUTH_REQUIRED`      | n/a        |
| `POST /api/proposals`, `/api/proposals/:id/approve`, `/:id/reject`                | `401 AUTH_REQUIRED`      | **yes**    |
| `/whatsapp/*` (GET, POST)                                                         | unchanged (signature)    | exempt     |
| `/api/signer/*` (GET, POST)                                                       | unchanged (bearer)       | exempt     |

The last two rows are exempt because they authenticate themselves on every single request,
with Meta's `X-Hub-Signature-256` / Twilio's `X-Twilio-Signature` and with the signer bearer
token. They are not browsers, they carry no cookie, and a CSRF token would be meaningless to
them. Nothing else on this server is exempt.

### Bootstrapping the owner from the environment

A deploy that cannot stop at a form sets `BUYER_WEB_OWNER_EMAIL` and
`BUYER_WEB_OWNER_PASSWORD_HASH` (a scrypt hash, never a password). The pair is applied on
every start: it creates the account when there is none, and replaces it (closing every open
session) when it differs. That is how an account is **replaced entirely**, not how a lost
password is recovered: for that, see the three paths above.
`BUYER_WEB_OWNER_PASSWORD` is refused outright with `SECRET_IN_CONFIG`.

Generate the hash with this package's own code, reading the password from stdin so it never
lands in `ps` or in shell history:

```sh
pnpm --filter @agentpos/buyer-web hash-password       # type the password, get the hash
# in the deployed container, where only dist/ exists:
docker compose -f apps/buyer-web/deploy/docker-compose.prod.yml run --rm --no-deps \
  buyer-web node dist/auth/hash-cli.js
```

### What the logs may say

`auth.login_ok`, `auth.login_failed`, `auth.login_rate_limited`, `auth.logout`,
`auth.setup`, `auth.session_expired`, `auth.csrf_invalid`, `auth.reauth_failed`,
`auth.password_changed`, `auth.recovery_codes_generated`, `auth.recovery_code_sent`,
`auth.recovery_failed`, `auth.recovery_started`, `auth.recovery_completed`, each with an
8-char sha256 of the email, an 8-char sha256 of the client address and a coarse browser
family. Never the email, never the password, never a recovery code, never an operator
token, never the session id or the CSRF token. A test asserts exactly that against a spy
logger. The same events reach the `Accesos` panel on `/activity`, in Spanish, so the owner
can see for themselves that a recovery happened and when.

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
shipping address, public wallet address), `proposals` (pending / approved / rejected /
expired), `activity`, `owner_account` (email + scrypt hash), `sessions` (id, CSRF token,
sliding expiry, origin hashes, `scope`), `access_log`, `recovery_codes` (one scrypt hash per
printable code, plus `used_at`) and `recovery_challenges` (at most one live WhatsApp code
and one live operator token, also hashed, with an expiry and an attempt counter). `activity`
and `access_log` are append-only by construction: the class exposes insert and select for
them and nothing else. The tables are created on open (`create table if not exists`), and a
database that predates recovery gains `sessions.scope` through a one-line `alter table` on
the next start, so the owner is not logged out by the upgrade. Nothing to migrate by hand.

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
- `BUYER_WEB_OWNER_EMAIL` + `BUYER_WEB_OWNER_PASSWORD_HASH` - optional owner bootstrap, both
  or neither (see "Who gets in"). The hash comes from the `hash-password` script above; a
  plaintext `BUYER_WEB_OWNER_PASSWORD` is refused
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
  Caddyfile on the VPS. A plain reverse proxy: the login lives in the app, so the temporary
  `basic_auth` gate that stood in for it can be removed from the Caddyfile.
- `deploy/README.md` - the operator's command sequence and the post-deploy checks.

The host serves a **private** surface (the owner's mandate, proposals and activity) behind
the owner's login. It is still not linked publicly: fewer people knowing it exists is one
more layer, not the layer.

## Test

```sh
pnpm --filter @agentpos/buyer-web test
```

The tests spin a real AgentPOS store in-process (the `packages/mcp-buyer` demo-test
pattern), so proposals carry genuine quotes from genuine carts. Every test that touches a
guarded route signs in through the real `/setup` or `/login` form and carries the real
cookie and CSRF token (`setUpOwner` / `logIn` in `src/test-utils.ts`): nothing reaches past
the access layer by a back door, because then nothing would be testing it. `src/auth.test.ts`
covers the route matrix, sessions, CSRF, the throttle, the approval re-authentication and
the no-secrets-in-logs rule. `src/recovery.test.ts` covers the three ways back in: codes
hashed at rest and spent exactly once (a replay is refused), a recovery session that
reaches nothing but its one page, a completed recovery that kills every session including
an intruder's, the per-address and per-account lockout, the WhatsApp code with its expiry,
its three attempts, its one-per-minute send and its refusal to message a number outside
the allowlist, the operator link's single use and expiry, changing the password from
inside, and the fact that nothing about any of it reaches a log line.
