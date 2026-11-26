/**
 * Reads a session of a mandate account from the network: who may sign, until when, under which
 * caps, how much of the period is spent and what the account holds.
 *
 * Read-only. Everything is a simulated contract call; nothing is signed or submitted.
 */
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  StrKey,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { NetworkName } from "../config.js";
import { AgentPOSError } from "../errors.js";

const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
/** A simulation needs a source account; this one exists on every network and signs nothing. */
const NULL_ACCOUNT = StrKey.encodeEd25519PublicKey(Buffer.alloc(32));
/** OpenZeppelin `SmartAccountError::ContextRuleNotFound`. */
const CONTEXT_RULE_NOT_FOUND = 3000;

export interface MandateSessionQuery {
  network: NetworkName;
  /** Soroban RPC URL. Testnet has a public default; mainnet needs one. */
  rpcUrl?: string | undefined;
  /** The mandate account (`C...`). */
  account: string;
  /** Context rule of the session. */
  contextRuleId: number;
}

/** A key that signs for the session, and the verifier contract it is registered with. */
export interface SessionSigner {
  verifier: string;
  /** The key as a Stellar public key (`G...`). */
  publicKey: string;
}

export interface MandateSessionState {
  account: string;
  contextRuleId: number;
  name: string;
  /** The token contract the session may move. */
  token: string;
  signers: SessionSigner[];
  /** Policy contracts of the session. A session without one has no mandate at all. */
  policies: string[];
  /** Last ledger the session is valid at; undefined when it never expires. */
  validUntilLedger: number | undefined;
  latestLedger: number;
  expired: boolean;
  /** What the account holds of the token, in its smallest unit. */
  balance: bigint;
  /** The mandate the first policy enforces; undefined when it is not a mandate policy. */
  mandate:
    | {
        policy: string;
        perPaymentCap: bigint;
        periodCap: bigint;
        periodLedgers: number;
        spentInPeriod: bigint;
        sellers: string[];
      }
    | undefined;
}

function contractCode(text: string): number | undefined {
  const match = /Error\(Contract, #(\d+)\)/.exec(text);
  return match ? Number(match[1]) : undefined;
}

async function read(
  server: rpc.Server,
  networkPassphrase: string,
  contract: string,
  method: string,
  args: xdr.ScVal[],
): Promise<unknown> {
  const tx = new TransactionBuilder(new Account(NULL_ACCOUNT, "0"), {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(new Contract(contract).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    const code = contractCode(sim.error);
    const message =
      code === CONTEXT_RULE_NOT_FOUND
        ? `The account ${contract} has no such session`
        : `${method} on ${contract} failed`;
    throw new AgentPOSError("CONFIG_INVALID", message, {
      hint:
        code === CONTEXT_RULE_NOT_FOUND
          ? "The rule number is wrong, or the owner revoked that session."
          : "Check that the address is a mandate account on this network.",
      details: { contract, method, ...(code === undefined ? {} : { contractCode: code }) },
    });
  }
  return sim.result ? scValToNative(sim.result.retval) : undefined;
}

/** Reads the session, its mandate and the account's balance. */
export async function readMandateSession(query: MandateSessionQuery): Promise<MandateSessionState> {
  const rpcUrl = query.rpcUrl ?? (query.network === "testnet" ? TESTNET_RPC_URL : undefined);
  if (!rpcUrl) {
    throw new AgentPOSError("RPC_URL_REQUIRED", "Reading a mandate account needs a Soroban RPC", {
      hint: "Set AGENTPOS_RPC_URL. Only testnet has a public default.",
    });
  }
  const server = new rpc.Server(rpcUrl);
  const passphrase = query.network === "testnet" ? Networks.TESTNET : Networks.PUBLIC;
  const address = (value: string): xdr.ScVal => new Address(value).toScVal();
  const ruleId = xdr.ScVal.scvU32(query.contextRuleId);

  const rule = (await read(server, passphrase, query.account, "get_context_rule", [ruleId])) as {
    name: string;
    context_type: [string, string?];
    signers: Array<[string, string, Uint8Array?]>;
    policies: string[];
    valid_until: number | null | undefined;
  };
  const [kind, token] = rule.context_type;
  if (kind !== "CallContract" || !token) {
    throw new AgentPOSError("CONFIG_INVALID", "This rule is not a payment session", {
      hint: "A session is scoped to one token contract. Rule 0 is the owner's rule, not a session.",
      details: { contextRuleId: query.contextRuleId, contextType: kind },
    });
  }
  const signers = rule.signers.flatMap(([variant, verifier, key]): SessionSigner[] =>
    variant === "External" && key?.length === 32
      ? [{ verifier, publicKey: StrKey.encodeEd25519PublicKey(Buffer.from(key)) }]
      : [],
  );

  const [latest, balance] = await Promise.all([
    server.getLatestLedger(),
    read(server, passphrase, token, "balance", [address(query.account)]) as Promise<bigint>,
  ]);
  const policy = rule.policies[0];
  let mandate: MandateSessionState["mandate"];
  if (policy) {
    const state = (await read(server, passphrase, policy, "get_mandate", [
      ruleId,
      address(query.account),
    ]).catch(() => undefined)) as
      | {
          per_payment_cap: bigint;
          period_cap: bigint;
          period_ledgers: number;
          spent_in_period: bigint;
          sellers: string[];
        }
      | undefined;
    if (state) {
      mandate = {
        policy,
        perPaymentCap: state.per_payment_cap,
        periodCap: state.period_cap,
        periodLedgers: state.period_ledgers,
        spentInPeriod: state.spent_in_period,
        sellers: state.sellers,
      };
    }
  }
  const validUntilLedger = rule.valid_until ?? undefined;
  return {
    account: query.account,
    contextRuleId: query.contextRuleId,
    name: rule.name,
    token,
    signers,
    policies: rule.policies,
    validUntilLedger,
    latestLedger: latest.sequence,
    expired: validUntilLedger !== undefined && latest.sequence > validUntilLedger,
    balance,
    mandate,
  };
}
