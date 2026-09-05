/**
 * The WhatsApp webhooks end to end through the Hono app: Meta handshake and payload
 * signature, Twilio signature, routing to the conversation, transport replies, config
 * parsing, and the no-secrets-in-logs rule.
 */
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { isAgentPOSError } from "@agentpos/core";
import { createBuyerWebApp } from "../app.js";
import { configFromEnv } from "../config.js";
import { BuyerWebStorage } from "../storage.js";
import { STORE_URL, inProcessStore } from "../test-utils.js";
import { verifyMetaSignature } from "./meta.js";
import { verifyTwilioSignature } from "./twilio.js";
import type { OutboundMessage } from "./types.js";

const OWNER = "+56911111111";
const OWNER_META = "56911111111"; // Meta sends bare digits
const OWNER_TWILIO = `whatsapp:${OWNER}`;
const SECRET_MESSAGE_TEXT = "buscar mug";

const META_CONFIG = {
  verifyToken: "verify-token-123",
  appSecret: "meta-app-secret",
  accessToken: "meta-access-token",
  phoneNumberId: "111222333",
};
const TWILIO_CONFIG = {
  accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  authToken: "twilio-auth-token",
  fromNumber: "whatsapp:+14155238886",
  webhookUrl: "https://buyer.example/whatsapp/twilio",
};

function makeApp() {
  const storage = new BuyerWebStorage(":memory:");
  const sent: OutboundMessage[] = [];
  const logs: string[] = [];
  const transport = {
    send: async (m: OutboundMessage) => {
      sent.push(m);
    },
  };
  const { app, service } = createBuyerWebApp({
    storage,
    fetchImpl: inProcessStore().fetchImpl,
    whatsapp: { allowedNumbers: [OWNER], meta: META_CONFIG, twilio: TWILIO_CONFIG },
    whatsappTransports: { meta: transport, twilio: transport },
    log: (event, data) => logs.push(JSON.stringify({ event, ...data })),
  });
  return { app, service, sent, logs };
}

function saveProfile(service: ReturnType<typeof makeApp>["service"]): void {
  service.saveProfile({ maxPerTx: "25", maxTotal: "100", period: "week", stores: [STORE_URL] });
}

