/**
 * @agentpos/buyer-web public API: the channel-agnostic buyer service, its storage, and the
 * HTTP app factory. A messaging channel (WhatsApp bridge) imports BuyerWebService and calls
 * searchOffers / propose / approve / reject / status; the web pages do exactly the same.
 */
export { BuyerWebService, parseAttributePairs } from "./service.js";
export type {
  BuyerWebServiceDeps,
  MarketCallInput,
  SaveProfileInput,
  ShippingInput,
} from "./service.js";
export { BuyerWebStorage } from "./storage.js";
export { createBuyerWebApp } from "./app.js";
export type { BuyerWebApp, BuyerWebAppDeps, BuyerWebEnv } from "./app.js";
export { AuthService, MIN_PASSWORD_LENGTH, SESSION_TTL_MS } from "./auth/service.js";
export type { AuthenticatedSession, AuthServiceDeps, OwnerBootstrap } from "./auth/service.js";
export { AuthError, isAuthError } from "./auth/errors.js";
export type { AuthErrorCode } from "./auth/errors.js";
export { hashPassword, SCRYPT_HASH_RE, verifyPassword } from "./auth/scrypt.js";
export { emailHash, ipHash, sha8, uaFamily } from "./auth/fingerprint.js";
export type { RequestOrigin } from "./auth/fingerprint.js";
export { CSRF_FIELD, CSRF_HEADER, SESSION_COOKIE } from "./auth/http.js";
export { configFromEnv } from "./config.js";
export type {
  BuyerWebConfig,
  MetaWhatsAppConfig,
  TwilioWhatsAppConfig,
  WhatsAppConfig,
} from "./config.js";
export { ConversationHandler } from "./whatsapp/conversation.js";
export type { ConversationDeps } from "./whatsapp/conversation.js";
export {
  MetaTransport,
  createMetaWebhook,
  parseMetaWebhook,
  verifyMetaSignature,
} from "./whatsapp/meta.js";
export { TwilioTransport, createTwilioWebhook, verifyTwilioSignature } from "./whatsapp/twilio.js";
export { normalizeWhatsAppNumber, senderHash } from "./whatsapp/types.js";
export type {
  InboundMessage,
  OutboundMessage,
  WhatsAppLogger,
  WhatsAppTransport,
} from "./whatsapp/types.js";
export { buyerWebProfileSchema, STELLAR_PUBLIC_KEY_RE } from "./types.js";
export type {
  AccessEntry,
  ActivityEntry,
  ApprovalResult,
  BuyerWebProfile,
  BuyerWebProfileInput,
  OwnerAccount,
  PaymentInstructions,
  Proposal,
  ProposalStatus,
  ServiceStatus,
  SessionRecord,
  SignerQueueItem,
} from "./types.js";
