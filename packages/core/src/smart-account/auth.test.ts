import { describe, expect, it } from "vitest";
import {
  Address,
  Keypair,
  Networks,
  hash,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { signMandateAuthEntry } from "./auth.js";
import {
  authDigestPreimageScVal,
  authPayloadScVal,
  mandateParamsScVal,
  signerScVal,
} from "./scval.js";

const contractId = (seed: number): string => Address.contract(Buffer.alloc(32, seed)).toString();

const ACCOUNT = contractId(1);
const VERIFIER = contractId(2);
const TOKEN = contractId(3);
const SELLER = Keypair.random().publicKey();
const NONCE = 4242n;

function transferEntry(amount: bigint): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(ACCOUNT).toScAddress(),
        nonce: xdr.Int64.fromString(NONCE.toString()),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(TOKEN).toScAddress(),
          functionName: "transfer",
          args: [
            new Address(ACCOUNT).toScVal(),
            new Address(SELLER).toScVal(),
            nativeToScVal(amount, { type: "i128" }),
          ],
        }),
      ),
      subInvocations: [],
    }),
  });
}

/** The hash the host hands to `__check_auth` for this entry. */
function hostPayload(entry: xdr.SorobanAuthorizationEntry, validUntil: number): Buffer {
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(Networks.TESTNET)),
      nonce: entry.credentials().address().nonce(),
      signatureExpirationLedger: validUntil,
      invocation: entry.rootInvocation(),
    }),
  );
  return hash(preimage.toXDR());
}

function mapKeys(value: xdr.ScVal): string[] {
  return (value.map() ?? []).map((entry) => entry.key().sym().toString());
}

describe("signMandateAuthEntry", () => {
  it("signs the digest bound to the account and the rule, as an AuthPayload", async () => {
    const agent = Keypair.random();
    const entry = transferEntry(5_000_000n);
    const signed = await signMandateAuthEntry(
      entry,
      { account: ACCOUNT, contextRuleId: 7, verifier: VERIFIER, keys: [agent] },
      1234,
      Networks.TESTNET,
    );

    const credentials = signed.credentials().address();
    expect(credentials.signatureExpirationLedger()).toBe(1234);
    expect(credentials.nonce().toString()).toBe(NONCE.toString());

    const signature = credentials.signature();
    expect(mapKeys(signature)).toEqual(["context_rule_ids", "signers"]);
    const fields = signature.map() ?? [];
    expect(scValToNative(fields[0]!.val())).toEqual([7]);

    const signers = fields[1]!.val().map() ?? [];
    expect(signers).toHaveLength(1);
    const expectedKey = signerScVal({ verifier: VERIFIER, publicKey: agent.rawPublicKey() });
    expect(signers[0]!.key().toXDR("base64")).toBe(expectedKey.toXDR("base64"));

    const digest = hash(authDigestPreimageScVal(ACCOUNT, hostPayload(entry, 1234), [7]).toXDR());
    expect(agent.verify(digest, signers[0]!.val().bytes())).toBe(true);
  });

  it("does not produce a signature that holds under another rule or another account", async () => {
    const agent = Keypair.random();
    const entry = transferEntry(5_000_000n);
    const signed = await signMandateAuthEntry(
      entry,
      { account: ACCOUNT, contextRuleId: 7, verifier: VERIFIER, keys: [agent] },
      1234,
      Networks.TESTNET,
    );
    const signature = (signed.credentials().address().signature().map() ?? [])[1]!
      .val()
      .map()![0]!
      .val()
      .bytes();
    const payload = hostPayload(entry, 1234);
    const otherRule = hash(authDigestPreimageScVal(ACCOUNT, payload, [0]).toXDR());
    const otherAccount = hash(authDigestPreimageScVal(contractId(9), payload, [7]).toXDR());
    expect(agent.verify(otherRule, signature)).toBe(false);
    expect(agent.verify(otherAccount, signature)).toBe(false);
  });

  it("leaves the entry it was given untouched", async () => {
    const entry = transferEntry(1n);
    const before = entry.toXDR("base64");
    await signMandateAuthEntry(
      entry,
      { account: ACCOUNT, contextRuleId: 1, verifier: VERIFIER, keys: [Keypair.random()] },
      99,
      Networks.TESTNET,
    );
    expect(entry.toXDR("base64")).toBe(before);
  });

  it("carries one signature per key when a session has several signers", async () => {
    const keys = [Keypair.random(), Keypair.random(), Keypair.random()];
    const signed = await signMandateAuthEntry(
      transferEntry(1n),
      { account: ACCOUNT, contextRuleId: 1, verifier: VERIFIER, keys },
      99,
      Networks.TESTNET,
    );
    const signers = (signed.credentials().address().signature().map() ?? [])[1]!.val().map()!;
    expect(signers).toHaveLength(3);
  });
});

describe("contract values", () => {
  it("orders a map of signers by key, whatever order they are given in", () => {
    const signers = [1, 2, 3, 4].map(() => ({
      signer: { verifier: VERIFIER, publicKey: Keypair.random().rawPublicKey() },
      signature: Buffer.alloc(64, 1),
    }));
    const forward = authPayloadScVal(signers, [1]).toXDR("base64");
    const backward = authPayloadScVal([...signers].reverse(), [1]).toXDR("base64");
    expect(forward).toBe(backward);

    const keys = (authPayloadScVal(signers, [1]).map() ?? [])[1]!
      .val()
      .map()!
      .map((entry) => entry.key().toXDR());
    const sorted = [...keys].sort((a, b) => Buffer.compare(a, b));
    expect(keys).toEqual(sorted);
  });

  it("writes the mandate with its fields in the order the contract reads them", () => {
    const params = mandateParamsScVal({
      perPaymentCap: 10_000_000n,
      periodCap: 20_000_000n,
      periodLedgers: 17_280,
      sellers: [SELLER],
    });
    expect(mapKeys(params)).toEqual(["per_payment_cap", "period_cap", "period_ledgers", "sellers"]);
    expect(scValToNative(params)).toEqual({
      per_payment_cap: 10_000_000n,
      period_cap: 20_000_000n,
      period_ledgers: 17_280,
      sellers: [SELLER],
    });
  });
});
