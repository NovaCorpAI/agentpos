import { rpc } from "@stellar/stellar-sdk";
import { ExactStellarScheme as ClientScheme } from "@x402/stellar/exact/client";
import { ExactStellarScheme as FacScheme } from "@x402/stellar/exact/facilitator";
import { createEd25519Signer } from "@x402/stellar";
import { createLocalKeypairSigner } from "./dist/index.js";

const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const requirements = {
  scheme: "exact", network: "stellar:pubnet", asset: USDC,
  payTo: "GDTD355XEM6S5DAZGZUO46I3X6YYB4EBHP2UPKA6F7NVGTRCQ7SZNG5P",
  amount: "1000000", maxTimeoutSeconds: 300, extra: { areFeesSponsored: true },
} as any;

const orig = rpc.Server.prototype.sendTransaction;
(rpc.Server.prototype as any).sendTransaction = async function (tx: any) {
  const res: any = await orig.call(this, tx);
  let err;
  try { err = res.errorResult ? res.errorResult.result().switch().name : undefined; } catch { err = res.errorResult ? "presente-no-parseable" : undefined; }
  console.log("RAW sendTransaction:", JSON.stringify({ status: res.status, err, hash: res.hash?.slice(0,12) }));
  return res;
};

const buyerSigner = createLocalKeypairSigner(process.env.E2E_BUYER_SECRET_MAINNET!, "mainnet");
const client = new ClientScheme(buyerSigner as any, { url: process.env.AGENTPOS_RPC_URL_MAINNET! });
const facSigner = createEd25519Signer(process.env.DIAG_FEE_SECRET!, "stellar:pubnet");
const fac = new FacScheme([facSigner], { rpcConfig: { url: process.env.DIAG_FAC_RPC! }, maxTransactionFeeStroops: 50_000 });

const p = await client.createPaymentPayload(2, requirements);
const payload = { x402Version: 2, accepted: requirements, payload: p.payload } as any;
console.log("verify:", JSON.stringify(await fac.verify(payload, requirements)).slice(0, 140));
console.log("settle:", JSON.stringify(await fac.settle(payload, requirements)).slice(0, 220));
