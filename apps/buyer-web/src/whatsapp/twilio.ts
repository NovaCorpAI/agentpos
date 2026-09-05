/**
 * Twilio WhatsApp adapter: form-encoded webhook with `X-Twilio-Signature` validation and
 * the outbound message transport against the Twilio REST API.
 *
 * Signature scheme (Twilio's own): HMAC-SHA1 over the full public webhook URL followed by
 * every POST parameter name+value concatenated in alphabetical order, base64-encoded,
 * compared with crypto.timingSafeEqual. The URL comes from config (TWILIO_WEBHOOK_URL)
 * because behind a proxy the request URL Twilio signed is not the URL this process sees.
 */
import { createHmac } from "node:crypto";
import type { Context } from "hono";
import { AgentPOSError } from "@agentpos/core";
import type { TwilioWhatsAppConfig } from "../config.js";
import type { ConversationHandler } from "./conversation.js";
import { senderHash, timingSafeEqualStrings } from "./types.js";
import type { WhatsAppLogger, WhatsAppTransport } from "./types.js";

const EMPTY_TWIML = "<Response></Response>";

// --- signature ---------------------------------------------------------------

/** Validate `X-Twilio-Signature` for a form-encoded webhook POST. */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  header: string | undefined,
  authToken: string,
): boolean {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + (params[key] ?? "");
  }
  const expected = createHmac("sha1", authToken).update(data, "utf8").digest("base64");
  if (header === undefined) return false;
  return timingSafeEqualStrings(expected, header);
}

// --- transport ---------------------------------------------------------------

export class TwilioTransport implements WhatsAppTransport {
  private readonly config: TwilioWhatsAppConfig;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(config: TwilioWhatsAppConfig, fetchImpl: typeof globalThis.fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async send(msg: { to: string; text: string }): Promise<void> {
    const credentials = Buffer.from(
      `${this.config.accountSid}:${this.config.authToken}`,
      "utf8",
    ).toString("base64");
    const res = await this.fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.config.accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${credentials}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: this.config.fromNumber,
          To: msg.to,
          Body: msg.text,
        }).toString(),
      },
    );
    if (!res.ok) {
      throw new AgentPOSError("INTERNAL", `Twilio send failed (${res.status})`, {
        hint: "Check TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER; for the sandbox the buyer must have joined it first.",
        retryable: res.status >= 500,
      });
    }
  }
}

// --- webhook handler ---------------------------------------------------------

export interface TwilioWebhookDeps {
  config: TwilioWhatsAppConfig;
  conversation: ConversationHandler;
  transport: WhatsAppTransport;
  log: WhatsAppLogger;
}

async function sendSafe(deps: TwilioWebhookDeps, to: string, text: string): Promise<void> {
  try {
    await deps.transport.send({ to, text });
    deps.log("whatsapp.twilio.reply_sent", { sender: senderHash(to) });
  } catch {
    deps.log("whatsapp.twilio.send_failed", { sender: senderHash(to) });
  }
}

/** Hono handler for `POST {base}/whatsapp/twilio`. Replies go out via the REST transport. */
export function createTwilioWebhook(deps: TwilioWebhookDeps): {
  post: (c: Context) => Promise<Response>;
} {
  return {
    post: async (c) => {
      const rawBody = await c.req.text();
      const params: Record<string, string> = {};
      for (const [key, value] of new URLSearchParams(rawBody)) params[key] = value;
      const signature = c.req.header("x-twilio-signature");
      if (!verifyTwilioSignature(deps.config.webhookUrl, params, signature, deps.config.authToken)) {
        deps.log("whatsapp.twilio.signature_invalid");
        return c.text("Unauthorized", 401);
      }
      const twiml = () => c.body(EMPTY_TWIML, 200, { "content-type": "text/xml" });
      const from = params["From"];
      if (!from) return twiml();
      const text = (params["Body"] ?? "").trim();
      let reply: string | undefined;
      if (text.length > 0) {
        deps.log("whatsapp.twilio.inbound", { sender: senderHash(from) });
        reply = await deps.conversation.handle({
          from,
          text,
          id: params["MessageSid"] ?? "",
          timestamp: String(Date.now()),
        });
      } else {
        deps.log("whatsapp.twilio.inbound_unsupported", { sender: senderHash(from) });
        reply = deps.conversation.handleUnsupported(from);
      }
      if (reply !== undefined) await sendSafe(deps, from, reply);
      return twiml();
    },
  };
}
