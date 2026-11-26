/**
 * `@agentpos/mandate-contract`: client for the AgentPOS mandate contracts on Soroban.
 *
 * Testnet only, not audited. See `contracts/README.md` for what the contracts enforce.
 */
export { signMandateAuthEntry, type MandateAuthorization } from "./auth.js";
export {
  MandateContractError,
  deployContract,
  deployMandateAccount,
  getMandate,
  issueSession,
  revokeSession,
  setMandate,
  submit,
  uploadWasm,
  type MandateChain,
  type MandateState,
  type SessionTerms,
  type Submitted,
} from "./client.js";
export {
  authDigestPreimageScVal,
  authPayloadScVal,
  callContractRuleScVal,
  mandateParamsScVal,
  policiesScVal,
  signerScVal,
  type ExternalSigner,
  type MandateParams,
} from "./scval.js";
