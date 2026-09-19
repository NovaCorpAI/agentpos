/**
 * Sending the owner something they did not ask for in a chat: today, the six-digit code
 * that gets them back into their own space after a lost password.
 *
 * Two rules, and they are the whole file:
 *  1. It goes out through the SAME transport the bot replies through (Meta or Twilio, as
 *     configured). There is no second send path to audit, to rate-limit or to forget.
 *  2. It can only ever reach a number on WHATSAPP_ALLOWED_NUMBERS. The destination is
 *     checked here, against the configured allowlist, not against anything a provider,
 *     a webhook or a form said. A number that is not on the list is refused outright,
 *     even when the caller insists.
 *
 * Privacy rule inherited from the rest of the module: no phone number, no message body and
 * no code ever reaches a log line. Event codes and `senderHash` only.
 */
import { AgentPOSError } from "@agentpos/core";
import type { WhatsAppConfig } from "../config.js";
import { normalizeWhatsAppNumber, senderHash } from "./types.js";
import type { WhatsAppLogger, WhatsAppTransport } from "./types.js";

/** Which provider a message goes through, and how that provider wants the number written. */
type Provider = "meta" | "twilio";

export interface OwnerNotifierDeps {
  config: WhatsAppConfig;
  /** The very transports the webhooks reply with. Tests inject fakes, as they do there. */
  transports: { meta?: WhatsAppTransport; twilio?: WhatsAppTransport };
  log: WhatsAppLogger;
}

/**
 * Sends to the owner. `send(text)` picks the first allowlisted number;
 * `sendTo(number, text)` exists so the allowlist check has a caller to refuse.
 */
export interface OwnerWhatsAppNotifier {
  send(text: string): Promise<void>;
  sendTo(number: string, text: string): Promise<void>;
  /** The number messages go to, exactly as the environment wrote it. */
  readonly ownerNumber: string;
}

/** Meta wants bare digits, Twilio wants `whatsapp:+<digits>`. */
function formatFor(provider: Provider, number: string): string {
  const digits = normalizeWhatsAppNumber(number);
  return provider === "twilio" ? `whatsapp:+${digits}` : digits;
}

/**
 * Builds the notifier, or `undefined` when the channel is not configured (no provider, or
 * no allowlisted number). `undefined` is what makes the recovery page stop offering
 * WhatsApp at all, rather than offering a button that quietly does nothing.
 */
export function createOwnerNotifier(deps: OwnerNotifierDeps): OwnerWhatsAppNotifier | undefined {
  const ownerNumber = deps.config.allowedNumbers[0];
  if (ownerNumber === undefined) return undefined;
  const provider: Provider | undefined = deps.transports.meta
    ? "meta"
    : deps.transports.twilio
      ? "twilio"
      : undefined;
  if (provider === undefined) return undefined;
  const transport = provider === "meta" ? deps.transports.meta : deps.transports.twilio;
  if (transport === undefined) return undefined;
  const allowed = new Set(deps.config.allowedNumbers.map(normalizeWhatsAppNumber));

  const sendTo = async (number: string, text: string): Promise<void> => {
    if (!allowed.has(normalizeWhatsAppNumber(number))) {
      deps.log("whatsapp.notify_refused", { sender: senderHash(number) });
      throw new AgentPOSError(
        "APPROVAL_UNAUTHORIZED",
        "Refusing to message a number outside WHATSAPP_ALLOWED_NUMBERS",
        {
          hint: "Recovery codes only ever go to the owner's own allowlisted number. Add the number to WHATSAPP_ALLOWED_NUMBERS if it really is the owner's.",
        },
      );
    }
    await transport.send({ to: formatFor(provider, number), text });
    deps.log("whatsapp.notify_sent", { sender: senderHash(number) });
  };

  return {
    ownerNumber,
    sendTo,
    send: (text: string) => sendTo(ownerNumber, text),
  };
}
