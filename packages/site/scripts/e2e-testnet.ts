/**
 * Phase 1 DoD, end to end on Stellar TESTNET against the local WooCommerce demo store:
 *   scan (Woo connector) -> auto-confirm (USD 1:1) -> publish -> sidecar on a random port
 *   -> an agent creates a cart, pays via x402 (real facilitator, real settlement)
 *   -> the order appears PAID in WooCommerce with the tx hash.
 *
 * Requirements: `pnpm demo:up` (http://localhost:8080) and AGENTGATE_FACILITATOR_API_KEY in .env.
 * Uses AGENTGATE_CHECKOUT_ASSET=XLM so friendbot can fund the buyer (no USDC faucet in CI).
 */
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import {
  AgentGateError,
  FRIENDBOT_URL,
  configFromEnv,
  createBuyerFetch,
  createLocalKeypairSigner,
  receiptFromResponse,
  usdc,
} from "@agentgate/core";
import { WooCommerceConnector } from "@agentgate/connectors";
import { scanSite } from "@agentgate/scanner";
import { createAgentGate, SiteStorage } from "../src/index.js";

for (const candidate of ["../../../.env", "../.env"]) {
  try {
    process.loadEnvFile(fileURLToPath(new URL(candidate, import.meta.url)));
    break;
  } catch {
    /* no .env here */
  }
}

const WOO_URL = process.env.DEMO_STORE_URL ?? "http://localhost:8080";
const WOO_CK =
  process.env.AGENTGATE_WOO_CONSUMER_KEY ?? "ck_agentgatedemo000000000000000000000000000";
const WOO_CS =
  process.env.AGENTGATE_WOO_CONSUMER_SECRET ?? "cs_agentgatedemo000000000000000000000000000";

const core = configFromEnv({
  ...process.env,
  AGENTGATE_CHECKOUT_ASSET: process.env.AGENTGATE_CHECKOUT_ASSET ?? "XLM",
});
if (core.network !== "testnet") throw new Error("e2e runs on testnet only (guardrail 2)");
if (core.facilitatorApiKeys.length === 0)
  throw new Error(
    "AGENTGATE_FACILITATOR_API_KEY missing (https://channels.openzeppelin.com/testnet/gen)",
  );

const t0 = Date.now();
const step = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

