/**
 * @agentgate/site public API.
 *
 *   import { createAgentGate } from "@agentgate/site";
 *   const gate = await createAgentGate({ cwd: process.cwd() });   // reads agentgate.config.json + env
 *   gate.serve(8402);                                              // sidecar
 *   // or mount: app.all("/agentgate/*", (req) => gate.fetch(req)) with a fetch-compatible framework
 */
import { serve as honoServe } from "@hono/node-server";
import { GenericConnector, WooCommerceConnector } from "@agentgate/connectors";
import type { GenericConnectorHooks } from "@agentgate/connectors";
import type { CoreConfig, FacilitatorClient, OrderConnector } from "@agentgate/core";
import { AgentGateError } from "@agentgate/core";
import { createAgentGateApp } from "./app.js";
import type { AgentGateSite } from "./app.js";
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
export { createAgentGateApp, cartView, orderView } from "./app.js";
export type { AgentGateDeps, AgentGateSite } from "./app.js";
export { buildMcpServer, createMcpHandler } from "./mcp.js";
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
  log?: (message: string) => void;
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

export interface AgentGate extends AgentGateSite {
  site: SiteConfig;
  core: CoreConfig;
  connector: OrderConnector;
  /** Starts the sidecar. Port 0 picks a free port; the resolved port is returned. */
  serve(port?: number, hostname?: string): Promise<{ port: number; close: () => void }>;
}

export async function createAgentGate(options: CreateAgentGateOptions = {}): Promise<AgentGate> {
  const site = options.site ? parseSiteConfig(options.site) : loadSiteConfig(options.cwd);
  const core = options.core ?? coreConfigFromEnv();
  const secrets = options.secrets ?? secretsFromEnv();
  const connector = options.connector ?? buildConnector(site, secrets, options.hooks);
  const storage =
    options.storage ??
    new SiteStorage(`${options.cwd ?? process.cwd()}/${site.dataDir}/agentgate.sqlite`);
  const built = createAgentGateApp({
    site,
    core,
    connector,
    storage,
    ...(options.facilitator ? { facilitator: options.facilitator } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  return {
    ...built,
    site,
    core,
    connector,
    serve(port = 8402, hostname = "0.0.0.0") {
      return new Promise((resolvePort) => {
        const server = honoServe({ fetch: built.app.fetch, port, hostname }, (info) => {
          resolvePort({ port: info.port, close: () => server.close() });
        });
      });
    },
  };
}
