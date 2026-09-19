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

**From the environment (for an unattended deploy, or to replace a lost password).** Generate
the hash with the app's own code, so the password never reaches the env file:

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
  live in the SQLite file, so they survive a restart; replacing `BUYER_WEB_OWNER_*` closes
  all of them.
- The `Accesos` panel on `/activity` lists the last logins, the failed attempts and the
  approvals, by hash. Read it after any deploy you did not do yourself.
- No RPC URL, facilitator URL, facilitator API key or checkout asset is configured here:
  `src/config.ts` reads none of them, because this process never pays.
- `SIGNER_TOKEN` is an access token for the owner's own signer daemon, not a wallet secret.
  Rotating it means editing the env file, `up -d`, and re-exporting the new value where
  `agentpos-buyer watch` runs.
