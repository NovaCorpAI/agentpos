/**
 * Meta WhatsApp Cloud API adapter: webhook verification (GET handshake + POST payload
 * signature) and the outbound message transport against graph.facebook.com.
 *
 * Security: the POST signature is HMAC-SHA256 of the RAW request body with the app secret
 * (header `X-Hub-Signature-256: sha256=<hex>`), compared with crypto.timingSafeEqual. The
 * expected value is computed before looking at the header so both paths do the same work.
 * After the signature passes we always answer 200, even when nothing is actionable,
 * so Meta does not retry-storm.
 */
import { createHmac } from "node:crypto";
import type { Context } from "hono";
import { z } from "zod";
import { AgentPOSError } from "@agentpos/core";
import type { MetaWhatsAppConfig } from "../config.js";
import type { ConversationHandler } from "./conversation.js";
import { senderHash, timingSafeEqualStrings } from "./types.js";
import type { InboundMessage, WhatsAppLogger, WhatsAppTransport } from "./types.js";

const GRAPH_BASE = "https://graph.facebook.com/v21.0";

// --- signature and handshake -------------------------------------------------

/** Verify `X-Hub-Signature-256` over the raw body. Missing header rejects, in constant shape. */
export function verifyMetaSignature(
  rawBody: string,
  header: string | undefined,
  appSecret: string,
): boolean {
  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`;
  if (header === undefined) return false;
  return timingSafeEqualStrings(expected, header);
}

// --- inbound payload ---------------------------------------------------------

const metaMessageSchema = z
  .object({
    from: z.string().min(1),
    id: z.string().default(""),
    timestamp: z.string().default(""),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
  })
  .loose();

const metaPayloadSchema = z
  .object({
    entry: z
      .array(
        z
          .object({
            changes: z
              .array(
                z
                  .object({
                    value: z
                      .object({ messages: z.array(metaMessageSchema).optional() })
                      .loose(),
                  })
                  .loose(),
              )
              .default([]),
          })
          .loose(),
      )
      .default([]),
  })
  .loose();

export interface ParsedMetaWebhook {
  messages: InboundMessage[];
  /** Senders of non-text messages (media, audio, ...) to politely decline. */
  unsupportedSenders: string[];
}

/** Extract text messages from a webhook payload. Anything unparseable is simply ignored. */
export function parseMetaWebhook(payload: unknown): ParsedMetaWebhook {
  const parsed = metaPayloadSchema.safeParse(payload);
  const messages: InboundMessage[] = [];
  const unsupportedSenders: string[] = [];
  if (!parsed.success) return { messages, unsupportedSenders };
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      for (const m of change.value.messages ?? []) {
        if (m.type === "text" && m.text) {
          messages.push({ from: m.from, text: m.text.body, id: m.id, timestamp: m.timestamp });
        } else {
          unsupportedSenders.push(m.from);
        }
      }
    }
  }
  return { messages, unsupportedSenders };
}

// --- transport ---------------------------------------------------------------

export class MetaTransport implements WhatsAppTransport {
  private readonly config: MetaWhatsAppConfig;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(config: MetaWhatsAppConfig, fetchImpl: typeof globalThis.fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async send(msg: { to: string; text: string }): Promise<void> {
    const res = await this.fetchImpl(
      `${GRAPH_BASE}/${encodeURIComponent(this.config.phoneNumberId)}/messages`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: msg.to,
          type: "text",
          text: { body: msg.text },
        }),
      },
    );
    if (!res.ok) {
      throw new AgentPOSError("INTERNAL", `WhatsApp Cloud API send failed (${res.status})`, {
        hint: "Check META_ACCESS_TOKEN and META_PHONE_NUMBER_ID; tokens expire.",
        retryable: res.status >= 500,
      });
    }
  }
}

// --- webhook handlers --------------------------------------------------------

export interface MetaWebhookDeps {
  config: MetaWhatsAppConfig;
  conversation: ConversationHandler;
  transport: WhatsAppTransport;
  log: WhatsAppLogger;
}

async function sendSafe(deps: MetaWebhookDeps, to: string, text: string): Promise<void> {
  try {
    await deps.transport.send({ to, text });
    deps.log("whatsapp.meta.reply_sent", { sender: senderHash(to) });
  } catch {
    deps.log("whatsapp.meta.send_failed", { sender: senderHash(to) });
  }
}

/** Hono handlers for `GET/POST {base}/whatsapp/meta`. */
export function createMetaWebhook(deps: MetaWebhookDeps): {
  get: (c: Context) => Response;
  post: (c: Context) => Promise<Response>;
} {
  return {
    // GET: Meta's one-time subscription handshake.
    get: (c) => {
      const mode = c.req.query("hub.mode") ?? "";
      const token = c.req.query("hub.verify_token") ?? "";
      const challenge = c.req.query("hub.challenge") ?? "";
      if (mode === "subscribe" && timingSafeEqualStrings(deps.config.verifyToken, token)) {
        deps.log("whatsapp.meta.verified");
        return c.text(challenge, 200);
      }
      deps.log("whatsapp.meta.verify_failed");
      return c.text("Forbidden", 403);
    },
    // POST: signed event delivery.
    post: async (c) => {
      const rawBody = await c.req.text();
      const signature = c.req.header("x-hub-signature-256");
      if (!verifyMetaSignature(rawBody, signature, deps.config.appSecret)) {
        deps.log("whatsapp.meta.signature_invalid");
        return c.text("Unauthorized", 401);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        deps.log("whatsapp.meta.bad_json");
        return c.json({ ok: true });
      }
      const { messages, unsupportedSenders } = parseMetaWebhook(payload);
      for (const message of messages) {
        deps.log("whatsapp.meta.inbound", { sender: senderHash(message.from) });
        const reply = await deps.conversation.handle(message);
        if (reply !== undefined) await sendSafe(deps, message.from, reply);
      }
      for (const from of unsupportedSenders) {
        deps.log("whatsapp.meta.inbound_unsupported", { sender: senderHash(from) });
        const reply = deps.conversation.handleUnsupported(from);
        if (reply !== undefined) await sendSafe(deps, from, reply);
      }
      return c.json({ ok: true });
    },
  };
}
