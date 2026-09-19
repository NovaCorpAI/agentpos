/**
 * Environment configuration. Deliberately tiny: a port, a database file, a network, an
 * optional WhatsApp channel (Meta Cloud API and/or Twilio) and an optional owner bootstrap.
 * There is still no slot for a wallet secret because this service must never hold one; the
 * WhatsApp credentials below are messaging credentials, they cannot move money, and the
 * owner bootstrap takes a scrypt HASH, never a password.
 */
import { join } from "node:path";
import { AgentPOSError } from "@agentpos/core";
import { agentposHome } from "@agentpos/mcp-buyer";
import { SCRYPT_HASH_RE } from "./auth/scrypt.js";
import type { OwnerBootstrap } from "./auth/service.js";

export interface MetaWhatsAppConfig {
  /** Shared secret echoed back during Meta's GET webhook handshake. */
  verifyToken: string;
  /** App secret used to verify X-Hub-Signature-256 on every webhook POST. */
  appSecret: string;
  /** Bearer token for the Cloud API send endpoint. */
  accessToken: string;
  /** The WhatsApp phone number id (not the phone number itself). */
  phoneNumberId: string;
}

export interface TwilioWhatsAppConfig {
  accountSid: string;
  authToken: string;
  /** Sender, e.g. "whatsapp:+14155238886" (the sandbox number for demos). */
  fromNumber: string;
  /** The exact public URL Twilio posts to; required to validate X-Twilio-Signature behind a proxy. */
  webhookUrl: string;
}

export interface WhatsAppConfig {
  /** E.164 owner numbers allowed to use the bot; everyone else gets one polite refusal. */
  allowedNumbers: string[];
  meta?: MetaWhatsAppConfig;
  twilio?: TwilioWhatsAppConfig;
}

export interface BuyerWebConfig {
  port: number;
  dbFile: string;
  network: "testnet" | "mainnet";
  /** Present only when at least one provider is fully configured. */
  whatsapp?: WhatsAppConfig;
  /**
   * Bearer token for the signing bridge (`/api/signer/*`). Authorizes ONLY the buyer's own
   * signer daemon (`agentpos-buyer watch`) on the machine that holds the wallet key; the
   * routes are not mounted when it is absent. It is an access token, not a wallet secret:
   * this process still cannot sign or move money.
   */
  signerToken?: string;
  /**
   * The owner account, for a deploy that cannot stop at the setup form. Only ever an email
   * and a scrypt HASH; a plaintext password in the environment is refused outright.
   */
  owner?: OwnerBootstrap;
}

/**
 * Reads the optional owner bootstrap. Both variables or neither, a real hash or nothing:
 * a half-configured account would silently leave the space open at /setup.
 */
function ownerFromEnv(env: NodeJS.ProcessEnv): OwnerBootstrap | undefined {
  if ((env.BUYER_WEB_OWNER_PASSWORD ?? "").trim().length > 0) {
    throw new AgentPOSError(
      "SECRET_IN_CONFIG",
      "BUYER_WEB_OWNER_PASSWORD is a plaintext password",
      {
        hint: "Never put the password in the environment. Generate a hash with `pnpm --filter @agentpos/buyer-web hash-password` (or `node dist/auth/hash-cli.js`) and set BUYER_WEB_OWNER_PASSWORD_HASH instead.",
      },
    );
  }
  const email = (env.BUYER_WEB_OWNER_EMAIL ?? "").trim().toLowerCase();
  const passwordHash = (env.BUYER_WEB_OWNER_PASSWORD_HASH ?? "").trim();
  if (email.length === 0 && passwordHash.length === 0) return undefined;
  if (email.length === 0 || passwordHash.length === 0) {
    throw new AgentPOSError("CONFIG_INVALID", "Incomplete owner bootstrap", {
      hint: "Set BUYER_WEB_OWNER_EMAIL and BUYER_WEB_OWNER_PASSWORD_HASH together, or neither and create the account at /setup.",
    });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AgentPOSError("CONFIG_INVALID", `Invalid BUYER_WEB_OWNER_EMAIL '${email}'`, {
      hint: "Use a full address, e.g. owner@example.com.",
    });
  }
  if (!SCRYPT_HASH_RE.test(passwordHash)) {
    throw new AgentPOSError(
      "CONFIG_INVALID",
      "BUYER_WEB_OWNER_PASSWORD_HASH is not a scrypt hash",
      {
        hint: "It must look like `scrypt$16384$8$1$<salt>$<hash>`. Generate it with `pnpm --filter @agentpos/buyer-web hash-password`; never put the password itself here.",
      },
    );
  }
  return { email, passwordHash };
}

