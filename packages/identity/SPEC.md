# Agent Identity and Owner Attestation

**Version:** `agentgate-attestation-1` · **Status:** draft · **Date:** 2026-08-29

This document specifies how a buying agent identifies itself to a merchant, and how a human or
organization vouches for that agent. It is written so a third party can verify both without
AgentGate installed: everything below is Ed25519, SHA-256 and JSON.

It is the identity half of the ecosystem extension draft
[`agent-commerce-receipts`](../../specs/extensions/agent-commerce-receipts.md); the settlement
half lives in `@agentgate/receipts`. Where this document and the extension draft differ, the
extension draft is the one submitted to the working group: it delegates request authentication to
RFC 9421 (the x402 `http-message-signatures` extension) and keeps only the owner attestation,
merchant modes and revocation as new normative content. Section 4 below describes the
pre-standard request signature this implementation ships today.

## 1. Motivation

A merchant selling to autonomous agents faces a question card networks answered decades ago and
the agentic web has not: **who is on the other side, and who answers for them?** Payment alone
does not carry that. A stablecoin transfer proves funds moved; it does not say which agent asked,
under whose authority, or whether that authority was withdrawn yesterday.

Existing pieces solve neighbouring problems. Payment protocols (x402) authorize a transfer.
Commerce protocols (UCP, ACP) describe a catalog and a checkout. Wallet signatures prove control
of funds. None of them let a merchant state, and later prove, *"this order came from agent X,
acting for owner Y, and Y had not revoked it"*.

This spec fills that gap with the smallest thing that works: a signed request and a signed
delegation, both verifiable offline.

## 2. Design constraints

1. **No new identity provider.** No registry to sign up with, no service to depend on. A merchant
   who trusts an owner's key needs nothing else.
2. **No personal data.** Public keys and a display name. No documents, no KYC. Collecting identity
   documents would create a liability the merchant did not ask for.
3. **Verifiable by anyone.** Ed25519 over canonical JSON. Any Stellar SDK, or any Ed25519 library
   plus a base32 decoder, is enough.
4. **Revocation that means something.** Checked on every request against merchant-local state, so
   it takes effect on the next call rather than on a cache expiry.
5. **Optional by default.** A merchant that does not care must not be forced to care.

## 3. Key format

Keys are Ed25519 public keys encoded in Stellar StrKey form (`G` + base32, 56 characters). This
is a well-documented encoding of a raw 32-byte Ed25519 key, chosen because the surrounding
ecosystem already reads it and because merchant and agent keys can be the same kind of object as
the wallets they already hold.

A key used for identity **need not be a funded Stellar account**. It is a key, not an account.
Implementations MUST NOT require the identity key to exist on any ledger, and SHOULD NOT assume
the identity key is the paying key: the same owner may run one identity key across several
spending wallets.

## 4. Request signature

The agent signs each request over its canonical form.

### 4.1 Canonical payload

```
AGENTGATE-REQUEST-V1\n
<HTTP method, uppercase>\n
<path with query string, exactly as sent>\n
<lowercase hex SHA-256 of the raw request body; SHA-256 of the empty string when there is none>\n
<timestamp>\n
<nonce>
```

Fields are joined with `\n` (U+000A). The body is hashed rather than included so that signing
cost does not grow with payload size.

### 4.2 Headers

| Header | Value |
| --- | --- |
| `X-Agent-Id` | Agent public key (`G...`) |
| `X-Agent-Timestamp` | Unix seconds |
| `X-Agent-Nonce` | Unique per agent within the window; opaque, at least 64 bits of entropy |
| `X-Agent-Signature` | Base64 Ed25519 signature over the canonical payload |
| `X-Agent-Attestation` | Optional; base64url of the signed attestation (section 5) |

### 4.3 Verification

A verifier MUST, in this order:

1. Reject unless `X-Agent-Id`, `X-Agent-Timestamp`, `X-Agent-Nonce` and `X-Agent-Signature` are
   all present, when any of them is.
2. Reject when `|now - timestamp| > 60` seconds.
3. Reconstruct the canonical payload from the request **as received** and verify the signature
   against `X-Agent-Id`.
4. Only then spend the nonce, scoped to the agent key, for at least the window length. Reject a
   nonce already spent.

Step 4 comes last deliberately: spending the nonce before verifying the signature would let an
unauthenticated caller burn nonces an honest agent intends to use.

Signing the method, path and body means a captured signature authorizes exactly one request. The
nonce means it authorizes it once.

## 5. Owner attestation

A statement by an owner that an agent key acts on their behalf.

