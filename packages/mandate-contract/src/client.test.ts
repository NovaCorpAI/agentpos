import { describe, expect, it } from "vitest";
import { Address, Keypair, scValToNative, type xdr } from "@stellar/stellar-sdk";
import { issueSessionOperation } from "./client.js";

const contractId = (seed: number): string => Address.contract(Buffer.alloc(32, seed)).toString();

const ACCOUNT = contractId(1);
const VERIFIER = contractId(2);
const POLICY = contractId(3);
const TOKEN = contractId(4);

function invocation(operation: xdr.Operation): xdr.InvokeContractArgs {
  return operation.body().invokeHostFunctionOp().hostFunction().invokeContract();
}

describe("issueSessionOperation", () => {
  const agent = Keypair.random();
  const seller = Keypair.random().publicKey();
  const operation = issueSessionOperation(ACCOUNT, {
    token: TOKEN,
    policy: POLICY,
    signers: [{ verifier: VERIFIER, publicKey: agent.rawPublicKey() }],
    validUntilLedger: 123_456,
    mandate: {
      perPaymentCap: 10_000_000n,
      periodCap: 20_000_000n,
      periodLedgers: 17_280,
      sellers: [seller],
    },
  });
  const call = invocation(operation);
  const args = call.args();

  it("calls add_context_rule on the account itself", () => {
    expect(Address.fromScAddress(call.contractAddress()).toString()).toBe(ACCOUNT);
    expect(call.functionName().toString()).toBe("add_context_rule");
    expect(args).toHaveLength(5);
  });

  it("scopes the session to the token, so the key can call nothing else", () => {
    expect(scValToNative(args[0]!)).toEqual(["CallContract", TOKEN]);
  });

  it("gives the session an expiry", () => {
    expect(scValToNative(args[2]!)).toBe(123_456);
  });

  it("registers the agent's key behind the verifier", () => {
    const signers = scValToNative(args[3]!) as Array<[string, string, Uint8Array]>;
    expect(signers).toHaveLength(1);
    expect(signers[0]![0]).toBe("External");
    expect(signers[0]![1]).toBe(VERIFIER);
    expect(Buffer.from(signers[0]![2]).equals(agent.rawPublicKey())).toBe(true);
  });

  it("installs the mandate as the policy of that session", () => {
    const policies = args[4]!.map() ?? [];
    expect(policies).toHaveLength(1);
    expect(Address.fromScVal(policies[0]!.key()).toString()).toBe(POLICY);
    expect(scValToNative(policies[0]!.val())).toEqual({
      per_payment_cap: 10_000_000n,
      period_cap: 20_000_000n,
      period_ledgers: 17_280,
      sellers: [seller],
    });
  });
});
