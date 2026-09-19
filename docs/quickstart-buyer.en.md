# Buyer quickstart: give your agent a wallet it cannot abuse

Set up the buying side: a local wallet, a **mandate** the agent cannot edit, and the MCP server
that lets Claude (or any MCP client) discover, quote and buy from agent-buyable stores.

Related: [merchant quickstart](quickstart-merchant.en.md) · [operations guide](operations.en.md) ·
[FAQ](faq.en.md) · Spanish: [quickstart-buyer.es.md](quickstart-buyer.es.md)

## The rule that never bends

**The wallet key never leaves your machine.** It is stored encrypted under `~/.agentpos/keys/`
and unlocked with your passphrase only in the process that pays. No server of ours, and no server
of yours (including the buyer web space below), ever holds it. Anything that "approves" a
purchase somewhere else only queues it; the payment still happens locally.

> The packages are not on npm yet (the repository is private until launch week). Until then run
> them from the repo: `pnpm install && pnpm build`, then
> `node packages/mcp-buyer/bin/agentpos-buyer.js <command>` wherever this guide writes
> `npx @agentpos/mcp-buyer <command>`. The installed binary is called `agentpos-buyer`.

## 1. Try it with no wallet at all

```bash
npx @agentpos/mcp-buyer demo https://demo.agentposhq.com --dry-run
```

The reference agent discovers the store like a stranger, quotes a real cart and stops before
paying. Nothing is installed, nothing is spent.

## 2. Create a profile

```bash
npx @agentpos/mcp-buyer init                       # profile "default", testnet
npx @agentpos/mcp-buyer init --profile work --network mainnet
```

`init` asks for a passphrase (it encrypts the wallet), then the mandate basics: max per payment,
max per day, the amount above which it must ask you first, whether physical goods are allowed
and, if so, the shipping address and email to lock in. It creates the wallet, writes
`~/.agentpos/profiles/<name>.json` and, on testnet, funds the account with test XLM through
friendbot.

## 3. The mandate

The mandate lives in `~/.agentpos/profiles/<name>.json` and the agent cannot change it: it is
evaluated before any signature, on every purchase.

| Field | Meaning |
| --- | --- |
| `maxPerTx` | Hard ceiling for a single payment, in USDC. |
| `maxTotal` + `period` | Ceiling for everything spent inside `day`, `week` or `month`. |
| `allowedSellers` | `"any"` (default) or a list of hostnames. |
| `requireConfirmAboveUsdc` | Above this amount the agent must ask you out of band. |
| `allowPhysicalGoods` | Whether the agent may buy things that ship. |
| `shippingAddressLocked` | When true the agent cannot supply an address; the profile's is used. |

`init` does not ask for `allowedSellers`: edit the JSON file to restrict it, for example
`"allowedSellers": ["demo.agentposhq.com"]`.

There used to be a third value, `"verified-only"`. It asked a hosted seller registry that was
never built, so it refused every site on earth. It is gone. A profile that still has it loads as
`"allowedSellers": []`, which refuses every site just the same, and the buyer prints a
`MANDATE_MODE_RETIRED` warning telling you to replace it with the hostnames you trust (or with
`"any"`). Nothing rewrites your profile for you.

Manage the default store list separately:

```bash
npx @agentpos/mcp-buyer sites add https://shop.example
npx @agentpos/mcp-buyer sites list
npx @agentpos/mcp-buyer sites remove https://shop.example
```

When the agent hits a limit it gets a typed refusal it can act on, never a silent failure:
`MANDATE_EXCEEDED`, `SELLER_UNVERIFIED` or `CONFIRMATION_REQUIRED`. For the last one:

```bash
npx @agentpos/mcp-buyer pending            # carts waiting for you
npx @agentpos/mcp-buyer approve <cartId>   # then tell the agent to try again
```

## 4. Funding

**Testnet (free).** `init` calls friendbot for test XLM. For test USDC use
<https://faucet.circle.com>. If the store you are buying from charges in USDC, test XLM alone is
not enough: get test USDC too.

**Mainnet.** Send USDC from your own wallet to the address `init` printed. Treat it like a
prepaid card: put in what you are willing to let an agent spend, not your savings. The account
also needs a small XLM balance (about 2 XLM) to exist and to be able to hold USDC.

Everything the agent pays is appended to `~/.agentpos/profiles/<name>.spending.jsonl`:

```bash
npx @agentpos/mcp-buyer log     # every payment, with amount, store, order id and tx hash
```

## 5. A real purchase

```bash
npx @agentpos/mcp-buyer demo https://shop.example
npx @agentpos/mcp-buyer demo https://shop.example --item <itemId> -q 2 --note "engraving: Ana"
npx @agentpos/mcp-buyer demo https://shop.example --json        # machine-readable run
```

Without `--item` it buys the cheapest published item. It prints each step (discovery, quote,
policy, payment, settlement, receipt) and ends with the transaction hash plus a `stellar.expert`
link you can check yourself.

<https://demo.agentposhq.com> is our public demo store and it runs on **mainnet**: without
`--dry-run` a purchase there spends real money.

## 6. Connect it to an MCP client