function metaPayload(text: string, options: { from?: string; type?: string } = {}): string {
  const type = options.type ?? "text";
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "entry-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              messages: [
                {
                  from: options.from ?? OWNER_META,
                  id: "wamid.abc",
                  timestamp: "1700000000",
                  type,
                  ...(type === "text" ? { text: { body: text } } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

function metaSign(body: string, secret = META_CONFIG.appSecret): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

function postMeta(app: ReturnType<typeof makeApp>["app"], body: string, signature?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== undefined) headers["x-hub-signature-256"] = signature;
  return app.request("/whatsapp/meta", { method: "POST", headers, body });
}

function twilioSign(url: string, params: Record<string, string>, token: string): string {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  return createHmac("sha1", token).update(data, "utf8").digest("base64");
}

function postTwilio(
  app: ReturnType<typeof makeApp>["app"],
  params: Record<string, string>,
  signature: string,
) {
  return app.request("/whatsapp/twilio", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body: new URLSearchParams(params).toString(),
  });
}

describe("meta webhook verification (GET)", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(() => {
    ctx = makeApp();
  });

  it("echoes the challenge for the right verify token", async () => {
    const res = await ctx.app.request(
      `/whatsapp/meta?hub.mode=subscribe&hub.verify_token=${META_CONFIG.verifyToken}&hub.challenge=12345`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("12345");
  });

  it("answers 403 for a wrong token and never echoes the challenge", async () => {
    const res = await ctx.app.request(
      "/whatsapp/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345",
    );
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("12345");
  });
});

describe("meta webhook signature (POST)", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(() => {
    ctx = makeApp();
    saveProfile(ctx.service);
  });

  it("accepts a valid HMAC and replies through the transport", async () => {
    const body = metaPayload(SECRET_MESSAGE_TEXT);
    const res = await postMeta(ctx.app, body, metaSign(body));
    expect(res.status).toBe(200);
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent.at(0)?.to).toBe(OWNER_META);
    expect(ctx.sent.at(0)?.text).toContain("Ceramic Mug");
  });

  it("rejects a wrong HMAC with 401 and does nothing", async () => {
    const body = metaPayload(SECRET_MESSAGE_TEXT);
    const res = await postMeta(ctx.app, body, metaSign(body, "wrong-secret"));
    expect(res.status).toBe(401);
    expect(ctx.sent).toHaveLength(0);
  });

  it("rejects a missing signature header with 401", async () => {
    const res = await postMeta(ctx.app, metaPayload(SECRET_MESSAGE_TEXT));
    expect(res.status).toBe(401);
    expect(ctx.sent).toHaveLength(0);
  });

  it("still answers 200 for signed payloads with nothing actionable (no retry storm)", async () => {
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const res = await postMeta(ctx.app, body, metaSign(body));
    expect(res.status).toBe(200);
    expect(ctx.sent).toHaveLength(0);
  });

  it("politely declines media messages, still 200", async () => {
    const body = metaPayload("", { type: "image" });
    const res = await postMeta(ctx.app, body, metaSign(body));
    expect(res.status).toBe(200);
    expect(ctx.sent.at(0)?.text).toContain("mensajes de texto");
  });

  it("verifyMetaSignature is strict about header shape", () => {
    const body = '{"entry":[]}';
    expect(verifyMetaSignature(body, metaSign(body), META_CONFIG.appSecret)).toBe(true);
    expect(verifyMetaSignature(body, undefined, META_CONFIG.appSecret)).toBe(false);
    expect(verifyMetaSignature(body, "sha256=deadbeef", META_CONFIG.appSecret)).toBe(false);
  });
});

describe("twilio webhook", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(() => {
    ctx = makeApp();
    saveProfile(ctx.service);
  });

  it("validates the documented Twilio signature vector", () => {
    // The example from Twilio's security docs: auth token "12345".
    const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
    const params = {
      CallSid: "CA1234567890ABCDE",
      Caller: "+14158675309",
      Digits: "1234",
      From: "+14158675309",
      To: "+18005551212",
    };
    expect(verifyTwilioSignature(url, params, "RSOYDt4T1cUTdK1PDd93/VVr8B8=", "12345")).toBe(true);
    expect(verifyTwilioSignature(url, params, "RSOYDt4T1cUTdK1PDd93/VVr8B9=", "12345")).toBe(false);
    expect(verifyTwilioSignature(url, params, undefined, "12345")).toBe(false);
  });

  it("accepts a correctly signed form post and replies via the transport", async () => {
    const params = { From: OWNER_TWILIO, Body: SECRET_MESSAGE_TEXT, MessageSid: "SM1" };
    const res = await postTwilio(
      ctx.app,
      params,
      twilioSign(TWILIO_CONFIG.webhookUrl, params, TWILIO_CONFIG.authToken),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent.at(0)?.to).toBe(OWNER_TWILIO);
    expect(ctx.sent.at(0)?.text).toContain("Ceramic Mug");
  });

  it("rejects a bad signature with 401 and does nothing", async () => {
    const params = { From: OWNER_TWILIO, Body: SECRET_MESSAGE_TEXT };
    const res = await postTwilio(ctx.app, params, "bogus-signature");
    expect(res.status).toBe(401);
    expect(ctx.sent).toHaveLength(0);
  });
});

