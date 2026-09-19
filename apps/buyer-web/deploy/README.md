# Deploying the buyer space (agente.agentposhq.com)

Target: the buyer space runs on the same Hetzner VPS (`YOUR_SERVER_IP`) as the facilitator, the
demo store and the landing, behind the single Caddy that fronts every public hostname over the
shared external `edge` network. Twilio posts to
`https://agente.agentposhq.com/whatsapp/twilio`; the owner uses the web UI at the same host.

What this deployment does **not** do: hold a wallet key, sign, or pay. Approving a proposal
here only queues it; `agentpos-buyer watch` on the machine that holds the key polls
`/api/signer/queue` and pays. See `../README.md`.

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
EOF
chmod 600 /root/.agentpos/buyer-web.env
```

`TWILIO_WEBHOOK_URL` must be the exact public URL Twilio posts to: `X-Twilio-Signature` is
computed over it, and behind Caddy the URL this process sees is not the URL Twilio signed.

## 3. Build and start

```sh
cd /opt/agentpos
docker network create edge 2>/dev/null || true
docker compose -f apps/buyer-web/deploy/docker-compose.prod.yml \
  --env-file /root/.agentpos/buyer-web.env up -d --build
docker compose -f apps/buyer-web/deploy/docker-compose.prod.yml \
  --env-file /root/.agentpos/buyer-web.env logs --tail 20 buyer-web
```

The startup log states the custody rule and which channels are mounted. Expect
`whatsapp twilio` and `signer bridge enabled`; `whatsapp disabled` means the Twilio variables
did not arrive and the webhook would answer 404.

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

Caddy picks the certificate up on the first request; the log line to look for is
`certificate obtained successfully` for `agente.agentposhq.com`.

## 5. Post-deploy checks

```sh
# Health: {"ok":true,"network":"mainnet"}
curl -fsS https://agente.agentposhq.com/health

# The three pages answer 200 with HTML.
for p in / /proposals /activity; do
  printf '%s -> ' "$p"
  curl -s -o /dev/null -w '%{http_code}\n' "https://agente.agentposhq.com$p"
done

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
  over `edge`. Do not add a port mapping; `agente.agentposhq.com` has no login and anyone who
  reaches it can approve purchases.
- No RPC URL, facilitator URL, facilitator API key or checkout asset is configured here:
  `src/config.ts` reads none of them, because this process never pays.
- `SIGNER_TOKEN` is an access token for the owner's own signer daemon, not a wallet secret.
  Rotating it means editing the env file, `up -d`, and re-exporting the new value where
  `agentpos-buyer watch` runs.
