// Stellar 8004 spike (testnet only).
//
// Proves the three calls AgentPOS needs from the Stellar 8004 registries (Trion Labs):
//   1. the buyer agent registers in the identity registry;
//   2. a store, from its own key, writes feedback that carries the SHA-256 of a receipt;
//   3. anyone reads the agent's reputation summary back.
//
// It uses throwaway keys funded by friendbot, so it needs no secrets and can run in CI.
// Run: npm install && npm run spike
import { createHash } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import {
  TESTNET_CONFIG,
  buildMetadataJson,
  createClients,
  formatSorobanError,
  fundTestnet,
  toDataUri,
  wrapBasicSigner,
} from '@trionlabs/stellar8004';

const config = TESTNET_CONFIG;
if (config.network !== 'testnet') throw new Error('This spike only runs on testnet.');

const explorer = (hash) => `https://stellar.expert/explorer/testnet/tx/${hash}`;

async function send(label, registry, assembled) {
  try {
    const sent = await assembled.signAndSend();
    const hash = sent.sendTransactionResponse?.hash;
    if (!hash) throw new Error(`${label}: no transaction hash`);
    return { result: sent.result, hash };
  } catch (err) {
    throw new Error(`${label}: ${formatSorobanError(err, registry)}`, { cause: err });
  }
}

// Two independent parties: the agent's owner and the store that sold to it.
const agentOwner = Keypair.random();
const store = Keypair.random();
await Promise.all([fundTestnet(agentOwner.publicKey()), fundTestnet(store.publicKey())]);

const asAgentOwner = createClients(config, wrapBasicSigner(agentOwner, config.networkPassphrase));
const asStore = createClients(config, wrapBasicSigner(store, config.networkPassphrase));
const readOnly = createClients(config);

// 1. Register the agent. The agent URI is a public profile with no personal data.
const profile = buildMetadataJson({
  name: 'AgentPOS buyer agent (spike)',
  description: 'Buys from AgentPOS stores under a spending mandate. Pays USDC on Stellar via x402.',
  services: [],
  supportedTrust: ['reputation'],
  x402Enabled: true,
  mppEnabled: false,
});
const registered = await send(
  'register',
  'identity',
  await asAgentOwner.identity.register_with_uri({
    caller: agentOwner.publicKey(),
    agent_uri: toDataUri(profile),
  }),
);
const agentId = Number(registered.result);

// 2. The store gives feedback. The record carries the hash of the order's receipt, so the
//    reputation entry and the receipt can be checked against each other.
const receipt = {
  type: 'agentpos.receipt.spike',
  order: 'spike-order-1',
  amount: '10000000',
  asset: 'USDC',
  network: 'stellar:testnet',
  seller: store.publicKey(),
  agentId,
};
const receiptJson = JSON.stringify(receipt);
const receiptHash = createHash('sha256').update(receiptJson).digest();
const feedback = await send(
  'give_feedback',
  'reputation',
  await asStore.reputation.give_feedback({
    caller: store.publicKey(),
    agent_id: agentId,
    value: 100n,
    value_decimals: 0,
    tag1: 'order',
    tag2: 'settled',
    endpoint: '',
    feedback_uri: `data:application/json;base64,${Buffer.from(receiptJson).toString('base64')}`,
    feedback_hash: new Uint8Array(receiptHash),
  }),
);

// 3. Read it back without any key.
const owner = (await readOnly.identity.owner_of({ token_id: agentId }).catch(() => null))?.result;
const summary = (
  await readOnly.reputation.get_summary({
    agent_id: agentId,
    client_addresses: [store.publicKey()],
    tag1: '',
    tag2: '',
  })
).result.unwrap();

const out = {
  network: config.network,
  registries: config.contracts,
  agentId,
  agentOwner: agentOwner.publicKey(),
  agentOwnerOnChain: owner ?? null,
  store: store.publicKey(),
  registerTx: registered.hash,
  registerTxUrl: explorer(registered.hash),
  feedbackTx: feedback.hash,
  feedbackTxUrl: explorer(feedback.hash),
  receiptSha256: receiptHash.toString('hex'),
  summary: {
    count: Number(summary.count),
    value: Number(summary.summary_value),
    decimals: summary.summary_value_decimals,
  },
};
console.log(JSON.stringify(out, null, 2));

if (out.summary.count !== 1) throw new Error(`expected 1 feedback record, got ${out.summary.count}`);
console.log('OK: agent registered, feedback written by the store, summary read back.');
