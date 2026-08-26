/**
 * `npx agentgate` (SPEC 01): init | scan | confirm | publish | status | serve.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  AgentGateError,
  formatUsdc,
  usdc,
  createLlm,
  validateAcpProductsResponse,
  validateUcpBusinessProfile,
} from "@agentgate/core";
import type { CatalogItemDraft, LlmProvider } from "@agentgate/core";
import { scanSite } from "@agentgate/scanner";
import { createAgentGate, buildConnector } from "./index.js";
import { SITE_CONFIG_FILE, coreConfigFromEnv, loadSiteConfig, secretsFromEnv } from "./config.js";
import type { SiteConfigInput } from "./config.js";
import { generateAndStoreKeypair } from "./keys.js";
import { CatalogService } from "./catalog.js";
import { SiteStorage } from "./storage.js";

function loadDotEnv(cwd: string): void {
  const file = resolve(cwd, ".env");
  if (!existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch {
    /* ignore */
  }
}

function die(err: unknown): never {
  if (err instanceof AgentGateError) {
    console.error(pc.red(`\n${err.code}: ${err.message}`));
    console.error(pc.dim(`hint: ${err.hint}`));
    if (err.details) console.error(pc.dim(JSON.stringify(err.details, null, 2)));
  } else {
    console.error(pc.red(String(err)));
  }
  process.exit(1);
}

function ensureEnvLine(cwd: string, key: string, value = ""): void {
  const file = resolve(cwd, ".env");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (new RegExp(`^${key}=`, "m").test(current)) return;
  appendFileSync(file, `${current.endsWith("\n") || current === "" ? "" : "\n"}${key}=${value}\n`);
}

const program = new Command();
program
  .name("agentgate")
  .description("Turn your site into an agent-buyable store (x402 on Stellar).")
  .version("0.0.1");
program.option("-C, --cwd <dir>", "working directory", process.cwd());

