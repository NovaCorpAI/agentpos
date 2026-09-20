# Deploying the onboarding wizard (conecta.agentposhq.com)

Target: the same Hetzner VPS (`YOUR_SERVER_IP`) as the facilitator, the demo store, the landing
and the buyer space, behind the single Caddy that fronts every public hostname over the shared
external `edge` network.

This is the host the landing page's "conecta tu tienda en 15 minutos" points at. Until now the
wizard only ran on the founder's laptop, which made that sentence a promise nobody could take
up.

**Public on purpose.** Unlike `agente.agentposhq.com` (the owner's buyer space, private, with
its own login), this host is meant to be opened by strangers. There is no login and nothing to
log into: no accounts, no database, no volume, no secret in the container. What a merchant
types (WooCommerce keys, wallet address, the generated `MERCHANT_API_TOKEN`) lives for the
duration of one request and is never written or logged.

**What replaces the gate.** Being public is why the app carries its own controls, and why they
are the thing to check after the deploy (step 5): the SSRF guard on every outbound fetch
(public addresses only, ports 80/443/8080/8443, no redirect off the host, 512 KiB and 10s per
hop, 8 probes per request) and per-IP rate limits with 429 + `Retry-After` on the endpoints
that fetch. See `../README.md` for the full rules.

## 0. DNS (once)

In Cloudflare, add an `A` record `conecta` -> `YOUR_SERVER_IP`, **DNS-only (grey cloud)**. Proxied
records break the ACME challenge Caddy answers to get the certificate.

## 1. Ship the repository to the VPS

From the laptop, at the monorepo root (`git archive` ships the committed tree only, so no
`.env`, no `node_modules`, no secret can ride along):

```sh
git archive --format=tar HEAD \
  | ssh root@YOUR_SERVER_IP 'mkdir -p /opt/agentpos && tar -x -C /opt/agentpos'
```

## 2. Build and start

There is no env file to create. That is not an omission: the service reads one variable
(`PORT`) and the compose file pins it.

```sh
cd /opt/agentpos
docker network create edge 2>/dev/null || true
docker compose -f apps/merchant-web/deploy/docker-compose.prod.yml up -d --build
docker compose -f apps/merchant-web/deploy/docker-compose.prod.yml logs --tail 20 merchant-web
```

Expect two lines: the port it listens on, and `stateless: no accounts, no database, nothing
stored server-side`.

## 3. Add the Caddy vhost and reload

The block is already in the checked-in `apps/facilitator/deploy/Caddyfile`, so if step 1
shipped the current tree there is nothing to edit: just reload the Caddy stack. If the
Caddyfile on the box is older, append `Caddyfile.snippet` from this directory first.

```sh
grep -q conecta.agentposhq.com /opt/agentpos/apps/facilitator/deploy/Caddyfile \
  || cat /opt/agentpos/apps/merchant-web/deploy/Caddyfile.snippet \
     >> /opt/agentpos/apps/facilitator/deploy/Caddyfile
cd /opt/agentpos
docker compose -f apps/facilitator/deploy/docker-compose.prod.yml \
  --env-file /root/.agentpos/facilitator/mainnet.env up -d caddy
docker compose -f apps/facilitator/deploy/docker-compose.prod.yml logs --tail 20 caddy
```

Caddy picks the certificate up on the first request; the log line to look for is
`certificate obtained successfully` for `conecta.agentposhq.com`.

## 4. Post-deploy checks: it works

```sh
# Liveness: {"ok":true,"service":"merchant-web","stateless":true}
curl -fsS https://conecta.agentposhq.com/health

# The wizard page itself: 200, and the Spanish title.
curl -fsS https://conecta.agentposhq.com/ | grep -o '<title>.*</title>'

# The checklist against a store that really is up (the public demo store).
curl -fsS 'https://conecta.agentposhq.com/api/verify?domain=demo.agentposhq.com' | head -c 400
```

## 5. Post-deploy checks: it refuses

These matter more than step 4, because this host fetches URLs strangers choose. Every one of
them must answer `400` with `"code":"CONFIG_INVALID"` and a message about the address not being
public, and none of them may hang (a hang would mean a connection was actually opened).

```sh
for d in localhost 127.0.0.1 10.0.0.1 192.168.1.1 169.254.169.254 '[::1]' '[fc00::1]' \
         'shop.example:22' 'demo.agentposhq.com:22'; do
  printf '%s -> ' "$d"
  curl -s -o /dev/null -w '%{http_code}\n' \
    --get --data-urlencode "domain=$d" https://conecta.agentposhq.com/api/verify
done
```

`169.254.169.254` is the one to read twice: that is the cloud metadata address, and on a box
with no guard it is what an attacker would ask this server to fetch first.

```sh
# Rate limit: a 429 with Retry-After must appear well before the 20th call.
for i in $(seq 1 20); do
  curl -s -o /dev/null -w '%{http_code} ' \
    'https://conecta.agentposhq.com/api/verify?domain=demo.agentposhq.com'
done; echo

# Body cap: 413, not a 500 and not a slow read of 200 KB.
head -c 200000 /dev/zero | tr '\0' 'x' \
  | curl -s -o /dev/null -w '%{http_code}\n' -X POST \
    -H 'content-type: application/json' --data-binary @- \
    https://conecta.agentposhq.com/api/generate

# And nothing the merchant types is in the logs. This should print nothing at all.
docker compose -f apps/merchant-web/deploy/docker-compose.prod.yml logs --no-color \
  | grep -iE 'ck_|cs_|MERCHANT_API_TOKEN=|\bG[A-Z2-7]{55}\b'
```

## Updating

```sh
# from the laptop: ship the new tree, then on the VPS
cd /opt/agentpos && docker compose -f apps/merchant-web/deploy/docker-compose.prod.yml \
  up -d --build
```

Nothing survives a restart because nothing needs to: there is no database and no volume. A
merchant who was halfway through the wizard when it restarted loses only what is still in their
browser tab, and the tab keeps its own state.

## Operational notes

Note (2026-09-20): the guard now treats apex and `www` as the same site, so a store that
redirects `mitienda.cl` to `www.mitienda.cl` passes. Every hop is still resolved and
address-checked, so a `www` pointing at an internal address is refused.

- The container is never published to the host (`expose`, not `ports`): only Caddy reaches it,
  over `edge`. Do not add a port mapping, and do not add a basic-auth gate either: this host is
  supposed to be open, and a gate here would break the landing page's whole promise.
- The process runs as the non-root `node` user. A public surface that fetches URLs other people
  typed is exactly the process not to run as root.
- If a merchant reports "esa dirección no es pública" for a store that is genuinely public,
  read `details.reason` in the response: it names the family that matched (`private`,
  `loopback`, `port`, `redirect-off-host`, ...). A store behind Cloudflare with an odd port, or
  one that redirects `https://tienda.cl` to `https://www.tienda.cl`, are the two real cases; the
  second is refused by design (the redirect leaves the host), and the answer is to enter the
  final domain.
- The rate limiter keys on the **last** `x-forwarded-for` entry, the one our Caddy writes. If
  this host ever moves behind Cloudflare's proxy or a second reverse proxy, that assumption
  changes and `clientIp` in `../src/limits.ts` must change with it.
- Nothing here holds a wallet key, a facilitator key or any merchant secret, so there is nothing
  to rotate and nothing to back up. If that ever stops being true, this deployment needs an env
  file and this README needs a different first paragraph.
