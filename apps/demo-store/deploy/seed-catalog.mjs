/**
 * One-shot catalog seeding for the deployed demo store (and any turnkey lighthouse setup):
 * scan the WooCommerce store through the connector, confirm prices, publish.
 *
 * Runs INSIDE the sidecar container against its own /data dir, so the sidecar that serves
 * traffic sees exactly what this published:
 *
 *   docker compose -f docker-compose.prod.yml run --rm --no-deps \
 *     --entrypoint node demo-sidecar /app/packages/site/seed-catalog.mjs
 *
 * Prices: the scanner suggests USDC from the store's fiat prices; PRICE_OVERRIDES_USDC (JSON,
 * e.g. '{"AG-STICKERS":"1.5"}') pins specific SKUs. The human confirmation the guardrail
 * requires is the operator running this script with those numbers: nothing publishes without it.
 */
import { readFileSync } from "node:fs";
import { createAgentPOS, loadSiteConfig, SiteStorage } from "@agentpos/site";
import { WooCommerceConnector } from "@agentpos/connectors";
import { scanSite } from "@agentpos/scanner";
import { createLogger, usdc } from "@agentpos/core";

const cwd = process.env.AGENTPOS_DATA_DIR ?? "/data";
process.chdir(cwd);
const site = loadSiteConfig(cwd);
const woo = site.woocommerce;
if (!woo) throw new Error("agentpos.config.json must set platform woocommerce + baseUrl");

const overrides = JSON.parse(process.env.PRICE_OVERRIDES_USDC ?? "{}");
const logger = createLogger({ format: "pretty" });

const connector = new WooCommerceConnector({
  baseUrl: woo.baseUrl,
  consumerKey: process.env.AGENTPOS_WOO_CONSUMER_KEY ?? "",
  consumerSecret: process.env.AGENTPOS_WOO_CONSUMER_SECRET ?? "",
  allowInsecureHttp: woo.allowInsecureHttp,
});

const storage = new SiteStorage(`${site.dataDir}/agentpos.sqlite`);
const gate = await createAgentPOS({ site, connector, storage, logger });

const scan = await scanSite({
  baseUrl: woo.baseUrl,
  connector,
  fetcher: { minIntervalMs: 0 },
  maxPages: 30,
});
console.log(`scan: ${scan.drafts.length} drafts`, scan.stats);
storage.replaceDrafts(scan.drafts);

const confirmedIds = new Set();
for (const draft of scan.drafts) {
  const sku = draft.attributes?.sku ?? draft.externalId ?? draft.id;
  const price =
    overrides[sku] !== undefined ? usdc(String(overrides[sku])) : draft.priceUsdcSuggested;
  if (price === undefined) {
    console.log(`skip ${draft.id}: no price suggestion and no override`);
    continue;
  }
  confirmedIds.add(gate.catalog.confirm(draft, price).id);
}
let published = gate.catalog.publishAll();
// Renamed/removed source products leave stale published items behind (item id is the title
// slug). Unpublish anything this run did not confirm; orders keep their own copies, so
// history is untouched.
for (const item of published) {
  if (!confirmedIds.has(item.id)) {
    gate.catalog.unpublish(item.id);
    storage.setItemStatus(item.id, "draft");
    console.log(`unpublished stale ${item.id} (${item.title})`);
  }
}
published = published.filter((i) => confirmedIds.has(i.id));
console.log(`confirmed ${confirmedIds.size}, published ${published.length}:`);
for (const item of published) console.log(`  ${item.id}  ${item.title}`);
storage.close();
if (published.length === 0) process.exit(1);