describe("mounting and config", () => {
  it("mounts no whatsapp routes when the channel is not configured", async () => {
    const { app } = createBuyerWebApp({
      storage: new BuyerWebStorage(":memory:"),
      fetchImpl: inProcessStore().fetchImpl,
    });
    expect((await app.request("/whatsapp/meta")).status).toBe(404);
    expect((await app.request("/whatsapp/twilio", { method: "POST" })).status).toBe(404);
  });

  it("configFromEnv builds both providers from a full environment", () => {
    const config = configFromEnv({
      WHATSAPP_ALLOWED_NUMBERS: "+56911111111, whatsapp:+56922222222",
      META_VERIFY_TOKEN: "v",
      META_APP_SECRET: "s",
      META_ACCESS_TOKEN: "t",
      META_PHONE_NUMBER_ID: "p",
      TWILIO_ACCOUNT_SID: "AC1",
      TWILIO_AUTH_TOKEN: "tk",
      TWILIO_FROM_NUMBER: "+14155238886",
      TWILIO_WEBHOOK_URL: "https://buyer.example/whatsapp/twilio",
    } as NodeJS.ProcessEnv);
    expect(config.whatsapp?.allowedNumbers).toEqual(["+56911111111", "whatsapp:+56922222222"]);
    expect(config.whatsapp?.meta?.phoneNumberId).toBe("p");
    // The From number is normalized to the whatsapp: form Twilio expects.
    expect(config.whatsapp?.twilio?.fromNumber).toBe("whatsapp:+14155238886");
  });

  it("refuses a partial provider configuration with a typed error", () => {
    try {
      configFromEnv({
        WHATSAPP_ALLOWED_NUMBERS: "+56911111111",
        META_VERIFY_TOKEN: "v",
      } as NodeJS.ProcessEnv);
      throw new Error("expected an AgentPOSError");
    } catch (err) {
      if (!isAgentPOSError(err)) throw err;
      expect(err.code).toBe("CONFIG_INVALID");
      expect(err.hint).toContain("META_APP_SECRET");
    }
  });

  it("refuses a configured provider without an allowlist", () => {
    try {
      configFromEnv({
        META_VERIFY_TOKEN: "v",
        META_APP_SECRET: "s",
        META_ACCESS_TOKEN: "t",
        META_PHONE_NUMBER_ID: "p",
      } as NodeJS.ProcessEnv);
      throw new Error("expected an AgentPOSError");
    } catch (err) {
      if (!isAgentPOSError(err)) throw err;
      expect(err.code).toBe("CONFIG_INVALID");
      expect(err.hint).toContain("WHATSAPP_ALLOWED_NUMBERS");
    }
  });
});

describe("log hygiene", () => {
  it("never logs tokens, phone numbers or message contents", async () => {
    const ctx = makeApp();
    saveProfile(ctx.service);

    // A full Meta flow: search, buy, approve, plus a refused stranger.
    for (const text of [SECRET_MESSAGE_TEXT, "comprar 1", "si"]) {
      const body = metaPayload(text);
      await postMeta(ctx.app, body, metaSign(body));
    }
    const strangerBody = metaPayload("hola", { from: "56999999999" });
    await postMeta(ctx.app, strangerBody, metaSign(strangerBody));
    // And a Twilio message.
    const params = { From: OWNER_TWILIO, Body: "estado", MessageSid: "SM2" };
    await postTwilio(
      ctx.app,
      params,
      twilioSign(TWILIO_CONFIG.webhookUrl, params, TWILIO_CONFIG.authToken),
    );

    expect(ctx.logs.length).toBeGreaterThan(0);
    const joined = ctx.logs.join("\n");
    for (const secret of [
      META_CONFIG.appSecret,
      META_CONFIG.accessToken,
      META_CONFIG.verifyToken,
      TWILIO_CONFIG.authToken,
      TWILIO_CONFIG.accountSid,
      OWNER,
      OWNER_META,
      "56999999999",
      SECRET_MESSAGE_TEXT,
      "comprar",
      "estado",
    ]) {
      expect(joined).not.toContain(secret);
    }
    // What IS logged: event codes plus the 8-char sender hash.
    expect(joined).toContain("whatsapp.meta.inbound");
    expect(joined).toContain("whatsapp.refused");
    expect(joined).toMatch(/"sender":"[0-9a-f]{8}"/);
  });
});
