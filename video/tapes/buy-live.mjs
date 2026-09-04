/** The money shot: a REAL 1 USDC purchase on Stellar mainnet, recorded live. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { createLocalKeypairSigner, resolveConfig } from "@agentpos/core";
import { BuyerService, SpendingLog, mandateSchema, runDemoPurchase } from "@agentpos/mcp-buyer";

const STORE = "https://demo.agentposhq.com";
const kp = Keypair.fromSecret(process.env.E2E_BUYER_SECRET_MAINNET);
const core = resolveConfig({ network: "mainnet", allowMainnet: true, checkoutAsset: "USDC",
  ...(process.env.AGENTPOS_RPC_URL_MAINNET ? { rpcUrl: process.env.AGENTPOS_RPC_URL_MAINNET } : {}) });
const home = mkdtempSync(join(tmpdir(), "agentpos-video-"));
process.env.AGENTPOS_HOME = home;
const buyer = new BuyerService({
  profile: {
    name: "video", network: "mainnet", keyFile: "unused", address: kp.publicKey(),
    mandate: mandateSchema.parse({ maxPerTx: "1", maxTotal: "1", period: "day",
      allowedSellers: [new URL(STORE).host], allowPhysicalGoods: false, shippingAddressLocked: true }),
    buyer: { email: "agent@novacorplabs.com", name: "AgentPOS Reference Agent" },
    sites: [STORE], createdAt: new Date().toISOString(),
  },
  core, signer: createLocalKeypairSigner(kp.secret(), "mainnet"),
  spendingLog: new SpendingLog(join(home, "spending.jsonl")),
});
const r = await runDemoPurchase({ storeUrl: STORE, itemId: "support-agentpos-thank-you-ap-support",
  buyerService: buyer, buyer: { email: "agent@novacorplabs.com" },
  onStep: (s) => console.log(`${s.step.padEnd(9)} ${s.message}`) });
if (r.paid) {
  console.log(`\nstellar.expert/explorer/public/tx/${r.txHash}`);
  console.log(`receipt:  ${STORE}/agentpos/orders/${r.order?.orderId ?? ""}/receipt`);
}
