/**
 * @agentpos/buyer-web public API: the channel-agnostic buyer service, its storage, and the
 * HTTP app factory. A messaging channel (WhatsApp bridge) imports BuyerWebService and calls
 * searchOffers / propose / approve / reject / status; the web pages do exactly the same.
 */
export { BuyerWebService } from "./service.js";
export type { BuyerWebServiceDeps, SaveProfileInput } from "./service.js";
export { BuyerWebStorage } from "./storage.js";
export { createBuyerWebApp } from "./app.js";
export type { BuyerWebApp, BuyerWebAppDeps } from "./app.js";
export { configFromEnv } from "./config.js";
export type {
  BuyerWebConfig,
  MetaWhatsAppConfig,
  TwilioWhatsAppConfig,
  WhatsAppConfig,
} from "./config.js";
export { ConversationHandler } from "./whatsapp/conversation.js";
export type { ConversationDeps } from "./whatsapp/conversation.js";
export { MetaTransport, createMetaWebhook, parseMetaWebhook, verifyMetaSignature } from "./whatsapp/meta.js";
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
  ActivityEntry,
  ApprovalResult,
  BuyerWebProfile,
  BuyerWebProfileInput,
  PaymentInstructions,
  Proposal,
  ProposalStatus,
  ServiceStatus,
} from "./types.js";
