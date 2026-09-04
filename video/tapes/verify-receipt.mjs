/** Fetch the live store's receipt for today's real purchase and verify it OFFLINE. */
import { verifyReceipt } from "@agentpos/receipts";

const url = "https://demo.agentposhq.com/agentpos/orders/ord_AQJX7nz9sXG0/receipt";
console.log(`fetching  ${url}`);
const body = await (await fetch(url)).json();
const receipt = body.receipts[0];
console.log(`receipt   #${receipt.body.seq}  event=${receipt.body.event}  signer=${receipt.body.store.signer.slice(0, 12)}...`);
console.log(`terms     ${receipt.body.terms.totalMinor} minor USDC -> ${receipt.body.terms.payTo.slice(0, 12)}...`);
console.log(`payment   tx ${receipt.body.payment.txHash.slice(0, 24)}...  (stellar:pubnet)`);
console.log("");
console.log("verifying offline: sha256(canonical body) + Ed25519 against the store's signer...");
const result = verifyReceipt(receipt);
console.log(result.valid ? "VALID ✓  the store cannot rewrite this sale. Nobody can." : `INVALID: ${JSON.stringify(result.issues)}`);
