/**
 * @agentgate/site public API.
 *
 *   import { createAgentGate } from "@agentgate/site";
 *   const gate = await createAgentGate({ cwd: process.cwd() });   // reads agentgate.config.json + env
 *   await gate.serve(8402);                                        // sidecar (+ retry worker)
 *   // or mount: app.all("/agentgate/*", (req) => gate.fetch(req)) with a fetch-compatible framework
 */
import { serve as honoServe } from "@hono/node-server";
import { GenericConnector, WooCommerceConnector } from "@agentgate/connectors";
import type { GenericConnectorHooks } from "@agentgate/connectors";
import type { CoreConfig, FacilitatorClient, Logger, OrderConnector } from "@agentgate/core";
import { AgentGateError, createLogger } from "@agentgate/core";
import { ApprovalService, TwilioWhatsAppChannel, WebhookChannel } from "@agentgate/approvals";
import type { NotificationChannel } from "@agentgate/approvals";
import { createAgentGateApp } from "./app.js";
import type { AgentGateSite } from "./app.js";
import type { AlertEvent, AlertSink } from "./checkout.js";
import { coreConfigFromEnv, loadSiteConfig, parseSiteConfig, secretsFromEnv } from "./config.js";
import type { SiteConfig, SiteConfigInput, SiteSecrets } from "./config.js";
import { SiteStorage } from "./storage.js";

export type { SiteConfig, SiteConfigInput, SiteSecrets } from "./config.js";
export {
  loadSiteConfig,
  parseSiteConfig,
  secretsFromEnv,
  siteConfigSchema,
  SITE_CONFIG_FILE,
} from "./config.js";
export { SiteStorage } from "./storage.js";
export { CatalogService } from "./catalog.js";
export { CheckoutService } from "./checkout.js";
export type { AlertEvent, AlertSink, SettledTerms } from "./checkout.js";
export { createAgentGateApp, cartView, orderView } from "./app.js";
export type { AgentGateDeps, AgentGateSite } from "./app.js";
export { buildMcpServer, createMcpHandler } from "./mcp.js";
export { TokenBucketLimiter } from "./ratelimit.js";
export type { GateForPaymentResult } from "./checkout.js";
export { generateAndStoreKeypair, loadKeypair, keysDir } from "./keys.js";

export interface CreateAgentGateOptions {
  /** Directory holding agentgate.config.json and the data dir. Ignored when `site` is given. */
  cwd?: string;
  site?: SiteConfigInput;
  core?: CoreConfig;
  secrets?: SiteSecrets;
  /** Custom-stack hooks (platform: generic). */
  hooks?: GenericConnectorHooks;
  connector?: OrderConnector;
  storage?: SiteStorage;
  facilitator?: FacilitatorClient;
  logger?: Logger;
  alert?: AlertSink;
  /** Human approval queue (M2); built from config when omitted. */
  approvals?: ApprovalService;
  /** Extra notification channels (e.g. EmailChannel with the merchant's own transport). */
  approvalChannels?: NotificationChannel[];
  /** Retry loop interval for paid orders without a platform order (default 30s). */
  retryIntervalMs?: number;
}

export function buildConnector(
  site: SiteConfig,
  secrets: SiteSecrets,
  hooks?: GenericConnectorHooks,
): OrderConnector {
  if (site.platform === "woocommerce") {
    const woo = site.woocommerce as NonNullable<SiteConfig["woocommerce"]>;
    if (!secrets.wooConsumerKey || !secrets.wooConsumerSecret) {
      throw new AgentGateError("CONFIG_INVALID", "WooCommerce credentials missing", {
        hint: "Set AGENTGATE_WOO_CONSUMER_KEY and AGENTGATE_WOO_CONSUMER_SECRET (WooCommerce > Settings > Advanced > REST API, Read/Write).",
      });
    }
    return new WooCommerceConnector({
      baseUrl: woo.baseUrl,
      consumerKey: secrets.wooConsumerKey,
      consumerSecret: secrets.wooConsumerSecret,
      allowInsecureHttp: woo.allowInsecureHttp,
    });
  }
  if (site.platform === "generic") {
    if (!hooks) {
      throw new AgentGateError("CONFIG_INVALID", "platform 'generic' requires hooks", {
        hint: "Pass hooks: { createOrder(...) } to createAgentGate (see docs/quickstart).",
      });
    }
    return new GenericConnector(hooks);
  }
  // platform: none -> orders are recorded locally only; the merchant reads them via `agentgate status`.
  return new GenericConnector({
    createOrder: async (input) => ({ externalOrderId: `local:${input.orderId}` }),
  });
}

