/**
 * @agentpos/merchant-web public API.
 *
 * The merchant onboarding wizard: a stateless web app (Hono) where a store owner produces a
 * valid AgentPOS configuration and verifies their deployment. Run it with `pnpm dev` or embed
 * the app in any fetch-compatible server.
 */
export { createMerchantWebApp } from "./app.js";
export type { MerchantWebDeps, InstallerGate } from "./app.js";
export { buildHoldingHtml, WAITLIST_URL } from "./hold.js";
export { buildWizardHtml } from "./page.js";
export { validateWalletAddress } from "./wallet.js";
export { generateFiles, generateRequestSchema } from "./generate.js";
export type { GenerateRequest, GeneratedOutput } from "./generate.js";
export { validateWooCredentials, wooValidationRequestSchema } from "./woo.js";
export type { WooValidationRequest, WooValidationResult } from "./woo.js";
export { verifyDeployment, normalizeDomain, verifyRequestSchema } from "./verify.js";
export {
  assertPublicUrl,
  createGuardedFetch,
  ipRefusalReason,
  systemResolver,
  ALLOWED_PORTS,
  MAX_RESPONSE_BYTES,
} from "./ssrf.js";
export type { GuardedFetchOptions, HostResolver } from "./ssrf.js";
export { clientIp, rateLimit, TokenBucketLimiter, VERIFY_RULE, WOO_RULE } from "./limits.js";
export type { VerifyCheck, VerifyCheckId, VerifyRequest, VerifyResult } from "./verify.js";