```bash
npx @agentpos/mcp-buyer serve --profile default    # MCP server over stdio
```

Claude Desktop / Claude Code configuration:

```json
{
  "command": "agentpos-buyer",
  "args": ["serve", "--profile", "default"],
  "env": { "AGENTPOS_BUYER_PASSPHRASE": "<your passphrase>" }
}
```

Tools exposed to the agent: `list_profiles`, `search_offers`, `get_site`, `create_cart`, `buy`,
`get_order`, `get_spending_log`. `buy` evaluates the mandate before it signs anything, so the
worst an agent can do is get refused.

## 7. The buyer web space (optional)

`@agentpos/buyer-web` is a self-hosted page where a human watches and decides what the agent
does: mandate state with a budget bar, offer search, and proposals to approve or reject. Four
pages behind your login: `/` (home and mandate editor), `/proposals`, `/activity`, `/cuenta`,
plus `/login`, `/setup` and `/recuperar`.

```bash
pnpm --filter @agentpos/buyer-web dev     # http://localhost:8788
```

| Variable | What it does |
| --- | --- |
| `BUYER_WEB_PORT` | Port. Default `8788`. |
| `BUYER_WEB_DB` | SQLite file. Default `~/.agentpos/buyer-web.sqlite`. |
| `AGENTPOS_NETWORK` | `testnet` (default) or `mainnet`. |
| `SIGNER_TOKEN` | Enables the signing bridge under `/api/signer/*`. Min 24 chars (`openssl rand -hex 24`). Without it those routes do not exist. |
| `BUYER_WEB_OWNER_EMAIL` + `BUYER_WEB_OWNER_PASSWORD_HASH` | Owner account for an unattended deploy. Both or neither, and always a scrypt hash, never the password. |
| `BUYER_WEB_PUBLIC_URL` | Read only by `recover-cli.js`, to print the recovery URL with the right host. A command-line argument overrides it. |

There is deliberately **no** environment slot for a wallet key or passphrase in this app. Pasting
a secret (`S...`) into the wallet field is refused with `SECRET_IN_CONFIG`.

### Getting in: one account, yours

This page can raise your spending limits and approve payments your own machine then signs, so
it has a login of its own. On a fresh installation every page sends you to `/setup`, where you
create the single owner account (email plus a password of 12 characters or more, typed twice)
and are signed in. From then on `/setup` answers 404 forever. Do it the minute the service is
up: until the account exists, whoever gets there first becomes the owner.

- The password is stored only as a scrypt hash (own salt per account, constant-time compare).
  Nobody, you included, can read it back out of the database.
- The session is a row on the server and the cookie carries only its id (`HttpOnly`,
  `SameSite=Strict`, `Secure` over https). It lasts 12 hours of inactivity and slides while you
  work; `Salir` deletes the row, which ends the session everywhere.
- An unknown email and a wrong password get the same answer ("correo o contrasena
  incorrectos"): nothing reveals which accounts exist. After a few failures the login locks out
  for a while and answers 429 with `Retry-After`.
- **Approving asks for the password again** (above `requireConfirmAboveUsdc`, and for any
  amount when you have not set that threshold), with the amount and the store written next to
  the field. The rest of the session stays signed in.
- **Changing your password** is on `/cuenta`: current password, then the new one twice. Every
  other session closes; the one you are typing in stays open.
- `/activity` has an **Accesos** panel: logins, failed attempts, approvals and every recovery
  step, with the date, a short hash of the IP and the browser family. It answers "has anyone
  else been here?".
- The WhatsApp routes and `/api/signer/*` are unchanged: they authenticate themselves on every
  request (the provider signature, the signer bearer token), so Twilio and your watcher keep
  working exactly as before.

For an unattended deploy, generate the hash with the package's own code (the password is read
from stdin, never as an argument, so it stays out of `ps` and shell history):

```bash
pnpm --filter @agentpos/buyer-web hash-password    # type the password, copy the scrypt$... line
```

and set it as `BUYER_WEB_OWNER_PASSWORD_HASH` together with `BUYER_WEB_OWNER_EMAIL`. The pair is
authoritative on every start: it creates the account when there is none and replaces it, closing
every open session, when it changes. Use it to replace the account outright, for instance to
move the space to a different email; to get back in after losing the password, use one of the
three paths below instead. A plaintext `BUYER_WEB_OWNER_PASSWORD` is refused with
`SECRET_IN_CONFIG`.

### If you lose the password

**There is no "email me a reset link", on purpose.** You are running this on your own machine,
and your machine has no mail server. A button that promises an email nobody can send is worse
than not having one, so AgentPOS ships no SMTP client and asks for no mail credentials. Three
things that do work, in the order the page offers them:

**1. Recovery codes. Set these up now, on `/cuenta`.** "Generar codigos nuevos" gives you ten
codes like `ABCD-EFGH-JKLM`, shown **once**, on a page that tells you so. Print them or keep
them where you keep the things you cannot lose. They need no email, no phone and no server
access. Until you have a set, a banner on every page offers to make one (you can put it away
for the session; it comes back next time).

