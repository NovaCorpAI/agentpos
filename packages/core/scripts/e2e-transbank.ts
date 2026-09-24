/**
 * Live probe of the Transbank rail against the INTEGRATION environment, with the public
 * credentials from Transbank's docs repo. No money moves and no secret is needed.
 *
 * Opt in explicitly: it talks to a third party, so it never runs from `pnpm test`.
 *
 *   AGENTPOS_E2E_TRANSBANK=1 pnpm --filter @agentpos/core e2e:transbank
 *
 * What it proves:
 *  1. Webpay Plus: a quote creates a real transaction (token + URL) and `verify` reports it as
 *     PENDING, because a human has to pay on Transbank's page. Completing that page is the one
 *     step a script cannot do; the URL is printed so a person can, with the test card the docs
 *     publish (4051 8856 0044 6623, CVV 123, any future date; RUT 11.111.111-1, password 123).
 *  2. Oneclick: an enrolment can be started (token + URL). The charge itself needs a `tbk_user`,
 *     which only exists after a human finishes that enrolment once.
 */
import { fiatMinor } from "../src/money.js";
import { minorAmount } from "../src/adapter/rails.js";
import { createTransbankRail } from "../src/adapter/rails/transbank-webpay.js";
import { PROTOCOL_VERSIONS } from "../src/adapter/versions.js";

if (process.env.AGENTPOS_E2E_TRANSBANK !== "1") {
  console.log(
    "e2e-transbank: skipped (set AGENTPOS_E2E_TRANSBANK=1 to talk to the integration environment)",
  );
  process.exit(0);
}

const PUBLIC = {
  commerceCode: process.env.TRANSBANK_COMMERCE_CODE || "597055555532",
  apiKey:
    process.env.TRANSBANK_API_KEY ||
    "579B532A7440BB0C9079DED94D31EA1615BACEB56610332264630D42D0A36B1C",
  oneclick: {
    mallCode: process.env.TRANSBANK_ONECLICK_MALL_CODE || "597055555541",
    childCommerceCode: process.env.TRANSBANK_ONECLICK_CHILD_CODE || "597055555542",
  },
};

const rail = createTransbankRail({ environment: "integration", ...PUBLIC });
const amount = minorAmount(fiatMinor("10000", 0, "CLP"), "CLP", 0);

console.log(
  `Transbank REST v${PROTOCOL_VERSIONS.transbank.version} at ${PROTOCOL_VERSIONS.transbank.hosts.integration}`,
);

// 1. Webpay Plus: create, then read the status.
const quote = await rail.quote({
  payTo: "https://demo.agentposhq.com/agentpos/return",
  amount,
  reference: `e2e-${Date.now().toString(36)}`,
});
if (quote.terms.mode !== "webpay-plus") throw new Error("expected Webpay Plus terms");
console.log(
  `webpay-plus: transaction created, token ${quote.terms.token.slice(0, 10)}..., expires in ${quote.expiresInSeconds}s`,
);

const status = await rail.verify({ mode: "webpay-plus", token: quote.terms.token }, quote.terms);
if (status.ok) {
  console.log("webpay-plus: already AUTHORIZED (unexpected for a fresh token)");
} else if (status.failure.code === "PAYMENT_PENDING") {
  console.log("webpay-plus: PENDING, as expected: a human must pay at");
  console.log(`  ${quote.terms.url}  (POST token_ws=${quote.terms.token})`);
} else {
  console.error("webpay-plus: unexpected", status.failure);
  process.exit(1);
}

// 2. Oneclick: start an enrolment on the mall.
const res = await fetch(
  `${PROTOCOL_VERSIONS.transbank.hosts.integration}/rswebpaytransaction/api/oneclick/v${PROTOCOL_VERSIONS.transbank.version}/inscriptions`,
  {
    method: "POST",
    headers: {
      "Tbk-Api-Key-Id": PUBLIC.oneclick.mallCode,
      "Tbk-Api-Key-Secret": PUBLIC.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      username: "agentpos-e2e",
      email: "e2e@agentposhq.com",
      response_url: "https://demo.agentposhq.com/agentpos/oneclick/return",
    }),
  },
);
const inscription = (await res.json()) as { token?: string; url_webpay?: string };
if (!res.ok || !inscription.token) {
  console.error("oneclick: enrolment did not start", res.status, inscription);
  process.exit(1);
}
console.log(
  `oneclick: enrolment started, token ${inscription.token.slice(0, 10)}..., page ${inscription.url_webpay}`,
);
console.log(
  "oneclick: a charge without the human needs the tbk_user that enrolment returns; finish it once by hand.",
);

console.log("e2e-transbank: OK (both modes reachable in integration)");
