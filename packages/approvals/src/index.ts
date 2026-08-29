export { ApprovalService, MemoryApprovalStore, DEFAULT_TTL_MINUTES } from "./service.js";
export type { ApprovalServiceOptions, GateResult } from "./service.js";
export { canonicalize, hashSnapshot } from "./snapshot.js";
export {
  assertValidResolutionSignature,
  signResolution,
  signaturePayload,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  SIGNATURE_WINDOW_SECONDS,
} from "./signature.js";
export {
  EmailChannel,
  TwilioWhatsAppChannel,
  WebhookChannel,
  describeApproval,
} from "./channels.js";
export type {
  EmailChannelOptions,
  TwilioWhatsAppOptions,
  WebhookChannelOptions,
} from "./channels.js";
export { APPROVAL_STATUSES } from "./types.js";
export type {
  ApprovalLine,
  ApprovalLinks,
  ApprovalRequest,
  ApprovalSnapshot,
  ApprovalStatus,
  ApprovalStore,
  NotificationChannel,
} from "./types.js";
