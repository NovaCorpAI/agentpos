# Deploying the buyer space (agente.agentposhq.com)

Target: the buyer space runs on the same Hetzner VPS (`YOUR_SERVER_IP`) as the facilitator, the
demo store and the landing, behind the single Caddy that fronts every public hostname over the
shared external `edge` network. Twilio posts to
`https://agente.agentposhq.com/whatsapp/twilio`; the owner uses the web UI at the same host.

What this deployment does **not** do: hold a wallet key, sign, or pay. Approving a proposal
here only queues it; `agentpos-buyer watch` on the machine that holds the key polls
`/api/signer/queue` and pays. See `../README.md`.

**Access.** buyer-web has its own login now (one owner account, scrypt, server-side
sessions, CSRF on every form, and the password asked again before an approval). The
temporary HTTP basic-auth gate in the Caddyfile is no longer needed and **must be removed**
when this version goes up, see step 4. The owner account is created once, either in the
browser at `/setup` or from the environment (step 2b).

**After the first login of this version, do step 2c: generate the recovery codes.** A
banner on every page will ask until you do. It takes ten seconds and it is the difference
between "I forgot my password" and "I need to ssh into the box".

## 0. DNS (once)

In Cloudflare, add an `A` record `agente` -> `YOUR_SERVER_IP`, **DNS-only (grey cloud)**. Proxied
records break the ACME challenge Caddy answers to get the certificate.

## 1. Ship the repository to the VPS

From the laptop, at the monorepo root (`git archive` ships the committed tree only, so no
`.env`, no `node_modules`, no secret can ride along):

```sh
git archive --format=tar HEAD \
  | ssh root@YOUR_SERVER_IP 'mkdir -p /opt/agentpos && tar -x -C /opt/agentpos'
```

## 2. Create the env file (secrets, never in the repo)

Generate the signer-bridge token first; it must be at least 24 characters and it is the same
value the owner's machine will export as `AGENTPOS_SIGNER_TOKEN`:

```sh
openssl rand -hex 24
```

Then, on the VPS:

```sh
mkdir -p /root/.agentpos/buyer-web
# The container runs as the non-root `node` user (uid 1000): it must own the data directory.
chown -R 1000:1000 /root/.agentpos/buyer-web
umask 077
cat > /root/.agentpos/buyer-web.env <<'EOF'
AGENTPOS_NETWORK=mainnet
SIGNER_TOKEN=<the openssl rand -hex 24 output>
WHATSAPP_ALLOWED_NUMBERS=+56900000000
TWILIO_ACCOUNT_SID=<from the Twilio console>
TWILIO_AUTH_TOKEN=<from the Twilio console>
TWILIO_FROM_NUMBER=whatsapp:+14155238886
TWILIO_WEBHOOK_URL=https://agente.agentposhq.com/whatsapp/twilio
# Meta Cloud API, optional second channel: all four or none.
META_VERIFY_TOKEN=
META_APP_SECRET=
META_ACCESS_TOKEN=
META_PHONE_NUMBER_ID=
# Owner account, optional (see 2b). Both or neither.
BUYER_WEB_OWNER_EMAIL=
BUYER_WEB_OWNER_PASSWORD_HASH=
EOF
chmod 600 /root/.agentpos/buyer-web.env
```

`TWILIO_WEBHOOK_URL` must be the exact public URL Twilio posts to: `X-Twilio-Signature` is
computed over it, and behind Caddy the URL this process sees is not the URL Twilio signed.

## 2b. The owner account

Two ways, pick one.

**In the browser (simplest).** Leave `BUYER_WEB_OWNER_*` empty. On the first visit every page
redirects to `https://agente.agentposhq.com/setup`, which asks for an email and a password
(minimum 12 characters, typed twice), creates the single owner account and signs you in.
`/setup` answers 404 from then on. Do this the same minute the host goes up: until the
account exists, whoever opens `/setup` first becomes the owner.

**From the environment (for an unattended deploy, or to replace the account entirely).**
This is no longer the way to recover a lost password, see step 5b; it is the way to swap
the account for a different email or hash. Generate the hash with the app's own code, so
the password never reaches the env file:

```sh
cd /opt/agentpos
docker compose -f apps/buyer-web/deploy/docker-compose.prod.yml \
  --env-file /root/.agentpos/buyer-web.env run --rm --no-deps \
  buyer-web node dist/auth/hash-cli.js
# type the password, press ctrl-D, copy the scrypt$... line
```

Put it in the env file **with every `$` doubled**, because compose interpolates `$` in
values and an unescaped hash arrives truncated:

