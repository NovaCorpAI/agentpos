# @agentgate/identity

Know Your Agent for AgentGate stores: **who is buying, and who answers for them.**

A stablecoin transfer proves that funds moved. It does not say which agent asked, under whose
authority, or whether that authority was withdrawn yesterday. This package adds that, with two
signed objects and no new identity provider:

- a **request signature** ([RFC 9421](https://www.rfc-editor.org/rfc/rfc9421.html), the form the
  x402 `http-message-signatures` extension specifies) that binds method, path and body, so a
  captured signature authorizes exactly one request, once;
- an **owner attestation**: a signed statement that a key acts on someone's behalf.

Both are verifiable by a third party without this SDK. The wire format is
[`SPEC.md`](./SPEC.md).

Apache-2.0. Cryptography is `@stellar/stellar-sdk` only; there is nothing home-made here.

## Store modes

Set in `agentgate.config.json`:

```json
{ "identity": { "mode": "identified", "autoRegister": true } }
```

| Mode | Anonymous request | Signed request | Attested agent |
| --- | --- | --- | --- |
| `open` (default) | allowed | verified if present, recorded | recorded |
| `identified` | allowed | verified if present, recorded | recorded |
| `verified-only` | refused (`AGENT_IDENTITY_REQUIRED`) | refused (`AGENT_ATTESTATION_INVALID`) | allowed |

In every mode, a signature that IS present is verified. The mode decides what happens when
identity is absent, never whether a bad signature is tolerated.

## Merchant side

Identity is established when the cart is quoted, recorded on the cart and carried to the order.
At payment time the store re-reads its registry, so a key revoked in between cannot pay.

```bash
npx agentgate agents list
npx agentgate agents register ./attestation.json
npx agentgate agents revoke GAGENT... -r "owner reported the key as lost"
```

The registry lives in the merchant's own SQLite database: no directory to sign up with, and
revocation takes effect on the agent's next request rather than on a cache expiry.

## Agent side

```ts
import { signHttpMessage, signAttestation, encodeAttestation } from "@agentgate/identity";

const url = "https://shop.example/agentgate/cart";
const body = JSON.stringify({ items: [{ itemId: "mug", quantity: 1 }] });
const res = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    // Signature-Input, Signature and Content-Digest, per RFC 9421 + RFC 9530.
    ...signHttpMessage(agentSecret, { method: "POST", url, body }),
    "x-agent-attestation": encodeAttestation(attestation),
  },
  body,
});
```

Any RFC 9421 client works; there is nothing AgentGate-specific to implement. The profile the
store accepts: `alg` ed25519, `keyid` as a Stellar public key (`G...`), `@method` and `@path`
covered, `content-digest` covered when there is a body, `created` within 60 seconds, and a
`nonce`. `signRequest` still exists for clients on the pre-standard header set.

The owner signs the attestation once, offline, with a key that never has to touch the agent:

```ts
const attestation = signAttestation(ownerSecret, {
  v: "agentgate-attestation-1",
  agent: agentPublicKey,
  owner: ownerPublicKey,
  name: "Ada's shopping agent",
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 90 * 864e5).toISOString(),
  scope: { sites: ["shop.example"] },
});
```

Use a fresh nonce per request: replays are refused (`AGENT_NONCE_REUSED`), which is the point.

## Errors

Every rejection carries a machine-readable code an agent can act on:
`AGENT_IDENTITY_REQUIRED`, `AGENT_SIGNATURE_INVALID`, `AGENT_TIMESTAMP_OUT_OF_WINDOW`,
`AGENT_NONCE_REUSED`, `AGENT_REVOKED`, `AGENT_ATTESTATION_INVALID`, `AGENT_NOT_FOUND`.

## What this is not

It is not KYC. It proves delegation, not the legal identity of anyone, and it collects no
personal data beyond public keys and a display name. A merchant with legal identification duties
needs something else; this reduces anonymity, it does not eliminate it.
