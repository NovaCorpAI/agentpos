/**
 * Client for the mandate contracts: deploy them, and run the owner operations (issue a
 * session, set the policy, revoke a session) and the read of a mandate's state.
 *
 * Zero custody: every key is a local `Keypair` the caller holds. `payer` only pays network
 * fees; it has no power over the account.
 */
import {
  Address,
  BASE_FEE,
  Contract,
  Operation,
  TransactionBuilder,
  hash,
  rpc,
  scValToNative,
  xdr,
  type Keypair,
} from "@stellar/stellar-sdk";
import { contractErrorFromSimulation } from "@agentpos/core";
import { signMandateAuthEntry, type MandateAuthorization } from "@agentpos/core";
import {
  callContractRuleScVal,
  policiesScVal,
  scv,
  signerScVal,
  type ExternalSigner,
  type MandateParams,
} from "@agentpos/core";

/** Ledgers a signature stays valid for (about five minutes). */
const AUTH_VALIDITY_LEDGERS = 60;
const POLL_INTERVAL_MS = 1000;
const POLL_ATTEMPTS = 60;

export interface MandateChain {
  server: rpc.Server;
  networkPassphrase: string;
  /** Classic account that pays the network fees of each transaction. */
  payer: Keypair;
}

export interface Submitted {
  hash: string;
  returnValue: xdr.ScVal | undefined;
}

/** A transaction the network refused, in simulation or on submission. */
export class MandateContractError extends Error {
  readonly code: "SIMULATION_FAILED" | "SUBMISSION_FAILED" | "TRANSACTION_FAILED";
  /** Contract error code found in the diagnostics (for example 4105), when there is one. */
  readonly contractCode: number | undefined;
  readonly hint: string;

  constructor(
    code: MandateContractError["code"],
    message: string,
    hint: string,
    contractCode?: number,
  ) {
    super(message);
    this.name = "MandateContractError";
    this.code = code;
    this.hint = hint;
    this.contractCode = contractCode;
  }
}

function isForAddress(entry: xdr.SorobanAuthorizationEntry, account: string): boolean {
  const credentials = entry.credentials();
  if (credentials.switch().name !== "sorobanCredentialsAddress") return false;
  return Address.fromScAddress(credentials.address().address()).toString() === account;
}

async function build(chain: MandateChain, operation: xdr.Operation) {
  const source = await chain.server.getAccount(chain.payer.publicKey());
  return new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: chain.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(120)
    .build();
}

async function simulate(chain: MandateChain, tx: Awaited<ReturnType<typeof build>>) {
  const sim = await chain.server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new MandateContractError(
      "SIMULATION_FAILED",
      `The network refused the call in simulation: ${sim.error}`,
      "Nothing was submitted. A contract error code, when present, says which rule refused it.",
      contractErrorFromSimulation(sim),
    );
  }
  return sim;
}

/**
 * Simulates, signs the account's authorization entries when `authorization` is given,
 * simulates again so the footprint covers `__check_auth`, then submits and waits.
 */
export async function submit(
  chain: MandateChain,
  operation: xdr.Operation,
  authorization?: MandateAuthorization,
): Promise<Submitted> {
  let tx = await build(chain, operation);
  let sim = await simulate(chain, tx);

  if (authorization) {
    const latest = await chain.server.getLatestLedger();
    const validUntil = latest.sequence + AUTH_VALIDITY_LEDGERS;
    const entries = sim.result?.auth ?? [];
    const signed = await Promise.all(
      entries.map((entry) =>
        isForAddress(entry, authorization.account)
          ? signMandateAuthEntry(entry, authorization, validUntil, chain.networkPassphrase)
          : Promise.resolve(entry),
      ),
    );
    const invoke = tx.operations[0];
    if (!invoke || invoke.type !== "invokeHostFunction") {
      throw new TypeError("An authorized call must be a single invokeHostFunction operation");
    }
    tx = await build(chain, Operation.invokeHostFunction({ func: invoke.func, auth: signed }));
    sim = await simulate(chain, tx);
  }

  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(chain.payer);
  const sent = await chain.server.sendTransaction(prepared);
  if (sent.status !== "PENDING") {
    throw new MandateContractError(
      "SUBMISSION_FAILED",
      `The network did not accept the transaction (${sent.status})`,
      "Nothing was applied. Retry when the status is TRY_AGAIN_LATER.",
    );
  }
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const result = await chain.server.getTransaction(sent.hash);
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { hash: sent.hash, returnValue: result.returnValue };
    }
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new MandateContractError(
        "TRANSACTION_FAILED",
        `Transaction ${sent.hash} failed on the network`,
        "Look the hash up in an explorer for the diagnostic events.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new MandateContractError(
    "TRANSACTION_FAILED",
    `Transaction ${sent.hash} was not confirmed in time`,
    "It may still land. Look the hash up before sending it again.",
  );
}

