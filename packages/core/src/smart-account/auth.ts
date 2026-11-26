/**
 * Signing for a mandate account.
 *
 * A mandate account does not take the classic `{public_key, signature}` value. Its signers
 * sign a digest that binds the account, the context rule and the host's payload, and the
 * signature value is an `AuthPayload`. All cryptography is the SDK's Ed25519.
 */
import { authorizeEntry, hash, type Keypair, type xdr } from "@stellar/stellar-sdk";
import { authDigestPreimageScVal, authPayloadScVal } from "./scval.js";

/** Who signs for the account, and under which context rule. */
export interface MandateAuthorization {
  /** The mandate account (`C...`). */
  account: string;
  /** Context rule the signature is made under: 0 is the owner rule, a session has its own. */
  contextRuleId: number;
  /** The Ed25519 verifier contract the keys are registered with. */
  verifier: string;
  /** Keys that sign. A session rule needs every one of its signers. */
  keys: readonly Keypair[];
}

/**
 * Signs one authorization entry of the account. Returns a signed copy; the entry's nonce is
 * kept, its expiration is set to `validUntilLedger`.
 */
export async function signMandateAuthEntry(
  entry: xdr.SorobanAuthorizationEntry,
  auth: MandateAuthorization,
  validUntilLedger: number,
  networkPassphrase: string,
): Promise<xdr.SorobanAuthorizationEntry> {
  const rules = [auth.contextRuleId];
  return authorizeEntry(
    entry,
    // The second argument is the hash the host passes to `__check_auth`.
    (_preimage, signaturePayload) => {
      const digest = hash(authDigestPreimageScVal(auth.account, signaturePayload, rules).toXDR());
      const signatures = auth.keys.map((key) => ({
        signer: { verifier: auth.verifier, publicKey: key.rawPublicKey() },
        signature: key.sign(digest),
      }));
      return Promise.resolve({ signatureScVal: authPayloadScVal(signatures, rules) });
    },
    validUntilLedger,
    networkPassphrase,
  );
}