/**
 * Notification channels for the approval queue (M2), built from config plus environment
 * secrets. Email is intentionally absent here: it needs a transport the merchant owns, so it is
 * wired programmatically via `EmailChannel` (see the package README).
 */
export function buildApprovalChannels(
  site: SiteConfig,
  secrets: SiteSecrets,
): NotificationChannel[] {
  const channels: NotificationChannel[] = [];
  if (site.approvals.webhookUrl) {
    channels.push(
      new WebhookChannel({ url: site.approvals.webhookUrl, secret: secrets.approvalWebhookSecret }),
    );
  }
  if (site.approvals.whatsapp && secrets.twilioAccountSid && secrets.twilioAuthToken) {
    channels.push(
      new TwilioWhatsAppChannel({
        accountSid: secrets.twilioAccountSid,
        authToken: secrets.twilioAuthToken,
        from: site.approvals.whatsapp.from,
        to: site.approvals.whatsapp.to,
      }),
    );
  }
  return channels;
}

/** Alert sink: structured log line plus an optional JSON webhook (G1 operations). */
export function buildAlertSink(
  logger: Logger,
  webhookUrl?: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): AlertSink {
  return async (event: AlertEvent) => {
    logger.error("alert", { ...event });
    if (!webhookUrl) return;
    await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "agentgate", ...event }),
      signal: AbortSignal.timeout(10_000),
    }).catch((err: unknown) =>
      logger.warn("alert.webhook_failed", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  };
}

export interface AgentGate extends AgentGateSite {
  site: SiteConfig;
  core: CoreConfig;
  connector: OrderConnector;
  /** Starts the sidecar and the retry worker. Port 0 picks a free port; the resolved port is returned. */
  serve(port?: number, hostname?: string): Promise<{ port: number; close: () => void }>;
  /** Runs one pass of the persistent retry loop (also used by `agentgate status --retry`). */
  retryPending(): Promise<number>;
}

export async function createAgentGate(options: CreateAgentGateOptions = {}): Promise<AgentGate> {
  const site = options.site ? parseSiteConfig(options.site) : loadSiteConfig(options.cwd);
  const core = options.core ?? coreConfigFromEnv();
  const secrets = options.secrets ?? secretsFromEnv();
  const logger =
    options.logger ??
    createLogger({
      format: process.env.AGENTGATE_LOG_FORMAT === "pretty" ? "pretty" : "json",
      base: { site: site.displayName },
    });
  const connector = options.connector ?? buildConnector(site, secrets, options.hooks);
  const storage =
    options.storage ??
    new SiteStorage(`${options.cwd ?? process.cwd()}/${site.dataDir}/agentgate.sqlite`);
  const alert = options.alert ?? buildAlertSink(logger, secrets.alertWebhookUrl);
  const siteUrl = site.siteUrl.replace(/\/+$/, "");
  const approvals =
    options.approvals ??
    (site.approvals.enabled
      ? new ApprovalService({
          store: storage.approvalStore(),
          ttlMinutes: site.approvals.ttlMinutes,
          channels: options.approvalChannels ?? buildApprovalChannels(site, secrets),
          links: (r) => ({
            poll: `${siteUrl}${site.basePath}/approvals/${r.id}`,
            resolve: `${siteUrl}${site.basePath}/approvals/${r.id}/resolve`,
          }),
          logger,
        })
      : undefined);
  const built = createAgentGateApp({
    site,
    core,
    connector,
    storage,
    logger,
    alert,
    ...(approvals ? { approvals } : {}),
    approvalSecret: secrets.approvalSecret,
    ...(options.facilitator ? { facilitator: options.facilitator } : {}),
  });
  const retryPending = async (): Promise<number> => {
    const retried = await built.checkout.retryPending();
    return retried.filter((o) => o.externalOrderId).length;
  };
  return {
    ...built,
    site,
    core,
    connector,
    retryPending,
    serve(port = 8402, hostname = "0.0.0.0") {
      return new Promise((resolvePort) => {
        const server = honoServe({ fetch: built.app.fetch, port, hostname }, (info) => {
          const timer = setInterval(() => {
            retryPending().catch((err: unknown) =>
              logger.error("retry.loop_failed", {
                error: err instanceof Error ? err.message : String(err),
              }),
            );
            // Silence never approves: expire overdue requests even with no traffic (M2).
            try {
              approvals?.expirePending();
            } catch (err) {
              logger.error("approval.sweep_failed", {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }, options.retryIntervalMs ?? 30_000);
          timer.unref();
          logger.info("sidecar.started", {
            port: info.port,
            network: core.caip2,
            asset: core.checkoutAsset,
          });
          resolvePort({
            port: info.port,
            close: () => {
              clearInterval(timer);
              server.close();
            },
          });
        });
      });
    },
  };
}
