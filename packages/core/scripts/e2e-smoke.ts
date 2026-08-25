/**
 * Phase 0 smoke test against Stellar TESTNET (never mainnet):
 *  1. create two ephemeral accounts via friendbot
 *  2. open a USDC trustline on both (Circle testnet issuer)
 *  3. pay 1 XLM from A to B and print the tx hash
 *  4. if SMOKE_USDC_SOURCE_SECRET is set (an account holding testnet USDC, see
 *     https://faucet.circle.com), also pay 0.1 USDC to B and print that hash
 * Facilitator /supported is queried to confirm the x402 rail is up.
 */
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { FRIENDBOT_URL, configFromEnv } from "../src/config.js";

const cfg = configFromEnv(process.env);
if (cfg.network !== "testnet") {
  console.error("e2e:smoke runs on testnet only (guardrail 2).");
  process.exit(1);
}

const horizon = new Horizon.Server(cfg.horizonUrl);
const USDC = new Asset("USDC", cfg.usdcIssuer);
const explorer = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;

async function fund(kp: Keypair): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(kp.publicKey())}`);
  if (!res.ok)
    throw new Error(`friendbot failed for ${kp.publicKey()}: ${res.status} ${await res.text()}`);
}

async function submit(source: Keypair, ops: ReturnType<typeof Operation.payment>[], memo?: string) {
  const account = await horizon.loadAccount(source.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  });
  for (const op of ops) builder.addOperation(op);
  const tx = builder.setTimeout(60).build();
  if (memo) void memo;
  tx.sign(source);
  const result = await horizon.submitTransaction(tx);
  return result.hash;
}

async function main(): Promise<void> {
  console.log(`network=${cfg.network} caip2=${cfg.caip2} facilitator=${cfg.facilitatorUrl}`);

  const apiKey = cfg.facilitatorApiKeys[0];
  const supported = await fetch(`${cfg.facilitatorUrl}/supported`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  console.log(
    `facilitator /supported -> ${supported.status}${apiKey ? "" : " (no AGENTGATE_FACILITATOR_API_KEY: 401 expected)"}`,
  );
  if (supported.ok) {
    const body = (await supported.json()) as { kinds?: Array<{ network: string; scheme: string }> };
    const kinds = body.kinds?.map((k) => `${k.scheme}@${k.network}`).join(", ");
    console.log(`facilitator kinds: ${kinds ?? "(none listed)"}`);
  }

  const a = Keypair.random();
  const b = Keypair.random();
  console.log(`A=${a.publicKey()}\nB=${b.publicKey()}`);
  await Promise.all([fund(a), fund(b)]);
  console.log("friendbot funded both accounts");

  const trustA = await submit(a, [Operation.changeTrust({ asset: USDC })]);
  const trustB = await submit(b, [Operation.changeTrust({ asset: USDC })]);
  console.log(`USDC trustlines: A ${trustA} | B ${trustB}`);

  const xlmHash = await submit(a, [
    Operation.payment({ destination: b.publicKey(), asset: Asset.native(), amount: "1" }),
  ]);
  console.log(`XLM payment 1 XLM A->B: ${xlmHash}\n  ${explorer(xlmHash)}`);

  const usdcSecret = process.env.SMOKE_USDC_SOURCE_SECRET;
  if (usdcSecret) {
    const src = Keypair.fromSecret(usdcSecret);
    const usdcHash = await submit(src, [
      Operation.payment({ destination: b.publicKey(), asset: USDC, amount: "0.1" }),
    ]);
    console.log(
      `USDC payment 0.1 USDC ${src.publicKey()}->B: ${usdcHash}\n  ${explorer(usdcHash)}`,
    );
  } else {
    console.log(
      "SMOKE_USDC_SOURCE_SECRET not set: skipped real USDC transfer (fund one at https://faucet.circle.com).",
    );
  }

  const balances = (await horizon.loadAccount(b.publicKey())).balances
    .map((bal) => `${"asset_code" in bal ? bal.asset_code : "XLM"}=${bal.balance}`)
    .join(" ");
  console.log(`B balances: ${balances}`);
  console.log("SMOKE OK");
}

main().catch((err) => {
  console.error("SMOKE FAILED", err);
  process.exit(1);
});