```json
{
  "v": "agentgate-attestation-1",
  "agent": "GAGENT…",
  "owner": "GOWNER…",
  "name": "Ada's shopping agent",
  "issuedAt": "2026-08-29T12:00:00.000Z",
  "expiresAt": "2027-08-29T12:00:00.000Z",
  "scope": { "sites": ["shop.example"], "maxPerTxUsdc": "50" }
}
```

`scope.sites` empty means any site. `scope.maxPerTxUsdc` is informational for the merchant: it
states what the owner intended, and a merchant MAY refuse above it, but the binding limit on
spending is the buyer's own mandate and the merchant's policy.

### 5.1 Envelope and signature

```json
{ "attestation": { … }, "signature": "<base64 Ed25519>" }
```

The signature is over:

```
agentgate-attestation-1\n<canonical JSON of the attestation object>
```

Canonical JSON: object keys sorted lexicographically at every depth, `undefined` members omitted,
arrays in their given order, no insignificant whitespace. The version prefix domain-separates
this signature so it can never be replayed as a request signature or any other message.

### 5.2 Verification

An attestation is valid when: the envelope parses against the schema; the signature verifies
against `owner`; `issuedAt <= now < expiresAt`; and, when the verifier is checking a specific
request, `agent` equals the request signer and `scope.sites` (if non-empty) contains the site
host.

Validity is a property of the attestation alone. Whether a **valid** attestation is **sufficient**
is the merchant's policy (section 6).

## 6. Merchant modes

| Mode | Anonymous request | Signed request | Attested agent |
| --- | --- | --- | --- |
| `open` | allowed | verified if present, recorded | recorded |
| `identified` | allowed | verified if present, recorded | recorded |
| `verified-only` | refused (`AGENT_IDENTITY_REQUIRED`) | refused (`AGENT_ATTESTATION_INVALID`) | allowed |

In every mode, **a signature that is present is verified**. The mode decides what happens when
identity is absent, never whether a bad signature is tolerated: a half-verified identity is worse
than no identity, because it invites trust it has not earned.

## 7. Revocation

An owner revokes by telling merchants to stop honouring a key. A merchant stores agent records
locally and consults them on every authenticated request, so revocation takes effect on the next
request rather than after a TTL. There is no revocation list to fetch and no service to be down.

Future work (section 9) may add owner-published revocation for merchants who have never seen the
agent before.

## 8. Error codes

Machine-readable, so an agent can act rather than guess:

| Code | Meaning |
| --- | --- |
| `AGENT_IDENTITY_REQUIRED` | The store requires identity; none was presented |
| `AGENT_SIGNATURE_INVALID` | Missing headers, or signature does not match this request |
| `AGENT_TIMESTAMP_OUT_OF_WINDOW` | Clock skew beyond 60 seconds |
| `AGENT_NONCE_REUSED` | Replay of a spent signature |
| `AGENT_REVOKED` | The key was revoked by its owner or the merchant |
| `AGENT_ATTESTATION_INVALID` | No attestation, or it fails verification |

## 9. Security considerations

- **Replay.** Bound by request content, a 60-second window and a per-agent nonce. Shortening the
  window narrows the replay surface at the cost of clock-skew tolerance.
- **Key compromise.** An attested key is as trustworthy as its holder. Attestations SHOULD carry
  short lifetimes; revocation is the fast path.
- **Owner key compromise.** Compromising an owner key allows minting attestations. Owners SHOULD
  keep attestation keys separate from spending keys, and MAY use a key they never expose online.
- **This is not KYC.** The spec proves delegation, not the legal identity of anyone. A merchant
  with legal identification duties needs something else; this reduces anonymity, it does not
  eliminate it.
- **Privacy.** The agent key is a stable identifier across merchants and therefore correlatable.
  Agents that care SHOULD rotate identity keys per merchant, at the cost of re-attestation.
- **Body hashing.** Verifiers MUST hash the body **as received**, before any normalization, or a
  proxy that rewrites payloads will silently invalidate honest signatures.

## 10. Future work

- Owner-published revocation endpoints or short-lived attestations for first contact.
- Alignment with UCP profile keys (`keys[]`, JWK Set) so one published key set serves both
  discovery signatures and agent attestations.
- Delegation chains (owner → fleet → agent) for operators running many agents.
- Binding the identity key to the paying wallet, for merchants who want them proven to be the
  same principal.

## Reference implementation

`@agentgate/identity` (Apache-2.0), running in production sidecars.
Conformance vectors: `src/identity.test.ts`.
