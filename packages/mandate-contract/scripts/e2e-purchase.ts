/**
 * End to end on Stellar TESTNET: an agent buys in a real AgentPOS store and pays from the
 * mandate account, then tries a purchase the account's mandate does not allow.
 *
 *   seller side: scan the WooCommerce demo store -> confirm -> publish -> sidecar
 *   owner:       issues a session for the agent, capped at the price of one item
 *   agent:       402 -> signs with the session key -> facilitator settles -> order in
 *                WooCommerce -> signed receipt
 *   then:        a cart of two items. The buyer's own mandate is set loose on purpose, as if
 *                the agent's software were wrong or compromised, so the refusal that is shown
 *                is the network's: the account answers 4105 and nothing is paid.
 *
 * Requirements: the demo store (`pnpm demo:up`, or DEMO_STORE_URL), a deployment
 * (`deploy:testnet`), AGENTPOS_FACILITATOR_API_KEY, and SMOKE_USDC_SOURCE_SECRET when the
 * account needs more testnet USDC.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Contract, Keypair, scValToNative } from "@stellar/stellar-sdk";
import {
  AgentPOSError,
  createLogger,
  usdc,
  type ContractAccountPayer,
  type CoreConfig,
  type UsdcMinor,
} from "@agentpos/core";
import { WooCommerceConnector } from "@agentpos/connectors";
import { BuyerService, SpendingLog, mandateSchema, type Profile } from "@agentpos/mcp-buyer";
import { verifyReceipt } from "@agentpos/receipts";
import { scanSite } from "@agentpos/scanner";
import { SiteStorage, createAgentPOS } from "@agentpos/site";
import {
  getMandate,
  issueSession,
  revokeSession,
  signMandateAuthEntry,
  submit,
  type MandateChain,
} from "../src/index.js";
import { scv } from "../src/scval.js";
import {
  chainFor,
  explorerTx,
  fundingSource,
  loadConfig,
  readState,
  tokenContract,
  type TestnetState,
} from "./testnet.js";

const WOO_URL = process.env.DEMO_STORE_URL ?? "http://localhost:8080";
const WOO_CK =
  process.env.AGENTPOS_WOO_CONSUMER_KEY ?? "ck_agentposdemo0000000000000000000000000000";
const WOO_CS =
  process.env.AGENTPOS_WOO_CONSUMER_SECRET ?? "cs_agentposdemo0000000000000000000000000000";
const ITEM_QUERY = process.env.E2E_ITEM ?? "sticker";
const DAY_IN_LEDGERS = 17_280;
const OVER_PAYMENT_CAP = 4105;

const t0 = Date.now();
const step = (message: string): void =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${message}`);

async function balanceOf(chain: MandateChain, token: string, holder: string): Promise<bigint> {
  const account = await chain.server.getAccount(chain.payer.publicKey());
  const { TransactionBuilder, BASE_FEE, rpc } = await import("@stellar/stellar-sdk");
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: chain.networkPassphrase,
  })
    .addOperation(new Contract(token).call("balance", scv.address(holder)))
    .setTimeout(60)
    .build();
  const sim = await chain.server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || !sim.result) throw new Error("cannot read the balance");
  return scValToNative(sim.result.retval) as bigint;
}

/** Tops the account up from the faucet-funded account when it cannot cover `needed`. */
async function ensureBalance(
  core: CoreConfig,
  chain: MandateChain,
  state: TestnetState,
  needed: bigint,
): Promise<void> {
  const balance = await balanceOf(chain, state.token, state.account);
  if (balance >= needed) {
    step(`account holds ${balance} units`);
    return;
  }
  const source = fundingSource(core, chain.payer);
  if (!source) {
    throw new Error(
      `The account holds ${balance} units and needs ${needed}. Set SMOKE_USDC_SOURCE_SECRET or fund ${state.account}.`,
    );
  }
  const funded = await submit(
    { ...chain, payer: source },
    new Contract(state.token).call(
      "transfer",
      scv.address(source.publicKey()),
      scv.address(state.account),
      scv.i128(needed - balance),
    ),
  );
  step(`account topped up to ${needed} units in ${explorerTx(funded.hash)}`);
}

/**
 * Sends the price of the purchase back from the test seller to the account. The seller is a
 * throwaway key of this deployment, so a run recycles its own testnet funds and can be repeated
 * without draining a faucet.
 */
async function returnToAccount(
  chain: MandateChain,
  state: TestnetState,
  amount: bigint,
): Promise<void> {
  const seller = Keypair.fromSecret(state.sellerSecret);
  await submit(
    { ...chain, payer: seller },
    new Contract(state.token).call(
      "transfer",
      scv.address(seller.publicKey()),
      scv.address(state.account),
      scv.i128(amount),
    ),
  );
  step(`test funds recycled: ${amount} units from the seller back to the account`);
}

