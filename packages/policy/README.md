# @agentpos/policy

Merchant policy engine (M1): the rules a merchant sets over agentic sales, evaluated **before
quoting** a cart and **again at checkout**, because the merchant's state can change in between.

```ts
import { evaluatePolicy, merchantPolicySchema } from "@agentpos/policy";

const policy = merchantPolicySchema.parse({
  maxOrderUsdc: "200",
  maxPeriodUsdc: "1000",
  period: "daily",
  maxQuantityPerItem: 5,
  excludedItems: ["limited-edition-print"],
  allowedShippingCountries: ["CL", "AR"],
  approvalThresholdUsdc: "100",
});

const decision = evaluatePolicy(policy, {
  lines: [{ itemId: "mug", quantity: 2, lineTotalUsdc: 198_000_000n }],
  totalUsdc: 198_000_000n,
  periodSpentUsdc: 0n,
  requiresShipping: true,
  shippingCountry: "CL",
});
// { decision: "allowed" } | { decision: "requires_approval", ... } | { decision: "denied", code, message, hint, details }
```

Rules, in evaluation order: `status` (suspended denies everything), excluded items, quantity per
item, quantity per order, order amount, period volume, shipping country, approval threshold.
**A denial always wins over an approval**: an order over the hard limit is never queued for a human.

The period accumulator counts settled orders **plus orders awaiting approval**. Otherwise a burst
of unapproved orders could collectively pass the limit while each looks fine alone.

Every decision carries a machine-readable `code` an agent can branch on:
`POLICY_SUSPENDED`, `POLICY_ITEM_EXCLUDED`, `POLICY_ITEM_QUANTITY`, `POLICY_ORDER_QUANTITY`,
`POLICY_ORDER_LIMIT`, `POLICY_PERIOD_LIMIT`, `POLICY_SHIPPING_COUNTRY`, `POLICY_APPROVAL_REQUIRED`.

The engine is pure: the caller supplies the accumulated period volume, so the same function serves
the sidecar, the tests and a future dashboard preview.
