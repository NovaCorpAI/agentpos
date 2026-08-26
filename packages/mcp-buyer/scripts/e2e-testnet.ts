/**
 * End to end on Stellar TESTNET, the way a real agent does it:
 *   seller side: scan the local WooCommerce demo store -> confirm -> publish -> sidecar
 *   buyer side:  BuyerService with a human mandate -> search -> cart -> buy (real facilitator)
 *   proof:       tx hash on-chain, spending log entry, order PAID in WooCommerce with the hash.
 *
 * Requirements: `pnpm demo:up` (http://localhost:8080) and AGENTGATE_FACILITATOR_API_KEY in .env.
 * Uses AGENTGATE_CHECKOUT_ASSET=XLM so friendbot can fund the buyer (no USDC faucet in CI).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  AgentGateError,
  FRIENDBOT_URL,
  configFromEnv,
  createLocalKeypairSigner,
  createLogger,
  formatUsdc,
} from "@agentgate/core";
import { WooCommerceConnector } from "@agentgate/connectors";
import { scanSite } from "@agentgate/scanner";
import { createAgentGate, SiteStorage } from "@agentgate/site";
import { BuyerService } from "../src/buyer.js";
import { mandateSchema } from "../src/mandate.js";
import type { Profile } from "../src/profile.js";
import { SpendingLog } from "../src/spending.js";

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

/** Opens the USDC trustline so the account can receive USDC (classic asset on Stellar). */
async function trustUsdc(kp: Keypair): Promise<void> {
  const horizon = new Horizon.Server(core.horizonUrl);
  const account = await horizon.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: new Asset("USDC", core.usdcIssuer) }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  await horizon.submitTransaction(tx);
}