/** Uploads a contract's WASM. Returns its hash, which is what `deployContract` takes. */
export async function uploadWasm(chain: MandateChain, wasm: Uint8Array): Promise<Buffer> {
  const code = Buffer.from(wasm);
  await submit(chain, Operation.uploadContractWasm({ wasm: code }));
  return hash(code);
}

/** Creates a contract from an uploaded WASM. Returns its address (`C...`). */
export async function deployContract(
  chain: MandateChain,
  wasmHash: Buffer,
  constructorArgs: xdr.ScVal[] = [],
): Promise<string> {
  const { returnValue } = await submit(
    chain,
    Operation.createCustomContract({
      address: new Address(chain.payer.publicKey()),
      wasmHash,
      constructorArgs,
    }),
  );
  if (!returnValue) throw new TypeError("The deployment returned no contract address");
  return Address.fromScVal(returnValue).toString();
}

/** Creates a mandate account owned by `owners`. All of them sign an owner operation. */
export function deployMandateAccount(
  chain: MandateChain,
  wasmHash: Buffer,
  owners: readonly ExternalSigner[],
): Promise<string> {
  return deployContract(chain, wasmHash, [xdr.ScVal.scvVec(owners.map(signerScVal))]);
}

export interface SessionTerms {
  /** Token the session may move (the USDC contract). */
  token: string;
  /** The mandate policy contract. */
  policy: string;
  /** Keys of the agent. Every one must sign each payment. */
  signers: readonly ExternalSigner[];
  /** Last ledger the session is valid at. */
  validUntilLedger: number;
  mandate: MandateParams;
  name?: string;
}

/**
 * The call that issues a session: `add_context_rule` on the account, scoped to the token, with
 * the agent's keys as signers and the mandate as the policy's install parameters.
 */
export function issueSessionOperation(account: string, terms: SessionTerms): xdr.Operation {
  return new Contract(account).call(
    "add_context_rule",
    callContractRuleScVal(terms.token),
    xdr.ScVal.scvString(terms.name ?? "agent session"),
    scv.u32(terms.validUntilLedger),
    xdr.ScVal.scvVec(terms.signers.map(signerScVal)),
    policiesScVal(terms.policy, terms.mandate),
  );
}

/** Owner operation: issue a session. Returns the id of its context rule. */
export async function issueSession(
  chain: MandateChain,
  owner: MandateAuthorization,
  terms: SessionTerms,
): Promise<{ contextRuleId: number; hash: string }> {
  const operation = issueSessionOperation(owner.account, terms);
  const { hash: txHash, returnValue } = await submit(chain, operation, owner);
  const rule: unknown = returnValue ? scValToNative(returnValue) : undefined;
  const id = (rule as { id?: unknown } | undefined)?.id;
  if (typeof id !== "number") throw new TypeError("add_context_rule returned no rule id");
  return { contextRuleId: id, hash: txHash };
}

/** Owner operation: revoke a session. The next payment finds no rule. */
export function revokeSession(
  chain: MandateChain,
  owner: MandateAuthorization,
  contextRuleId: number,
): Promise<Submitted> {
  const operation = new Contract(owner.account).call("remove_context_rule", scv.u32(contextRuleId));
  return submit(chain, operation, owner);
}

/** Owner operation: change the caps and the sellers of a session. */
export function setMandate(
  chain: MandateChain,
  owner: MandateAuthorization,
  policy: string,
  contextRuleId: number,
  terms: Pick<MandateParams, "perPaymentCap" | "periodCap" | "sellers">,
): Promise<Submitted> {
  const operation = new Contract(policy).call(
    "set_mandate",
    scv.i128(terms.perPaymentCap),
    scv.i128(terms.periodCap),
    xdr.ScVal.scvVec(terms.sellers.map(scv.address)),
    scv.u32(contextRuleId),
    scv.address(owner.account),
  );
  return submit(chain, operation, owner);
}

export interface MandateState extends MandateParams {
  /** Total spent inside the rolling period as of the current ledger. */
  spentInPeriod: bigint;
}

/** Reads a session's mandate and what it has spent in the current period. */
export async function getMandate(
  chain: MandateChain,
  policy: string,
  account: string,
  contextRuleId: number,
): Promise<MandateState> {
  const operation = new Contract(policy).call(
    "get_mandate",
    scv.u32(contextRuleId),
    scv.address(account),
  );
  const sim = await simulate(chain, await build(chain, operation));
  const value = sim.result?.retval;
  if (!value) throw new TypeError("get_mandate returned nothing");
  const state = scValToNative(value) as {
    per_payment_cap: bigint;
    period_cap: bigint;
    period_ledgers: number;
    spent_in_period: bigint;
    sellers: string[];
  };
  return {
    perPaymentCap: state.per_payment_cap,
    periodCap: state.period_cap,
    periodLedgers: state.period_ledgers,
    spentInPeriod: state.spent_in_period,
    sellers: state.sellers,
  };
}
