/**
 * Signing for an OpenZeppelin smart account on Stellar (`stellar-accounts`), the kind of account
 * the AgentPOS mandate contracts are. It lives next to the signer factory because it is one more
 * way a buyer signs: with a session key, for an account that checks the mandate on chain.
 */
export { signMandateAuthEntry, type MandateAuthorization } from "./auth.js";
export {
  authDigestPreimageScVal,
  authPayloadScVal,
  callContractRuleScVal,
  mandateParamsScVal,
  policiesScVal,
  scv,
  signerScVal,
  type ExternalSigner,
  type MandateParams,
} from "./scval.js";
