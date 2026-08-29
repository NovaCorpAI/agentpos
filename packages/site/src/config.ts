/**
 * Site configuration: `agentgate.config.json` in the site's working directory + env vars for
 * secrets (facilitator key, connector credentials). Never persisted anywhere else.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { AgentGateError, assertNoSecretsInConfig, configFromEnv } from "@agentgate/core";
import { OPEN_POLICY, merchantPolicySchema } from "@agentgate/policy";
import { IDENTITY_MODES } from "@agentgate/identity";
import type { CoreConfig } from "@agentgate/core";

export const SITE_CONFIG_FILE = "agentgate.config.json";

const stellarAddress = z
  .string()
  .regex(/^[GC][A-Z2-7]{55}$/, "Stellar address must be a G... or C... key");

export const siteConfigSchema = z.object({
  /** Public URL of the merchant's site, e.g. https://shop.example */
  siteUrl: z.url(),
  displayName: z.string().min(1),
  /** Stellar address that receives payments (the merchant's own wallet). */
  payTo: stellarAddress,
  platform: z.enum(["woocommerce", "generic", "none"]).default("none"),
  woocommerce: z
    .object({
      baseUrl: z.url(),
      /** Local demo stores only. */
      allowInsecureHttp: z.boolean().default(false),
    })
    .optional(),
  /** Path prefix for AgentGate routes on the site. */
  basePath: z
    .string()
    .regex(/^\/[a-z0-9-]+$/)
    .default("/agentgate"),
  cartTtlMinutes: z.number().int().min(1).max(120).default(15),
  /** Directory (relative to cwd) for the SQLite database and drafts. */
  dataDir: z.string().default(".agentgate"),
  policies: z
    .object({
      shipping: z.string().optional(),
      cancellation: z.string().optional(),
      returns: z.string().optional(),
      contact: z.string().optional(),
    })
    .optional(),
  locale: z.enum(["en", "es"]).default("en"),
  /** Merchant policy over agentic sales (M1). Omitted means: sell everything, no limits. */
  policy: merchantPolicySchema.default(OPEN_POLICY),
  /**
   * Know Your Agent (M3). `open`: anyone buys. `identified`: identity optional but verified and
   * recorded when sent. `verified-only`: only agents with a valid owner attestation.
   */
  identity: z
    .object({
      mode: z.enum(IDENTITY_MODES).default("open"),
      /** Register an agent the first time it presents a valid attestation. */
      autoRegister: z.boolean().default(true),
    })
    .default({ mode: "open", autoRegister: true }),
  /** Human approval queue (M2) for orders the policy flags. */
  approvals: z
    .object({
      /** When false, flagged orders are simply refused instead of queued. */
      enabled: z.boolean().default(true),
      /** Minutes the merchant has to decide. Silence rejects; it never approves. */
      ttlMinutes: z.number().int().min(1).max(1440).default(30),
      /** Signed POST with the approval details (secret in AGENTGATE_APPROVAL_WEBHOOK_SECRET). */
      webhookUrl: z.url().optional(),
      /** WhatsApp via Twilio (credentials in AGENTGATE_TWILIO_*). */
      whatsapp: z.object({ from: z.string().min(1), to: z.string().min(1) }).optional(),
    })
    .default({ enabled: true, ttlMinutes: 30 }),
  /**
   * Signed audit chain (M4). On by default: a store that keeps no evidence of its own sales has
   * nothing to show when one is disputed.
   */
  receipts: z
    .object({
      enabled: z.boolean().default(true),
      /** Serve each order's receipt at /agentgate/orders/:id/receipt so the buyer can keep it. */
      publicOrderReceipts: z.boolean().default(true),
    })
    .default({ enabled: true, publicOrderReceipts: true }),
  /** G1: per-minute limits. Agents burst, so allow a small burst on top of the sustained rate. */
  rateLimit: z
    .object({
      cartPerMinutePerIp: z.number().int().min(1).default(60),
      checkoutPerMinutePerIp: z.number().int().min(1).default(60),
      checkoutAttemptsPerCart: z.number().int().min(1).default(10),
      burst: z.number().int().min(0).default(20),
    })
    .default({
      cartPerMinutePerIp: 60,
      checkoutPerMinutePerIp: 60,
      checkoutAttemptsPerCart: 10,
      burst: 20,
    }),
});

export type SiteConfigInput = z.input<typeof siteConfigSchema>;
export type SiteConfig = z.output<typeof siteConfigSchema>;

export interface SiteSecrets {
  wooConsumerKey: string | undefined;
  wooConsumerSecret: string | undefined;
  /** Optional URL that receives critical alerts as JSON POSTs (G1 operations). */
  alertWebhookUrl: string | undefined;
  /** Shared secret the merchant signs approvals with (M2). Without it, resolutions are refused. */
  approvalSecret: string | undefined;
  approvalWebhookSecret: string | undefined;
  /** Optional: the store's receipt signing key. Generated in the data dir when unset. */
  receiptSecret: string | undefined;
  twilioAccountSid: string | undefined;
  twilioAuthToken: string | undefined;
}

export function parseSiteConfig(input: unknown): SiteConfig {
  // Zero custody at startup (G1): refuse any configuration that carries a secret seed.
  assertNoSecretsInConfig(input, SITE_CONFIG_FILE);
  const parsed = siteConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new AgentGateError("CONFIG_INVALID", `Invalid ${SITE_CONFIG_FILE}`, {
      hint: "Run `npx agentgate init` again or fix the fields listed in details.",
      details: { issues: parsed.error.issues },
    });
  }
  if (parsed.data.platform === "woocommerce" && !parsed.data.woocommerce) {
    throw new AgentGateError(
      "CONFIG_INVALID",
      "platform is woocommerce but woocommerce.baseUrl is missing",
      {
        hint: `Add "woocommerce": { "baseUrl": "https://your-store" } to ${SITE_CONFIG_FILE}.`,
      },
    );
  }
  return parsed.data;
}

export function loadSiteConfig(cwd: string = process.cwd()): SiteConfig {
  const file = resolve(cwd, SITE_CONFIG_FILE);
  if (!existsSync(file)) {
    throw new AgentGateError("CONFIG_INVALID", `${SITE_CONFIG_FILE} not found in ${cwd}`, {
      hint: "Run `npx agentgate init` in the directory where the sidecar will run.",
    });
  }
  return parseSiteConfig(JSON.parse(readFileSync(file, "utf8")));
}

export function secretsFromEnv(env: Record<string, string | undefined> = process.env): SiteSecrets {
  return {
    wooConsumerKey: env.AGENTGATE_WOO_CONSUMER_KEY,
    wooConsumerSecret: env.AGENTGATE_WOO_CONSUMER_SECRET,
    alertWebhookUrl: env.AGENTGATE_ALERT_WEBHOOK,
    approvalSecret: env.AGENTGATE_APPROVAL_SECRET,
    approvalWebhookSecret: env.AGENTGATE_APPROVAL_WEBHOOK_SECRET,
    receiptSecret: env.AGENTGATE_RECEIPT_SECRET,
    twilioAccountSid: env.AGENTGATE_TWILIO_ACCOUNT_SID,
    twilioAuthToken: env.AGENTGATE_TWILIO_AUTH_TOKEN,
  };
}

export function coreConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): CoreConfig {
  return configFromEnv(env);
}