// ---------------------------------------------------------------------------
program
  .command("init")
  .description("Create agentgate.config.json interactively")
  .option("--generate-wallet", "generate a local keypair instead of linking an existing wallet")
  .action(async (opts: { generateWallet?: boolean }) => {
    const cwd = program.opts<{ cwd: string }>().cwd;
    p.intro(pc.bold("AgentGate init"));
    if (existsSync(resolve(cwd, SITE_CONFIG_FILE))) {
      const overwrite = await p.confirm({
        message: `${SITE_CONFIG_FILE} exists. Overwrite?`,
        initialValue: false,
      });
      if (overwrite !== true) return p.cancel("kept existing config");
    }
    const siteUrl = await p.text({
      message: "Public URL of your site",
      placeholder: "https://shop.example",
      validate: (v) => (/^https?:\/\//.test(v ?? "") ? undefined : "must start with http(s)://"),
    });
    if (p.isCancel(siteUrl)) return p.cancel();
    const displayName = await p.text({
      message: "Store name (shown to agents)",
      validate: (v) => (v ? undefined : "required"),
    });
    if (p.isCancel(displayName)) return p.cancel();
    const platform = await p.select({
      message: "Where do orders live?",
      options: [
        { value: "woocommerce", label: "WooCommerce (REST API)" },
        { value: "generic", label: "Custom stack (I will implement createOrder hooks)" },
        { value: "none", label: "None yet (orders recorded locally only)" },
      ],
    });
    if (p.isCancel(platform)) return p.cancel();

    let woocommerce: SiteConfigInput["woocommerce"];
    if (platform === "woocommerce") {
      const baseUrl = await p.text({
        message: "WooCommerce store URL (https)",
        initialValue: siteUrl,
      });
      if (p.isCancel(baseUrl)) return p.cancel();
      const insecure = baseUrl.startsWith("http://")
        ? await p.confirm({
            message: "Plain http detected. Allow it? (local demo stores only)",
            initialValue: false,
          })
        : false;
      woocommerce = { baseUrl, allowInsecureHttp: insecure === true };
      p.note(
        "Create a Read/Write key in WooCommerce > Settings > Advanced > REST API and put it in .env:\n  AGENTGATE_WOO_CONSUMER_KEY=ck_...\n  AGENTGATE_WOO_CONSUMER_SECRET=cs_...",
        "WooCommerce credentials",
      );
    }

    let payTo: string;
    if (opts.generateWallet) {
      const passphrase = await p.password({
        message: "Passphrase to encrypt the new keypair (you will need it to withdraw)",
      });
      if (p.isCancel(passphrase)) return p.cancel();
      const name = new URL(siteUrl).hostname.replace(/[^a-z0-9.-]/gi, "_");
      const { publicKey, path } = generateAndStoreKeypair(name, passphrase);
      payTo = publicKey;
      p.note(
        `Public key: ${publicKey}\nEncrypted secret: ${path}\nThis key never leaves this machine. Prefer linking a wallet you already control.`,
        "Wallet generated",
      );
    } else {
      const addr = await p.text({
        message: "Stellar address that receives payments (your wallet, G... or C...)",
        validate: (v) =>
          /^[GC][A-Z2-7]{55}$/.test(v ?? "") ? undefined : "invalid Stellar address",
      });
      if (p.isCancel(addr)) return p.cancel();
      payTo = addr;
    }

    const config: SiteConfigInput = {
      siteUrl,
      displayName,
      payTo,
      platform: platform as SiteConfigInput["platform"],
      ...(woocommerce ? { woocommerce } : {}),
    };
    writeFileSync(resolve(cwd, SITE_CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
    ensureEnvLine(cwd, "AGENTGATE_NETWORK", "testnet");
    ensureEnvLine(cwd, "AGENTGATE_FACILITATOR_API_KEY");
    if (platform === "woocommerce") {
      ensureEnvLine(cwd, "AGENTGATE_WOO_CONSUMER_KEY");
      ensureEnvLine(cwd, "AGENTGATE_WOO_CONSUMER_SECRET");
    }
    p.note(
      "1. Get a free facilitator API key (testnet): https://channels.openzeppelin.com/testnet/gen\n   and set AGENTGATE_FACILITATOR_API_KEY in .env\n2. npx agentgate scan\n3. npx agentgate confirm\n4. npx agentgate publish\n5. npx agentgate serve",
      "Next steps",
    );
    p.outro(`wrote ${SITE_CONFIG_FILE}`);
  });

// ---------------------------------------------------------------------------
program
  .command("scan")
  .description("Read your site and propose a catalog draft (nothing is published)")
  .option("--max-pages <n>", "max product pages to fetch", "200")
  .option("--no-llm", "skip LLM redaction even if a key is configured")
  .action(async (opts: { maxPages: string; llm: boolean }) => {
    const cwd = program.opts<{ cwd: string }>().cwd;
    loadDotEnv(cwd);
    try {
      const site = loadSiteConfig(cwd);
      const core = coreConfigFromEnv();
      const connector = buildConnector(site, secretsFromEnv());
      let llm: LlmProvider | undefined;
      if (opts.llm && core.llm.apiKey) llm = createLlm(core.llm);
      const s = p.spinner();
      s.start(`scanning ${site.siteUrl}`);
      const result = await scanSite({
        baseUrl: site.siteUrl,
        connector,
        ...(llm ? { llm } : {}),
        maxPages: Number(opts.maxPages),
        onProgress: (m) => s.message(m),
      });
      s.stop(`found ${result.drafts.length} items`);
      const storage = new SiteStorage(resolve(cwd, site.dataDir, "agentgate.sqlite"));
      storage.replaceDrafts(result.drafts);
      writeFileSync(
        resolve(cwd, site.dataDir, "catalog.draft.json"),
        JSON.stringify(result.drafts, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
      );
      storage.close();
      console.log(pc.dim(JSON.stringify(result.stats)));
      console.log("");
      for (const d of result.drafts) {
        const price = d.priceSrc ? `${d.priceSrc.amount} ${d.priceSrc.currency}` : "no price";
        const sugg =
          d.priceUsdcSuggested !== undefined
            ? pc.green(`-> ${formatUsdc(d.priceUsdcSuggested)} USDC`)
            : pc.yellow("-> set price");
        console.log(
          `${pc.bold(d.id.padEnd(40))} ${d.title.slice(0, 40).padEnd(42)} ${price.padEnd(14)} ${sugg}  ${pc.dim(`conf ${d.confidence}`)}`,
        );
      }
      console.log(
        `\n${pc.dim("This is what I understood. Nothing is published yet.")} Next: ${pc.bold("npx agentgate confirm")}`,
      );
    } catch (err) {
      die(err);
    }
  });

// ---------------------------------------------------------------------------
program
  .command("confirm")
  .description("Review each draft item and set its price (you decide, every time)")
  .option("--all", "accept every draft that has a suggested price, non-interactively")
  .action(async (opts: { all?: boolean }) => {
    const cwd = program.opts<{ cwd: string }>().cwd;
    loadDotEnv(cwd);
    try {
      const site = loadSiteConfig(cwd);
      const storage = new SiteStorage(resolve(cwd, site.dataDir, "agentgate.sqlite"));
      const catalog = new CatalogService(storage);
      const drafts = storage.listDrafts();
      if (drafts.length === 0) {
        console.log("no drafts. Run `npx agentgate scan` first.");
        return;
      }
      let confirmed = 0;
      if (opts.all) {
        for (const d of drafts) {
          if (d.priceUsdcSuggested === undefined) {
            console.log(
              pc.yellow(`skip ${d.id}: no suggested price (run interactively to set one)`),
            );
            continue;
          }
          catalog.confirm(d, d.priceUsdcSuggested);
          confirmed += 1;
        }
      } else {
        p.intro(pc.bold(`Confirm ${drafts.length} items`));
        for (const d of drafts) {
          const decision = await reviewDraft(d);
          if (decision === "cancel") break;
          if (decision === "skip") continue;
          catalog.confirm(d, decision.price, { descriptionAgent: decision.description });
          confirmed += 1;
        }
        p.outro(`${confirmed} confirmed`);
      }
      storage.close();
      console.log(`${confirmed} items confirmed. Next: ${pc.bold("npx agentgate publish")}`);
    } catch (err) {
      die(err);
    }
  });

async function reviewDraft(
  d: CatalogItemDraft,
): Promise<"skip" | "cancel" | { price: ReturnType<typeof usdc>; description: string }> {
  p.note(
    `${d.title}\n${d.descriptionAgent || "(no description)"}\nsource price: ${d.priceSrc ? `${d.priceSrc.amount} ${d.priceSrc.currency}` : "none"}\nattributes: ${JSON.stringify(d.attributes)}\nevidence: ${d.sourceEvidence.map((e) => e.source).join(", ")}`,
    d.id,
  );
  const action = await p.select({
    message: "Sell this item to agents?",
    options: [
      { value: "yes", label: "Yes" },
      { value: "skip", label: "Skip for now" },
      { value: "stop", label: "Stop" },
    ],
  });
  if (p.isCancel(action) || action === "stop") return "cancel";
  if (action === "skip") return "skip";
  const price = await p.text({
    message: "Price in USDC",
    initialValue: d.priceUsdcSuggested !== undefined ? formatUsdc(d.priceUsdcSuggested) : "",
    validate: (v) => {
      try {
        usdc(v ?? "");
        return undefined;
      } catch {
        return "decimal number, up to 7 decimals";
      }
    },
  });
  if (p.isCancel(price)) return "cancel";
  const description = await p.text({
    message: "Description for agents (facts only)",
    initialValue: d.descriptionAgent,
  });
  if (p.isCancel(description)) return "cancel";
  return { price: usdc(price), description };
}

// ---------------------------------------------------------------------------
program
  .command("publish")
  .description("Publish confirmed items and verify the payment rail")
  .action(async () => {
    const cwd = program.opts<{ cwd: string }>().cwd;
    loadDotEnv(cwd);
    try {
      loadSiteConfig(cwd);
      const core = coreConfigFromEnv();
      if (core.facilitatorApiKeys.length === 0) {
        throw new AgentGateError("CONFIG_INVALID", "AGENTGATE_FACILITATOR_API_KEY is not set", {
          hint: "Generate one at https://channels.openzeppelin.com/testnet/gen and add it to .env",
        });
      }
      const res = await fetch(`${core.facilitatorUrl}/supported`, {
        headers: { authorization: `Bearer ${core.facilitatorApiKeys[0]}` },
      });
      if (!res.ok)
        throw new AgentGateError("PAYMENT_REJECTED", `Facilitator answered ${res.status}`, {
          hint: "Check the API key matches the network (testnet vs mainnet).",
        });
      const gate = await createAgentGate({ cwd });
      // Conformance gate: the discovery surfaces must validate against the pinned official schemas.
      const profile = await (
        await gate.fetch(new Request(`${gate.site.siteUrl}/.well-known/ucp`))
      ).json();
      const ucpCheck = validateUcpBusinessProfile(profile);
      const feed = await (
        await gate.fetch(new Request(`${gate.site.siteUrl}${gate.site.basePath}/feed`))
      ).json();
      const acpCheck = validateAcpProductsResponse(feed);
      if (!ucpCheck.valid || !acpCheck.valid) {
        throw new AgentGateError(
          "SPEC_MISMATCH",
          "Discovery surfaces do not validate against the pinned schemas",
          {
            hint: "This is a bug in AgentGate, not in your data. Please report it with the details below.",
            details: { ucp: ucpCheck.errors, acp: acpCheck.errors },
          },
        );
      }
      const published = gate.catalog.publishAll();
      gate.storage.setMeta("publishedAt", new Date().toISOString());
      console.log(
        pc.green(`${published.length} items published on ${core.caip2} (${core.checkoutAsset})`),
      );
      console.log("Surfaces (once `agentgate serve` runs behind your domain):");
      for (const [k, v] of Object.entries(gate.routes)) console.log(`  ${k.padEnd(9)} ${v}`);
      gate.storage.close();
    } catch (err) {
      die(err);
    }
  });

// ---------------------------------------------------------------------------
program
  .command("status")
  .description("Items, recent orders and connector errors")
  .option("--retry", "retry platform order creation for paid orders that failed")
  .action(async (opts: { retry?: boolean }) => {
    const cwd = program.opts<{ cwd: string }>().cwd;
    loadDotEnv(cwd);
    try {
      const gate = await createAgentGate({ cwd });
      const items = gate.storage.listItems();
      const count = (s: string) => items.filter((i) => i.status === s).length;
      console.log(
        `items: ${count("published")} published, ${count("confirmed")} confirmed, ${gate.storage.listDrafts().length} drafts`,
      );
      const orders = gate.storage.listOrders({ limit: 20 });
      if (orders.length === 0) console.log("orders: none yet");
      for (const o of orders) {
        const flag = o.connectorError
          ? pc.red(
              ` connector error: ${o.connectorError.code} (${o.connectorError.attempts} attempts)`,
            )
          : "";
        console.log(
          `${o.createdAt}  ${o.id}  ${o.status.padEnd(15)} ${formatUsdc(o.quote.totalUsdc).padStart(10)} ${gate.core.checkoutAsset}  tx=${o.payment?.txHash ?? "-"}  ext=${o.externalOrderId ?? "-"}${flag}`,
        );
        if (opts.retry && o.connectorError) {
          const r = await gate.checkout.retryConnector(o.id);
          console.log(
            r.externalOrderId
              ? pc.green(`  retried -> ${r.externalOrderId}`)
              : pc.red(`  retry failed: ${r.connectorError?.message}`),
          );
        }
      }
      gate.storage.close();
    } catch (err) {
      die(err);
    }
  });

// ---------------------------------------------------------------------------
program
  .command("serve")
  .description("Run the sidecar HTTP server")
  .option("-p, --port <port>", "port", "8402")
  .option("-H, --host <host>", "bind address", "0.0.0.0")
  .action(async (opts: { port: string; host: string }) => {
    const cwd = program.opts<{ cwd: string }>().cwd;
    loadDotEnv(cwd);
    try {
      const gate = await createAgentGate({
        cwd,
        log: (m) => console.log(pc.dim(`[agentgate] ${m}`)),
      });
      const { port } = await gate.serve(Number(opts.port), opts.host);
      console.log(
        pc.green(
          `AgentGate sidecar for ${gate.site.displayName} on http://${opts.host}:${port}${gate.site.basePath}`,
        ),
      );
      console.log(
        `network ${gate.core.caip2}, asset ${gate.core.checkoutAsset}, payTo ${gate.site.payTo}`,
      );
      console.log(
        pc.dim(
          "Reverse-proxy these paths from your domain: /.well-known/ucp and " +
            gate.site.basePath +
            "/*",
        ),
      );
    } catch (err) {
      die(err);
    }
  });

program.parseAsync(process.argv).catch(die);