```sh
BUYER_WEB_OWNER_EMAIL=tu@correo.example
BUYER_WEB_OWNER_PASSWORD_HASH=scrypt$$16384$$8$$1$$<salt>$$<hash>
```

The pair is applied on every start: it creates the account when there is none and replaces
it, closing every open session, when it changes. A malformed hash (or a plaintext
`BUYER_WEB_OWNER_PASSWORD`) stops the container with a typed `CONFIG_INVALID` /
`SECRET_IN_CONFIG` instead of starting an unprotected space.

## 2c. The recovery codes (do this at the first login)

Log in, open `/cuenta`, press **Generar codigos nuevos**. Ten codes appear, once, on a page
that says so. Print them or put them where you keep the things you cannot lose; only their
scrypt hashes stay on the server, so there is no second chance to read them.

Each one works once, at `/recuperar`, with the owner's email. Finishing a recovery closes
every session, so anyone who was inside is out. Generating a new set retires the old one
immediately, which is what to do if you are unsure who has seen them.

If the WhatsApp channel is configured (it is here, Twilio), `/recuperar` also offers a
six-digit code sent to `WHATSAPP_ALLOWED_NUMBERS`: valid ten minutes, three attempts, one
send per minute, and never to any other number.

## 3. Build and start

```sh
cd /opt/agentpos
docker network create edge 2>/dev/null || true
docker compose -f apps/buyer-web/deploy/docker-compose.prod.yml \
  --env-file /root/.agentpos/buyer-web.env up -d --build
docker compose -f apps/buyer-web/deploy/docker-compose.prod.yml \
  --env-file /root/.agentpos/buyer-web.env logs --tail 20 buyer-web
```

The startup log states the custody rule, which channels are mounted and whether the owner
account exists. Expect `whatsapp twilio`, `signer bridge enabled` and an `access` line;
`whatsapp disabled` means the Twilio variables did not arrive and the webhook would answer
404, and `access NO OWNER YET` means step 2b is still pending.

## 4. Add the Caddy vhost and reload

Append the block in `Caddyfile.snippet` (this directory) to
`/opt/agentpos/apps/facilitator/deploy/Caddyfile` on the VPS, then reload the Caddy stack:

```sh
cat /opt/agentpos/apps/buyer-web/deploy/Caddyfile.snippet \
  >> /opt/agentpos/apps/facilitator/deploy/Caddyfile
cd /opt/agentpos
docker compose -f apps/facilitator/deploy/docker-compose.prod.yml \
  --env-file /root/.agentpos/facilitator/mainnet.env up -d caddy
docker compose -f apps/facilitator/deploy/docker-compose.prod.yml logs --tail 20 caddy
```

**Retiring the temporary gate.** An older Caddyfile has an `agente.agentposhq.com` block
with a `basic_auth` directive and a `/whatsapp/*` exemption; it stood in for the login that
now exists in the app. Replace that whole block with the snippet above (a plain
`reverse_proxy`), reload Caddy, and drop `BUYER_WEB_BASIC_HASH` from the facilitator env
file. Leaving it in place is not dangerous, it just means typing two passwords and it breaks
password managers on `/login`. Only remove it once step 2b is done and you have logged in:
never leave the host with neither gate nor owner account.

Caddy picks the certificate up on the first request; the log line to look for is
`certificate obtained successfully` for `agente.agentposhq.com`.

## 5. Post-deploy checks

```sh
# Health: {"ok":true,"network":"mainnet"} (the only route with no login)
curl -fsS https://agente.agentposhq.com/health

# The three pages redirect an anonymous visitor to the login: 302 each, and no HTML body.
for p in / /proposals /activity; do
  printf '%s -> ' "$p"
  curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "https://agente.agentposhq.com$p"
done

# The JSON API answers a typed 401 instead of redirecting a program into a login page.
curl -s https://agente.agentposhq.com/api/status   # {"error":{"code":"AUTH_REQUIRED",...}}

# Setup is closed once the owner exists: 404.
curl -s -o /dev/null -w '%{http_code}\n' https://agente.agentposhq.com/setup

# Unsigned Twilio POST: 401 (signature refused). Never 500 (a crash), never 404 (routes not
# mounted, i.e. the Twilio variables are missing or incomplete).
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data 'From=whatsapp:%2B56900000000&Body=hola' \
  https://agente.agentposhq.com/whatsapp/twilio

# Signing bridge without a token: 401 with a typed error body.
curl -s -o /dev/null -w '%{http_code}\n' https://agente.agentposhq.com/api/signer/queue

# The recovery form is open (200) and says nothing about which accounts exist: a real
# email and an invented one get byte-for-byte the same 401 page.
curl -s -o /dev/null -w '%{http_code}\n' https://agente.agentposhq.com/recuperar
```

