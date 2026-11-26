/**
 * `@agentpos/mandate-contract`: client for the AgentPOS mandate contracts on Soroban.
 *
 * Testnet only, not audited. See `contracts/README.md` for what the contracts enforce.
 */
// The signing itself lives in the core, next to the other signers; re-exported for convenience.
export { signMandateAuthEntry, type MandateAuthorization } from "@agentpos/core";
export {
  MandateContractError,
  deployContract,
  deployMandateAccount,
  getMandate,
  issueSession,
  issueSessionOperation,
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
} from "@agentpos/core";
