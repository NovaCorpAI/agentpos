/**
 * Channel adapter contract for the WhatsApp bridge. Two providers (Meta Cloud API and
 * Twilio) implement the same tiny transport interface; the conversation handler is
 * provider-agnostic and only ever sees these shapes.
 *
 * Privacy rule for the whole module: never log tokens, phone numbers or message contents.
 * Logs carry event codes plus `senderHash` (sha256 of the number, first 8 hex chars) only.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** A text message a buyer sent to the bot. `from` is provider-native (Meta: bare digits, Twilio: "whatsapp:+..."). */
export interface InboundMessage {
  from: string;
  text: string;
  id: string;
  timestamp: string;
}

/** A text reply. `to` is provider-native; adapters reply to the inbound `from` verbatim. */
export interface OutboundMessage {
  to: string;
  text: string;
}

/** What each provider adapter implements to deliver an outbound message. */
export interface WhatsAppTransport {
  send(msg: OutboundMessage): Promise<void>;
}

/**
 * Structured log sink. Event codes only; the caller must never put secrets, phone numbers
 * or message text into `data` (tests enforce this).
 */
export type WhatsAppLogger = (event: string, data?: Record<string, unknown>) => void;

/**
 * Normalize a WhatsApp sender/allowlist entry to bare digits for comparison and state
 * keys: strips the "whatsapp:" prefix, a leading "+" and inner spaces or dashes.
 */
export function normalizeWhatsAppNumber(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^whatsapp:/, "")
    .replace(/[\s-]/g, "")
    .replace(/^\+/, "");
}

/** sha256(normalized number), first 8 hex chars: enough to correlate log lines, nothing more. */
export function senderHash(number: string): string {
  return createHash("sha256").update(normalizeWhatsAppNumber(number)).digest("hex").slice(0, 8);
}

/**
 * Constant-time string comparison for tokens and signatures. Length is not secret here
 * (signatures have fixed length; a length mismatch is an outright reject).
 */
export function timingSafeEqualStrings(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