- Each code works exactly once. Using one at `/recuperar`, with your email, lets you set a new
  password and nothing else: that short session cannot see your mandate, your proposals or
  approve a payment.
- Finishing a recovery **closes every session**, including any that were not yours. That is
  the point: if you are recovering because something felt wrong, this is what throws them out.
- Generating a new set retires the old one instantly. Do that if you are unsure who has seen
  them.

**2. A code over WhatsApp, if you configured the channel.** `/recuperar` then also offers
"Enviar codigo a mi WhatsApp": six digits, valid ten minutes, three attempts, at most one send
per minute, delivered through the same provider the bot already uses and **only** to a number
in `WHATSAPP_ALLOWED_NUMBERS`. The page always answers "si la cuenta existe, enviamos el
codigo", whether or not that email has an account here: nothing on this surface tells a
stranger who exists.

**3. A one-time link, from the machine itself.** For whoever can already run commands on the
server:

```bash
node dist/auth/recover-cli.js https://your-buyer-web.example
pnpm --filter @agentpos/buyer-web recover-url      # from a checkout, for a local install
```

It prints a URL that works once, expires in 15 minutes, and is stored only as a hash. Its own
output says what it is: a link that bypasses the password. Issuing it and using it both land
on the `Accesos` panel, with the time and the origin, so a recovery you did not do is
something you can see.

A recovery does not touch your mandate, your proposals, your history or your wallet. It
cannot: the wallet key was never here.

Ticking "allow physical goods" in the mandate reveals the shipping section, and the server
requires it in full: recipient name, address line 1, city, postal code, country (two-letter ISO)
and your contact email. Any of them missing and the save is refused with `SHIPPING_REQUIRED`
naming the field, because the store cannot ship without it. With physical goods off the address
is optional and a saved one is kept. Pages show only the city and country; the full address
travels to the store you buy from and never reaches the activity history or a log line. An older
profile that allows physical goods with no address gets a warning banner on the home page, and
its physical proposals are refused up front instead of failing at payment time.

### WhatsApp

The same five operations over WhatsApp: search, propose, approve, reject, status. Routes mount
only when a provider's full variable set is present, and an approval over WhatsApp still only
marks a proposal "approved, awaiting signature".

| Variable | What it does |
| --- | --- |
| `WHATSAPP_ALLOWED_NUMBERS` | Comma-separated E.164 allowlist (`+56912345678`). **Required** whenever a provider is configured; anyone else gets one refusal and is then ignored. |
| `META_VERIFY_TOKEN` | Any string you choose; Meta's GET handshake must echo it. Webhook: `/whatsapp/meta`. |
| `META_APP_SECRET` | Verifies every POST as HMAC-SHA256 of the raw body (`X-Hub-Signature-256`). |
| `META_ACCESS_TOKEN` | Permanent token used to send replies. |
| `META_PHONE_NUMBER_ID` | The WhatsApp number that answers. All four Meta variables, or none. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Twilio credentials (sandbox is the quickest demo). Webhook: `/whatsapp/twilio`. |
| `TWILIO_FROM_NUMBER` | e.g. `whatsapp:+14155238886`. |
| `TWILIO_WEBHOOK_URL` | The exact public URL Twilio posts to; `X-Twilio-Signature` is computed over it, which matters behind a proxy or tunnel. All four Twilio variables, or none. |

Commands, Spanish first with English aliases: `buscar <text>` / `search`, `comprar <n> [qty]` /
`buy`, `si` / `yes`, `no`, `estado` / `status`, `ayuda` / `help`. These are messaging credentials:
they cannot move money.

### The signing bridge

Approving on the web or on WhatsApp **queues** a purchase. The machine that holds the wallet pays
it:

```bash
export AGENTPOS_SIGNER_TOKEN=<same value as SIGNER_TOKEN>   # env only, never a CLI flag
export AGENTPOS_BUYER_PASSPHRASE=<your keyfile passphrase>
npx @agentpos/mcp-buyer watch https://your-buyer-web.example         # poll every 15s
npx @agentpos/mcp-buyer watch https://your-buyer-web.example -i 30   # every 30s
npx @agentpos/mcp-buyer watch https://your-buyer-web.example --once  # one pass, for cron
```

`AGENTPOS_SIGNER_TOKEN` is read from the environment only, on purpose: a `--token` flag would
leak into process lists. The token authorizes your own signer daemon against your own buyer-web
instance; it cannot approve proposals and it is not a wallet secret.

The watcher pays through the same code path a direct purchase uses, so the local mandate still
applies (the queue is not a bypass), and it refuses to pay more than you approved
(`REQUOTE_REQUIRED`). Outcomes are reported back to buyer-web (`/api/signer/paid`,
`/api/signer/failed`); a failed proposal is never retried in a loop.

## Keeping the proof

Stores that keep receipts serve the buyer's copy at
`GET https://shop.example/agentpos/orders/<orderId>/receipt`. Keep it: it says what was offered,
at what price, under what rules and what settled, signed by the store. You can verify it later
without asking the store or us anything. See
[operations: receipts](operations.en.md#receipts-and-how-anyone-verifies-one).
