# @agentgate/approvals

Human approval queue (M2). Orders the merchant policy flags (M1) pause here instead of settling:
the merchant is notified, the agent is told to wait, and **nobody is charged** until a decision.

Two rules give this package its shape:

1. **Silence never approves.** A request that reaches its TTL (default 30 minutes) is rejected and
   the quote released. Doing nothing is a "no", never a "yes".
2. **The merchant approves a snapshot, not a cart id.** Items, quantities, amounts, destination
   address, buyer and the policy rule that triggered the pause are hashed together. If any of it
   drifts afterwards, the approval is void and the agent must re-quote.

```ts
import { ApprovalService, MemoryApprovalStore, WebhookChannel } from "@agentgate/approvals";

const approvals = new ApprovalService({
  store: new MemoryApprovalStore(), // the site library uses a SQLite-backed store
  ttlMinutes: 30,
  channels: [
    new WebhookChannel({ url: "https://ops.example/hooks", secret: process.env.HOOK_SECRET }),
  ],
  links: (r) => ({ poll: `.../approvals/${r.id}`, resolve: `.../approvals/${r.id}/resolve` }),
});

const outcome = await approvals.gate(snapshot); // "pending" | "approved"; throws on rejected/expired
approvals.resolve(id, "approve"); // idempotent
approvals.expirePending(); // sweep, so expiry happens without traffic
```

## Resolutions are signed

An approval is the merchant's word, so nothing else may speak it. Resolutions carry an HMAC-SHA256
signature over `` `${timestamp}.${approvalId}.${decision}` `` with the merchant's shared secret,
valid for 300 seconds. A signature for `reject` cannot be replayed to `approve`, and comparison is
constant time. Anything missing, stale or wrong is `APPROVAL_UNAUTHORIZED` (HTTP 401).

Resolving twice returns the first outcome instead of flipping it, so a retried webhook can never
turn a rejection into an approval.

## Channels

Behind one `NotificationChannel` interface, and all best effort: a channel that fails never blocks
the queue, because an approval the merchant did not see is still a valid pending approval that
expires on its own.

- `WebhookChannel` — signed JSON POST; the signature covers the exact body bytes.
- `TwilioWhatsAppChannel` — thin HTTP client, no vendor SDK.
- `EmailChannel` — takes the merchant's own `send` function. AgentGate does not bundle an SMTP
  client: sites already have one, and shipping mail credentials is not our business.

## Error codes an agent can act on

`APPROVAL_PENDING` (HTTP 202 with a polling URL), `APPROVAL_REJECTED` (403),
`APPROVAL_EXPIRED` (410), `APPROVAL_SNAPSHOT_CHANGED` (409), `APPROVAL_NOT_FOUND` (404),
`APPROVAL_UNAUTHORIZED` (401).