function requireAll(
  env: NodeJS.ProcessEnv,
  provider: string,
  names: string[],
): Record<string, string> | undefined {
  const present = names.filter((n) => (env[n] ?? "").trim().length > 0);
  if (present.length === 0) return undefined;
  if (present.length < names.length) {
    const missing = names.filter((n) => !present.includes(n));
    throw new AgentPOSError("CONFIG_INVALID", `Incomplete ${provider} WhatsApp configuration`, {
      hint: `Set all of ${names.join(", ")} or none. Missing: ${missing.join(", ")}.`,
    });
  }
  const out: Record<string, string> = {};
  for (const n of names) out[n] = (env[n] as string).trim();
  return out;
}

function parseAllowedNumbers(raw: string | undefined): string[] {
  const numbers = (raw ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  for (const n of numbers) {
    if (!/^(whatsapp:)?\+?[0-9][0-9\s-]{5,19}$/.test(n)) {
      throw new AgentPOSError("CONFIG_INVALID", "Invalid entry in WHATSAPP_ALLOWED_NUMBERS", {
        hint: "Use comma-separated E.164 numbers, e.g. +56912345678 (a 'whatsapp:' prefix is fine).",
      });
    }
  }
  return numbers;
}

function whatsappFromEnv(env: NodeJS.ProcessEnv): WhatsAppConfig | undefined {
  const meta = requireAll(env, "Meta", [
    "META_VERIFY_TOKEN",
    "META_APP_SECRET",
    "META_ACCESS_TOKEN",
    "META_PHONE_NUMBER_ID",
  ]);
  const twilio = requireAll(env, "Twilio", [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_FROM_NUMBER",
    "TWILIO_WEBHOOK_URL",
  ]);
  if (!meta && !twilio) return undefined;
  const allowedNumbers = parseAllowedNumbers(env.WHATSAPP_ALLOWED_NUMBERS);
  if (allowedNumbers.length === 0) {
    throw new AgentPOSError("CONFIG_INVALID", "WhatsApp is configured but has no allowed numbers", {
      hint: "Set WHATSAPP_ALLOWED_NUMBERS to the owner's number(s), comma-separated E.164 (e.g. +56912345678). Without it the bot would refuse everyone.",
    });
  }
  let twilioConfig: TwilioWhatsAppConfig | undefined;
  if (twilio) {
    const webhookUrl = twilio["TWILIO_WEBHOOK_URL"] as string;
    try {
      new URL(webhookUrl);
    } catch {
      throw new AgentPOSError("CONFIG_INVALID", `Invalid TWILIO_WEBHOOK_URL '${webhookUrl}'`, {
        hint: "Use the exact public URL Twilio posts to, e.g. https://example.com/whatsapp/twilio",
      });
    }
    const rawFrom = twilio["TWILIO_FROM_NUMBER"] as string;
    twilioConfig = {
      accountSid: twilio["TWILIO_ACCOUNT_SID"] as string,
      authToken: twilio["TWILIO_AUTH_TOKEN"] as string,
      fromNumber: rawFrom.startsWith("whatsapp:") ? rawFrom : `whatsapp:${rawFrom}`,
      webhookUrl,
    };
  }
  return {
    allowedNumbers,
    ...(meta
      ? {
          meta: {
            verifyToken: meta["META_VERIFY_TOKEN"] as string,
            appSecret: meta["META_APP_SECRET"] as string,
            accessToken: meta["META_ACCESS_TOKEN"] as string,
            phoneNumberId: meta["META_PHONE_NUMBER_ID"] as string,
          },
        }
      : {}),
    ...(twilioConfig ? { twilio: twilioConfig } : {}),
  };
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): BuyerWebConfig {
  const rawPort = env.BUYER_WEB_PORT ?? "8788";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AgentPOSError("CONFIG_INVALID", `Invalid BUYER_WEB_PORT '${rawPort}'`, {
      hint: "Use an integer between 1 and 65535.",
    });
  }
  const network = env.AGENTPOS_NETWORK ?? "testnet";
  if (network !== "testnet" && network !== "mainnet") {
    throw new AgentPOSError("CONFIG_INVALID", `Invalid AGENTPOS_NETWORK '${network}'`, {
      hint: "Use 'testnet' or 'mainnet'.",
    });
  }
  const whatsapp = whatsappFromEnv(env);
  const signerToken = (env.SIGNER_TOKEN ?? "").trim();
  if (signerToken.length > 0 && signerToken.length < 24) {
    throw new AgentPOSError("CONFIG_INVALID", "SIGNER_TOKEN is too short", {
      hint: "Use at least 24 characters, e.g. `openssl rand -hex 24`. A guessable token would let anyone mark proposals paid.",
    });
  }
  const owner = ownerFromEnv(env);
  return {
    port,
    network,
    dbFile: env.BUYER_WEB_DB ?? join(agentposHome(), "buyer-web.sqlite"),
    ...(whatsapp ? { whatsapp } : {}),
    ...(signerToken.length > 0 ? { signerToken } : {}),
    ...(owner ? { owner } : {}),
  };
}