Then point the Twilio sandbox inbound webhook at
`https://agente.agentposhq.com/whatsapp/twilio` and text the bot `ayuda` from an allowed
number. A number outside `WHATSAPP_ALLOWED_NUMBERS` gets one polite refusal and is ignored.

Finally, on the machine that holds the wallet key:

```sh
export AGENTPOS_SIGNER_TOKEN=<same value as SIGNER_TOKEN>
export AGENTPOS_BUYER_PASSPHRASE=<keyfile passphrase>
agentpos-buyer watch https://agente.agentposhq.com
```

## 5b. Locked out: the documented way back in

**There is no email reset, and there never will be.** This box has no mail server, and a
reset button that silently needs SMTP is a reset button that fails on the one day it
matters. Use one of these three, in this order.

**1. A recovery code (step 2c).** Open `https://agente.agentposhq.com/recuperar`, type the
owner's email and one of the ten codes, then choose a new password. Every session closes,
including any that are not yours. Nothing on the server has to be touched.

**2. A code over WhatsApp.** On the same page, "Enviar codigo a mi WhatsApp". The six
digits go to `WHATSAPP_ALLOWED_NUMBERS` and nowhere else, are good for ten minutes and
survive three wrong guesses. The page always says "si la cuenta existe, enviamos el
codigo", whether the email matched or not: that is on purpose.

**3. The operator link, from this box.** This replaces the old "edit the env vars and
restart" instructions. It does not touch the account, does not need a rebuild and does not
close anyone's session until the new password is set:

```sh
cd /opt/agentpos
docker compose -f apps/buyer-web/deploy/docker-compose.prod.yml \
  --env-file /root/.agentpos/buyer-web.env exec \
  buyer-web node dist/auth/recover-cli.js https://agente.agentposhq.com
```

It prints one URL, good for 15 minutes and for exactly one use. Only its scrypt hash is
stored, so if the URL is lost, run the command again and the old one stops working. Both
issuing it and using it appear on the `Accesos` panel of `/activity`: this link bypasses
the password, so it is meant to leave a mark. Open it, confirm, set a new password.

Note `exec` (the running container, which holds `/data`), not `run --rm`: a throwaway
container shares the same bind mount, so either works, but `exec` cannot be run against a
stopped service by mistake.

`BUYER_WEB_OWNER_EMAIL` + `BUYER_WEB_OWNER_PASSWORD_HASH` (step 2b) remain documented for
what they are good at: replacing the account wholesale, for instance moving the space to a
different owner email. They are not the recovery path any more.

## Updating

```sh
# from the laptop: ship the new tree, then on the VPS
cd /opt/agentpos && docker compose -f apps/buyer-web/deploy/docker-compose.prod.yml \
  --env-file /root/.agentpos/buyer-web.env up -d --build
```

The database survives: it lives in the `/root/.agentpos/buyer-web` bind mount, not in the
image. Back that directory up with the same care as the mandate it holds.

## Operational notes

- The container is never published to the host (`expose`, not `ports`): only Caddy reaches it,
  over `edge`. Do not add a port mapping. The app has its own login, but a directly exposed
  port would also be a port with no TLS, so the session cookie would travel unencrypted and
  would not be marked `Secure`.
- The owner's session lasts 12 hours of inactivity and slides while it is in use. Sessions
  live in the SQLite file, so they survive a restart; replacing `BUYER_WEB_OWNER_*`, and
  finishing a recovery, close all of them. A recovery session is a different thing: 15
  minutes, no sliding, and every route but the set-a-new-password page answers it 403.
- The `Accesos` panel on `/activity` lists the last logins, the failed attempts, the
  approvals and every recovery step, by hash. Read it after any deploy you did not do
  yourself, and after anyone runs `recover-cli.js`.
- The upgrade that added recovery adds two tables and one column to `sessions`. It happens
  on the first start, keeps existing sessions alive, and needs nothing from you. The
  database is still the same file in the same bind mount.
- No RPC URL, facilitator URL, facilitator API key or checkout asset is configured here:
  `src/config.ts` reads none of them, because this process never pays.
- `SIGNER_TOKEN` is an access token for the owner's own signer daemon, not a wallet secret.
  Rotating it means editing the env file, `up -d`, and re-exporting the new value where
  `agentpos-buyer watch` runs.
