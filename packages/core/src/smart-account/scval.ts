/**
 * Soroban values for the mandate contracts.
 *
 * These mirror the Rust types of `contracts/` and of OpenZeppelin's `stellar-accounts`
 * (pinned at 0.8.0). A `#[contracttype]` struct is a map with symbol keys in alphabetical
 * order; an enum variant is a vector that starts with the variant's name.
 */
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";

/** A session or owner key: `Signer::External(verifier, ed25519 public key)`. */
export interface ExternalSigner {
  /** The Ed25519 verifier contract (`C...`). */
  verifier: string;
  /** Raw 32-byte Ed25519 public key. */
  publicKey: Uint8Array;
}

/** The mandate of a session, as the policy contract takes it on install. */
export interface MandateParams {
  /** Maximum amount of a single payment, in the token's smallest unit. */
  perPaymentCap: bigint;
  /** Maximum total over the rolling period, in the token's smallest unit. */
  periodCap: bigint;
  /** Length of the rolling period, in ledgers (17280 is about one day). */
  periodLedgers: number;
  /** Addresses the agent may pay. */
  sellers: readonly string[];
}

const sym = (name: string): xdr.ScVal => xdr.ScVal.scvSymbol(name);
const u32 = (value: number): xdr.ScVal => xdr.ScVal.scvU32(value);
const i128 = (value: bigint): xdr.ScVal => nativeToScVal(value, { type: "i128" });
const address = (value: string): xdr.ScVal => new Address(value).toScVal();
const bytes = (value: Uint8Array): xdr.ScVal => xdr.ScVal.scvBytes(Buffer.from(value));

function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  const entries = Object.keys(fields)
    .sort()
    .map((key) => new xdr.ScMapEntry({ key: sym(key), val: fields[key] as xdr.ScVal }));
  return xdr.ScVal.scvMap(entries);
}

export function signerScVal(signer: ExternalSigner): xdr.ScVal {
  return xdr.ScVal.scvVec([sym("External"), address(signer.verifier), bytes(signer.publicKey)]);
}

/** `ContextRuleType::CallContract(contract)`: the rule only authorizes calls to that contract. */
export function callContractRuleScVal(contract: string): xdr.ScVal {
  return xdr.ScVal.scvVec([sym("CallContract"), address(contract)]);
}

export function mandateParamsScVal(params: MandateParams): xdr.ScVal {
  return struct({
    per_payment_cap: i128(params.perPaymentCap),
    period_cap: i128(params.periodCap),
    period_ledgers: u32(params.periodLedgers),
    sellers: xdr.ScVal.scvVec(params.sellers.map(address)),
  });
}

/** `Map<Address, Val>` with one entry: the policy contract and its install parameters. */
export function policiesScVal(policy: string, params: MandateParams): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: address(policy), val: mandateParamsScVal(params) }),
  ]);
}

/** `AuthDigestPreimage`: what every signer of the account commits to. */
export function authDigestPreimageScVal(
  account: string,
  signaturePayload: Uint8Array,
  contextRuleIds: readonly number[],
): xdr.ScVal {
  return struct({
    account: address(account),
    context_rule_ids: xdr.ScVal.scvVec(contextRuleIds.map(u32)),
    signature_payload: bytes(signaturePayload),
  });
}

/** `AuthPayload`: the account's signature value, with one signature per signer. */
export function authPayloadScVal(
  signatures: ReadonlyArray<{ signer: ExternalSigner; signature: Uint8Array }>,
  contextRuleIds: readonly number[],
): xdr.ScVal {
  // Map keys must be in the host's order. Signers here share the variant and, in practice,
  // the verifier, so ordering by the XDR bytes of the key gives that order.
  const entries = signatures
    .map(({ signer, signature }) => ({ key: signerScVal(signer), val: bytes(signature) }))
    .sort((a, b) => Buffer.compare(a.key.toXDR(), b.key.toXDR()))
    .map((entry) => new xdr.ScMapEntry(entry));
  return struct({
    context_rule_ids: xdr.ScVal.scvVec(contextRuleIds.map(u32)),
    signers: xdr.ScVal.scvMap(entries),
  });
}

export const scv = { sym, u32, i128, address, bytes };