async function main(): Promise<void> {
  const seller = Keypair.random();
  // USDC runs need a buyer that already holds testnet USDC (faucet.circle.com): E2E_BUYER_SECRET.
  const buyerSecret = process.env.E2E_BUYER_SECRET ?? process.env.SMOKE_USDC_SOURCE_SECRET;
  if (core.checkoutAsset === "USDC" && !buyerSecret) {
    throw new Error(
      "USDC e2e needs E2E_BUYER_SECRET (or SMOKE_USDC_SOURCE_SECRET) holding testnet USDC",
    );
  }
  const buyerKp =
    core.checkoutAsset === "USDC" ? Keypair.fromSecret(buyerSecret as string) : Keypair.random();
  await Promise.all([fund(seller), ...(core.checkoutAsset === "USDC" ? [] : [fund(buyerKp)])]);
  if (core.checkoutAsset === "USDC") await trustUsdc(seller);
  step(
    `seller ${seller.publicKey()} (friendbot${core.checkoutAsset === "USDC" ? " + USDC trustline" : ""}), buyer ${buyerKp.publicKey()} (${core.checkoutAsset === "USDC" ? "faucet-funded USDC" : "friendbot XLM"})`,
  );

  // ---- seller side -----------------------------------------------------------
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
    logger: createLogger({ format: "pretty", sink: (line) => step(`site: ${line}`) }),
  });
  const scan = await scanSite({
    baseUrl: WOO_URL,
    connector,
    fetcher: { minIntervalMs: 0 },
    maxPages: 20,
  });
  step(`scan: ${scan.drafts.length} drafts ${JSON.stringify(scan.stats)}`);
  storage.replaceDrafts(scan.drafts);
  for (const d of scan.drafts)
    if (d.priceUsdcSuggested !== undefined) gate.catalog.confirm(d, d.priceUsdcSuggested);
  const published = gate.catalog.publishAll();
  step(`published ${published.length} items`);
  if (published.length === 0) throw new Error("nothing published; is the demo store seeded?");
  const { port, close } = await gate.serve(0, "127.0.0.1");
  const siteUrl = `http://127.0.0.1:${port}`;
  step(`sidecar listening at ${siteUrl}`);

  // ---- buyer side: a human mandate, an agent acting inside it -------------------
  const home = mkdtempSync(join(tmpdir(), "agentgate-e2e-"));
  process.env.AGENTGATE_HOME = home;
  const profile: Profile = {
    name: "e2e",
    network: "testnet",
    keyFile: "unused-in-e2e",
    address: buyerKp.publicKey(),
    mandate: mandateSchema.parse({
      maxPerTx: "20",
      maxTotal: "50",
      period: "day",
      allowedSellers: [new URL(siteUrl).host],
      allowPhysicalGoods: true,
      shippingAddressLocked: true,
    }),
    buyer: { email: "agent@example.com", name: "Agent Smith" },
    shipping: {
      name: "Agent Smith",
      line1: "1 Loop St",
      city: "Springfield",
      postalCode: "12345",
      country: "US",
    },
    sites: [siteUrl],
    createdAt: new Date().toISOString(),
  };
  const spending = new SpendingLog(join(home, "spending.jsonl"));
  const buyer = new BuyerService({
    profile,
    core,
    signer: createLocalKeypairSigner(buyerKp.secret(), "testnet"),
    spendingLog: spending,
    log: (m) => step(`buyer: ${m}`),
  });

  const offers = await buyer.searchOffers("mug");
  const mug = offers[0];
  if (!mug) throw new Error("no offers for 'mug'");
  step(`agent found "${mug.title}" at ${mug.price.amount} ${mug.price.asset} on ${mug.siteName}`);

  // Mandate must refuse an over-limit cart before touching the wallet.
  const tooBig = await buyer.createCart(siteUrl, [{ itemId: mug.id, quantity: 3 }]);
  try {
    await buyer.buy(siteUrl, tooBig.cartId);
    throw new Error("mandate did not block an over-limit purchase");
  } catch (err) {
    if (!(err instanceof AgentGateError) || err.code !== "MANDATE_EXCEEDED") throw err;
    step(
      `mandate blocked ${tooBig.quote.total} ${core.checkoutAsset} (> maxPerTx 20): ${err.code}`,
    );
  }

  const cart = await buyer.createCart(siteUrl, [{ itemId: mug.id, quantity: 1 }]);
  step(
    `cart ${cart.cartId} total ${cart.quote.total} ${core.checkoutAsset} payTo ${cart.quote.payTo}`,
  );
  const result = await buyer.buy(siteUrl, cart.cartId);
  step(
    `PAID tx=${result.receipt.txHash} https://stellar.expert/explorer/testnet/tx/${result.receipt.txHash}`,
  );
  if (!result.order.externalOrderId)
    throw new Error(`order not created in Woo: ${JSON.stringify(result.order)}`);
  step(`order ${result.orderId} -> WooCommerce #${result.order.externalOrderId}`);
  const log = spending.entries();
  step(
    `spending log: ${log.length} entry, ${formatUsdc(BigInt(log[0]!.amountMinor) as never)} ${log[0]!.asset}`,
  );

  // ---- proof in the merchant platform ------------------------------------------
  const woo = (await (
    await fetch(`${WOO_URL}/wp-json/wc/v3/orders/${result.order.externalOrderId}`, {
      headers: { authorization: `Basic ${Buffer.from(`${WOO_CK}:${WOO_CS}`).toString("base64")}` },
    })
  ).json()) as { status: string; transaction_id: string; payment_method: string; total: string };
  step(
    `WooCommerce: status=${woo.status} payment_method=${woo.payment_method} transaction_id=${woo.transaction_id} total=${woo.total}`,
  );
  if (woo.transaction_id !== result.receipt.txHash)
    throw new Error("tx hash mismatch between chain and WooCommerce");
  if (!["processing", "completed"].includes(woo.status))
    throw new Error(`unexpected Woo status ${woo.status}`);

  close();
  rmSync(home, { recursive: true, force: true });
  console.log(
    `\nE2E OK in ${((Date.now() - t0) / 1000).toFixed(1)}s: agent under mandate bought "${mug.title}" on testnet, order #${result.order.externalOrderId} paid in WooCommerce, tx ${result.receipt.txHash}`,
  );
}

main().catch((err) => {
  if (err instanceof AgentGateError)
    console.error(`E2E FAILED ${err.code}: ${err.message}\nhint: ${err.hint}`, err.details ?? "");
  else console.error("E2E FAILED", err);
  process.exit(1);
});
