/**
 * `agentpos-buyer`: the HUMAN side of the mandate. init | approve | pending | log | sites | serve.
 */
import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  AgentPOSError,
  FRIENDBOT_URL,
  formatUsdc,
  generateAndStoreKeypair,
} from "@agentpos/core";
import { approve, listPending, loadProfile, saveProfile } from "./profile.js";
import type { Profile } from "./profile.js";
import { mandateSchema } from "./mandate.js";
import { buildBuyerServer } from "./server.js";
import { BuyerService } from "./buyer.js";
import { runDemoPurchase } from "./demo.js";
import { SpendingLog } from "./spending.js";

function die(err: unknown): never {
  if (err instanceof AgentPOSError) {
    console.error(pc.red(`\n${err.code}: ${err.message}`));
    console.error(pc.dim(`hint: ${err.hint}`));
  } else console.error(pc.red(String(err)));
  process.exit(1);
}

const program = new Command();
program
  .name("agentpos-buyer")
  .description("Human side of the AgentPOS buyer mandate.")
  .version("0.0.1");
program.option("-p, --profile <name>", "profile name", "default");

program
  .command("init")
  .description("Create a buyer profile: encrypted spending wallet + mandate")
  .option("--network <net>", "testnet | mainnet", "testnet")
  .action(async (opts: { network: "testnet" | "mainnet" }) => {
    const name = program.opts<{ profile: string }>().profile;
    p.intro(pc.bold(`AgentPOS buyer profile "${name}"`));
    const passphrase = await p.password({
      message:
        "Passphrase to encrypt the spending wallet (you will set AGENTPOS_BUYER_PASSPHRASE for the MCP server)",
    });
    if (p.isCancel(passphrase)) return p.cancel();
    const maxPerTx = await p.text({ message: "Max per payment (USDC)", initialValue: "10" });
    if (p.isCancel(maxPerTx)) return p.cancel();
    const maxTotal = await p.text({ message: "Max per day (USDC)", initialValue: "50" });
    if (p.isCancel(maxTotal)) return p.cancel();
    const confirmAbove = await p.text({
      message: "Ask me before paying more than (USDC, empty = never)",
      initialValue: "",
    });
    if (p.isCancel(confirmAbove)) return p.cancel();
    const physical = await p.confirm({
      message: "Allow physical goods (uses a locked shipping address)?",
      initialValue: true,
    });
    if (p.isCancel(physical)) return p.cancel();
    let shipping: Profile["shipping"];
    let buyer: Profile["buyer"];
    if (physical) {
      const email = await p.text({ message: "Email for order updates" });
      if (p.isCancel(email)) return p.cancel();
      const nm = await p.text({ message: "Recipient name" });
      if (p.isCancel(nm)) return p.cancel();
      const line1 = await p.text({ message: "Address line 1" });
      if (p.isCancel(line1)) return p.cancel();
      const city = await p.text({ message: "City" });
      if (p.isCancel(city)) return p.cancel();
      const postalCode = await p.text({ message: "Postal code" });
      if (p.isCancel(postalCode)) return p.cancel();
      const country = await p.text({ message: "Country (ISO-2)", initialValue: "US" });
      if (p.isCancel(country)) return p.cancel();
      buyer = { email, name: nm };
      shipping = { name: nm, line1, city, postalCode, country: country.toUpperCase() };
    }
    const keyFile = `buyer-${name}`;
    const { publicKey, path } = generateAndStoreKeypair(keyFile, passphrase);
    const mandate = mandateSchema.parse({
      maxPerTx,
      maxTotal,
      period: "day",
      ...(confirmAbove ? { requireConfirmAboveUsdc: confirmAbove } : {}),
      allowPhysicalGoods: physical === true,
      shippingAddressLocked: true,
    });
    const profile: Profile = {
      name,
      network: opts.network,
      keyFile,
      address: publicKey,
      mandate,
      ...(buyer ? { buyer } : {}),
      ...(shipping ? { shipping } : {}),
      sites: [],
      createdAt: new Date().toISOString(),
    };
    const file = saveProfile(profile);
    if (opts.network === "testnet") {
      const res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`).catch(() => undefined);
      p.note(
        res?.ok
          ? "Funded with test XLM via friendbot."
          : "Fund it at https://faucet.circle.com (USDC) or friendbot (XLM).",
        "Testnet funding",
      );
    } else {
      p.note(
        `Send USDC to ${publicKey} from your own wallet. Keep it small: this is a prepaid card for the agent.`,
        "Funding",
      );
    }
    p.note(
      `Profile: ${file}\nWallet: ${publicKey}\nKey file (encrypted): ${path}\n\nMCP config for Claude:\n  command: agentpos-buyer\n  args: ["serve", "--profile", "${name}"]\n  env: { AGENTPOS_BUYER_PASSPHRASE: "<your passphrase>" }`,
      "Done",
    );
    p.outro("The agent can now buy within this mandate. Edit the JSON file to change limits.");
  });

program
  .command("sites")
  .description("Manage the profile's default store list")
  .argument("<action>", "add | remove | list")
  .argument("[url]")
  .action((action: string, url?: string) => {
    try {
      const profile = loadProfile(program.opts<{ profile: string }>().profile);
      if (action === "list") return console.log(profile.sites.join("\n") || "(none)");
      if (!url)
        throw new AgentPOSError("CONFIG_INVALID", "url required", {
          hint: "agentpos-buyer sites add https://shop.example",
        });
      profile.sites =
        action === "add"
          ? [...new Set([...profile.sites, url])]
          : profile.sites.filter((s) => s !== url);
      saveProfile(profile);
      console.log(pc.green(`${action}: ${url}`));
    } catch (err) {
      die(err);
    }
  });

program
  .command("pending")
  .description("Carts waiting for your approval")
  .action(() => {
    const name = program.opts<{ profile: string }>().profile;
    const items = listPending(name);
    if (items.length === 0) return console.log("nothing pending");
    for (const it of items)
      console.log(
        `${it.requestedAt}  ${pc.bold(it.cartId)}  ${it.amount}  ${it.site}\n   ${it.summary}`,
      );
  });

program
  .command("approve")
  .description("Approve a cart the agent asked confirmation for")
  .argument("<cartId>")
  .action((cartId: string) => {
    try {
      const a = approve(program.opts<{ profile: string }>().profile, cartId);
      console.log(
        pc.green(
          `approved ${cartId} (${a.amount}) at ${a.site}. Tell the agent to call buy again.`,
        ),
      );
    } catch (err) {
      die(err);
    }
  });

program
  .command("log")
  .description("Spending log")
  .action(() => {
    const name = program.opts<{ profile: string }>().profile;
    const entries = SpendingLog.forProfile(name).entries();
    if (entries.length === 0) return console.log("no payments yet");
    let total = 0n;
    for (const e of entries) {
      total += BigInt(e.amountMinor);
      console.log(
        `${e.ts}  ${formatUsdc(BigInt(e.amountMinor) as never).padStart(10)} ${e.asset}  ${e.site}  ${e.summary}  tx=${e.txHash}`,
      );
    }
    console.log(pc.bold(`total ${formatUsdc(total as never)}`));
  });

program
  .command("demo")
  .description("Discover a store, quote a cart, pay it, and show the hash (the reference agent)")
  .argument("<store-url>", "store origin, e.g. https://shop.example")
  .option("--item <id>", "item to buy (default: the cheapest published item)")
  .option("-q, --quantity <n>", "how many", "1")
  .option("--dry-run", "stop before paying: no wallet and no funds needed")
  .option("--json", "print the run as JSON instead of narrating it")
  .action(
    async (
      storeUrl: string,
      opts: { item?: string; quantity: string; dryRun?: boolean; json?: boolean },
    ) => {
      const name = program.opts<{ profile: string }>().profile;
      try {
        let buyerService: BuyerService | undefined;
        let buyer: Profile["buyer"] | undefined;
        let shipping: Profile["shipping"] | undefined;
        if (!opts.dryRun) {
          // The wallet is only needed to pay. A dry run must work on a machine that has never
          // run `init`, because that is the first thing a stranger evaluating us will try.
          const profile = loadProfile(name);
          buyer = profile.buyer;
          shipping = profile.shipping;
          buyerService = new BuyerService({ profile });
        }
        const result = await runDemoPurchase({
          storeUrl,
          itemId: opts.item,
          quantity: Number(opts.quantity),
          dryRun: Boolean(opts.dryRun),
          buyer,
          shipping,
          buyerService,
          onStep: opts.json
            ? undefined
            : (s) => {
                const colour =
                  s.step === "settled" || s.step === "receipt"
                    ? pc.green
                    : s.step === "policy"
                      ? pc.yellow
                      : pc.dim;
                console.log(`${colour(s.step.padEnd(9))} ${s.message}`);
              },
        });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log("");
        if (result.paid) {
          console.log(pc.green(`Bought. tx ${result.txHash}`));
          console.log(
            pc.dim(
              `Verify it yourself: https://stellar.expert/explorer/${result.store.network === "stellar:pubnet" ? "public" : "testnet"}/tx/${result.txHash}`,
            ),
          );
        } else if (opts.dryRun) {
          console.log(
            pc.dim("Nothing was paid. Drop --dry-run (and run `agentpos-buyer init`) to buy for real."),
          );
        }
      } catch (err) {
        die(err);
      }
    },
  );

program
  .command("serve")
  .description("Run the MCP server over stdio (for Claude Desktop / Claude Code)")
  .action(async () => {
    const name = program.opts<{ profile: string }>().profile;
    try {
      loadProfile(name);
      const server = buildBuyerServer({ defaultProfile: name });
      await server.connect(new StdioServerTransport());
      console.error(pc.dim(`[agentpos-buyer] MCP server on stdio, profile ${name}`));
    } catch (err) {
      die(err);
    }
  });

program.parseAsync(process.argv).catch(die);