/** The contract error code a refused payment carries, wherever the error chain holds it. */
function refusalCode(error: unknown): number | undefined {
  for (let current: unknown = error, depth = 0; current && depth < 6; depth += 1) {
    if (current instanceof AgentPOSError) {
      const code = current.details?.contractCode;
      if (typeof code === "number") return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  const match = /contract error (\d+)/.exec(String(error));
  return match ? Number(match[1]) : undefined;
}

async function main(): Promise<void> {
  const core = loadConfig();
  const asset = core.checkoutAsset;
  if (core.facilitatorApiKeys.length === 0) {
    throw new Error("facilitator API key missing (AGENTPOS_FACILITATOR_API_KEY)");
  }
  const state = readState();
  if (state.token !== tokenContract(core)) {
    throw new Error(
      `The deployment's session token is not ${asset}. Deploy and run with the same AGENTPOS_CHECKOUT_ASSET.`,
    );
  }
  const chain = chainFor(core, Keypair.fromSecret(state.payerSecret));
  const owner = {
    account: state.account,
    contextRuleId: 0,
    verifier: state.verifier,
    keys: [Keypair.fromSecret(state.ownerSecret)],
  };
  const sellerAddress = Keypair.fromSecret(state.sellerSecret).publicKey();
  step(`payer ${state.account} (mandate account), seller ${sellerAddress}`);

  // ---- seller side -------------------------------------------------------------------
  const connector = new WooCommerceConnector({
    baseUrl: WOO_URL,
    consumerKey: WOO_CK,
    consumerSecret: WOO_CS,
    allowInsecureHttp: true,
  });
  const storage = new SiteStorage(":memory:");
  const gate = await createAgentPOS({
    site: {
      siteUrl: WOO_URL,
      displayName: "AgentPOS Demo Store",
      payTo: sellerAddress,
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
  storage.replaceDrafts(scan.drafts);
  for (const draft of scan.drafts) {
    if (draft.priceUsdcSuggested !== undefined) {
      gate.catalog.confirm(draft, draft.priceUsdcSuggested);
    }
  }
  const published = gate.catalog.publishAll();
  if (published.length === 0) throw new Error("nothing published; is the demo store seeded?");
  const { port, close } = await gate.serve(0, "127.0.0.1");
  const siteUrl = `http://127.0.0.1:${port}`;
  step(`store: ${published.length} items published, sidecar at ${siteUrl}`);

  const home = mkdtempSync(join(tmpdir(), "agentpos-e2e-contract-"));
  process.env.AGENTPOS_HOME = home;
  const agent = Keypair.random();
  let session: number | undefined;
  try {
    // ---- the agent finds the item; the owner issues a session sized to it ---------------
    const profile: Profile = {
      name: "e2e-contract-account",
      network: core.network,
      keyFile: "unused: the account signs",
      address: agent.publicKey(),
      // Looser than the account's mandate, on purpose: see the header of this file.
      mandate: mandateSchema.parse({
        maxPerTx: "100",
        maxTotal: "100",
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
    const makeBuyer = (contractAccount?: ContractAccountPayer): BuyerService =>
      new BuyerService({
        profile,
        core,
        spendingLog: spending,
        log: (message) => step(`buyer: ${message}`),
        ...(contractAccount ? { contractAccount } : {}),
      });

    const offer = (await makeBuyer().searchOffers(ITEM_QUERY))[0];
    if (!offer) throw new Error(`no offers for '${ITEM_QUERY}'`);
    const price: UsdcMinor = usdc(offer.price.amount);
    step(`agent found "${offer.title}" at ${offer.price.amount} ${offer.price.asset}`);

    // The account must be able to afford the refused purchase too. Otherwise the token would
    // refuse it for lack of balance, and the run would not show the mandate refusing it.
    await ensureBalance(core, chain, state, price * 2n);
    const latest = await chain.server.getLatestLedger();
    const issued = await issueSession(chain, owner, {
      token: state.token,
      policy: state.policy,
      signers: [{ verifier: state.verifier, publicKey: agent.rawPublicKey() }],
      validUntilLedger: latest.sequence + DAY_IN_LEDGERS,
      mandate: {
        perPaymentCap: price,
        periodCap: price * 2n,
        periodLedgers: DAY_IN_LEDGERS,
        sellers: [sellerAddress],
      },
      name: "e2e purchase",
    });
    session = issued.contextRuleId;
    step(
      `owner issued session ${session}: up to ${price} units per payment, in ${explorerTx(issued.hash)}`,
    );

    const sessionRule = session;
    const buyer = makeBuyer({
      address: state.account,
      authorize: (entry, validUntilLedger, networkPassphrase) =>
        signMandateAuthEntry(
          entry,
          {
            account: state.account,
            contextRuleId: sessionRule,
            verifier: state.verifier,
            keys: [agent],
          },
          validUntilLedger,
          networkPassphrase,
        ),
    });

    // ---- 1. a purchase within the mandate ----------------------------------------------
    const cart = await buyer.createCart(siteUrl, [{ itemId: offer.id, quantity: 1 }]);
    step(`cart ${cart.cartId} total ${cart.quote.total} ${asset} payTo ${cart.quote.payTo}`);
    const result = await buyer.buy(siteUrl, cart.cartId);
    step(`PAID tx=${result.receipt.txHash} ${explorerTx(result.receipt.txHash)}`);
    if (result.receipt.payer !== state.account) {
      throw new Error(`the payer was ${result.receipt.payer}, not the mandate account`);
    }
    if (!result.order.externalOrderId) {
      throw new Error(`order not created in WooCommerce: ${JSON.stringify(result.order)}`);
    }
    step(`order ${result.orderId} -> WooCommerce #${result.order.externalOrderId}`);

    const woo = (await (
      await fetch(`${WOO_URL}/wp-json/wc/v3/orders/${result.order.externalOrderId}`, {
        headers: {
          authorization: `Basic ${Buffer.from(`${WOO_CK}:${WOO_CS}`).toString("base64")}`,
        },
      })
    ).json()) as { status: string; transaction_id: string; total: string };
    step(
      `WooCommerce: status=${woo.status} transaction_id=${woo.transaction_id} total=${woo.total}`,
    );
    if (woo.transaction_id !== result.receipt.txHash) {
      throw new Error("tx hash mismatch between the chain and WooCommerce");
    }
    if (!["processing", "completed"].includes(woo.status)) {
      throw new Error(`unexpected WooCommerce status ${woo.status}`);
    }

    const receiptResponse = await fetch(`${siteUrl}/agentpos/orders/${result.orderId}/receipt`);
    const receiptBody = (await receiptResponse.json()) as {
      receipts?: Array<{ hash?: string }>;
    };
    const receipts = receiptBody.receipts ?? [];
    if (receipts.length === 0) throw new Error("the store handed out no receipt for the order");
    for (const receipt of receipts) {
      const verification = verifyReceipt(receipt);
      if (!verification.valid) {
        throw new Error(`receipt does not verify: ${JSON.stringify(verification.issues)}`);
      }
    }
    step(
      `signed receipt: ${receipts.length} entr${receipts.length === 1 ? "y" : "ies"}, verified offline (last hash ${receipts.at(-1)?.hash})`,
    );

    // ---- 2. a purchase the account's mandate does not allow ----------------------------
    await returnToAccount(chain, state, price);
    const tooBig = await buyer.createCart(siteUrl, [{ itemId: offer.id, quantity: 2 }]);
    step(
      `second cart ${tooBig.cartId} total ${tooBig.quote.total} ${asset} (cap per payment ${price})`,
    );
    const before = await balanceOf(chain, state.token, state.account);
    let refusal: unknown;
    try {
      await buyer.buy(siteUrl, tooBig.cartId);
    } catch (error) {
      refusal = error;
    }
    if (refusal === undefined) throw new Error("the purchase over the cap was paid");
    const code = refusalCode(refusal);
    step(
      `REFUSED by the account: contract error ${code ?? "(not reported)"} | ${refusal instanceof Error ? refusal.message : JSON.stringify(refusal)}`,
    );
    if (code !== OVER_PAYMENT_CAP) {
      throw new Error(`expected contract error ${OVER_PAYMENT_CAP}, got ${String(code)}`);
    }
    const after = await balanceOf(chain, state.token, state.account);
    if (after !== before) throw new Error("the refused purchase moved funds");
    const mandate = await getMandate(chain, state.policy, state.account, session);
    if (mandate.spentInPeriod !== price) {
      throw new Error(`the period shows ${mandate.spentInPeriod}, expected ${price}`);
    }
    step(
      `balance unchanged (${after}); spent in period ${mandate.spentInPeriod} of ${mandate.periodCap}`,
    );

    console.log(
      `\nE2E OK in ${((Date.now() - t0) / 1000).toFixed(1)}s: "${offer.title}" paid from contract account ${state.account}, WooCommerce order #${result.order.externalOrderId}, tx ${result.receipt.txHash}; the purchase over the cap was refused with ${code}`,
    );
  } finally {
    if (session !== undefined) {
      const revoked = await revokeSession(chain, owner, session);
      step(`owner revoked session ${session} in ${explorerTx(revoked.hash)}`);
    }
    close();
    rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  if (error instanceof AgentPOSError) {
    console.error(`E2E FAILED ${error.code}: ${error.message}\nhint: ${error.hint}`, error.details);
  } else {
    console.error("E2E FAILED", error);
  }
  process.exit(1);
});
