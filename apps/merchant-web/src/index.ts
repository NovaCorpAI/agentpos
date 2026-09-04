/**
 * @agentpos/merchant-web public API.
 *
 * The merchant onboarding wizard: a stateless web app (Hono) where a store owner produces a
 * valid AgentPOS configuration and verifies their deployment. Run it with `pnpm dev` or embed
 * the app in any fetch-compatible server.
 */
export { createMerchantWebApp } from "./app.js";
export type { MerchantWebDeps } from "./app.js";
export { buildWizardHtml } from "./page.js";
export { validateWalletAddress } from "./wallet.js";
export { generateFiles, generateRequestSchema } from "./generate.js";
export type { GenerateRequest, GeneratedOutput } from "./generate.js";
export { validateWooCredentials, wooValidationRequestSchema } from "./woo.js";
export type { WooValidationRequest, WooValidationResult } from "./woo.js";
export { verifyDeployment, normalizeDomain } from "./verify.js";
export type { VerifyCheck, VerifyCheckId, VerifyResult } from "./verify.js";