async function fund(kp: Keypair): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${kp.publicKey()}`);
  if (!res.ok) throw new Error(`friendbot failed: ${res.status}`);
}

async function main(): Promise<void> {
  const seller = Keypair.random();
  const buyer = Keypair.random();
  await Promise.all([fund(seller), fund(buyer)]);
  step(`funded seller ${seller.publicKey()} and buyer ${buyer.publicKey()} via friendbot`);

  const connector = new WooCommerceConnector({
    baseUrl: WOO_URL,
    consumerKey: WOO_CK,
    consumerSecret: WOO_CS,
    allowInsecureHttp: true,
  });
  const storage = new SiteStorage(":memory:");
  const gate = await createAgentGate({
    site: {
      siteUrl: WOO_URL,
      displayName: "AgentGate Demo Store",
      payTo: seller.publicKey(),
      platform: "woocommerce",
      woocommerce: { baseUrl: WOO_URL, allowInsecureHttp: true },
    },
    core,
    connector,
    storage,
    log: (m) => step(`site: ${m}`),
  });

  const scan = await scanSite({
    baseUrl: WOO_URL,
    connector,
    fetcher: { minIntervalMs: 0 },
    maxPages: 20,
  });
  step(`scan: ${scan.drafts.length} drafts ${JSON.stringify(scan.stats)}`);
  storage.replaceDrafts(scan.drafts);
  let confirmed = 0;
  for (const d of scan.drafts) {
    if (d.priceUsdcSuggested === undefined) continue;
    gate.catalog.confirm(d, d.priceUsdcSuggested);
    confirmed += 1;
  }
  const published = gate.catalog.publishAll();
  step(`confirmed ${confirmed}, published ${published.length}`);
  if (published.length === 0) throw new Error("nothing published; is the demo store seeded?");

  const { port, close } = await gate.serve(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${port}`;
  step(`sidecar listening at ${baseUrl}`);

  const catalog = (await (await fetch(`${baseUrl}/agentgate/catalog`)).json()) as {
    items: Array<{ id: string; title: string; price: { amount: string } }>;
  };
  const mug = catalog.items.find((i) => /mug/i.test(i.title)) ?? catalog.items[0]!;
  step(`agent picked "${mug.title}" at ${mug.price.amount} ${core.checkoutAsset}`);

  const cartRes = await fetch(`${baseUrl}/agentgate/cart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: [{ itemId: mug.id, quantity: 1 }],
      buyer: { email: "agent@example.com", name: "Agent Smith" },
      shipping: {
        name: "Agent Smith",
        line1: "1 Loop St",
        city: "Springfield",
        postalCode: "12345",
        country: "US",
      },
    }),
  });
  const cart = (await cartRes.json()) as {
    cartId: string;
    checkout: string;
    quote: { total: string; payTo: string };
  };
  if (cartRes.status !== 201) throw new Error(`cart failed: ${JSON.stringify(cart)}`);
  step(
    `cart ${cart.cartId} total ${cart.quote.total} ${core.checkoutAsset} payTo ${cart.quote.payTo}`,
  );

  const signer = createLocalKeypairSigner(buyer.secret(), "testnet");
  // The agent's hard ceiling for this run: 20 units of the checkout asset per payment.
  const payFetch = createBuyerFetch(core, signer, { maxPerPayment: usdc("20") });
  const checkoutUrl = cart.checkout.replace(WOO_URL, baseUrl);
  step(`agent pays ${checkoutUrl} with x402 (facilitator ${core.facilitatorUrl})`);
  const paid = await payFetch(checkoutUrl, { method: "POST" });
  const body = (await paid.json()) as { orderId?: string; error?: unknown };
  if (paid.status !== 200)
    throw new Error(`checkout failed ${paid.status}: ${JSON.stringify(body)}`);
  const receipt = receiptFromResponse(paid);
  step(
    `PAID tx=${receipt.txHash} payer=${receipt.payer} https://stellar.expert/explorer/testnet/tx/${receipt.txHash}`,
  );

  let order:
    | {
        status: string;
        externalOrderId?: string;
        externalAdminUrl?: string;
        payment?: { txHash: string };
        connectorError?: unknown;
      }
    | undefined;
  for (let i = 0; i < 20; i += 1) {
    order = (await (
      await fetch(`${baseUrl}/agentgate/orders/${body.orderId}`)
    ).json()) as typeof order;
    if (order?.externalOrderId || order?.connectorError) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!order?.externalOrderId)
    throw new Error(`order not created in Woo: ${JSON.stringify(order)}`);
  step(
    `order ${body.orderId} -> WooCommerce #${order.externalOrderId} (${order.externalAdminUrl})`,
  );

  const wooFull = (await (
    await fetch(`${WOO_URL}/wp-json/wc/v3/orders/${order.externalOrderId}`, {
      headers: { authorization: `Basic ${Buffer.from(`${WOO_CK}:${WOO_CS}`).toString("base64")}` },
    })
  ).json()) as {
    status: string;
    transaction_id: string;
    payment_method: string;
    total: string;
  };
  step(
    `WooCommerce says: status=${wooFull.status} payment_method=${wooFull.payment_method} transaction_id=${wooFull.transaction_id} total=${wooFull.total}`,
  );
  if (wooFull.transaction_id !== receipt.txHash)
    throw new Error("tx hash mismatch between chain and WooCommerce");
  if (!["processing", "completed"].includes(wooFull.status))
    throw new Error(`unexpected Woo status ${wooFull.status}`);

  close();
  console.log(
    `\nE2E OK in ${((Date.now() - t0) / 1000).toFixed(1)}s: agent bought "${mug.title}" on testnet, order #${order.externalOrderId} paid in WooCommerce, tx ${receipt.txHash}`,
  );
}

main().catch((err) => {
  if (err instanceof AgentGateError)
    console.error(`E2E FAILED ${err.code}: ${err.message}\nhint: ${err.hint}`, err.details ?? "");
  else console.error("E2E FAILED", err);
  process.exit(1);
});
