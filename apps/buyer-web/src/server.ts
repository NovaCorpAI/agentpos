/**
 * Entrypoint. Reads the environment, refuses to start on a bad configuration, and states the
 * custody rule out loud on every start so nobody forgets what this process is and is not.
 */
import { serve } from "@hono/node-server";
import { AgentPOSError } from "@agentpos/core";
import { createBuyerWebApp } from "./app.js";
import { configFromEnv } from "./config.js";
import { BuyerWebStorage } from "./storage.js";

try {
  const config = configFromEnv();
  const storage = new BuyerWebStorage(config.dbFile);
  const { app } = createBuyerWebApp({
    storage,
    network: config.network,
    ...(config.whatsapp ? { whatsapp: config.whatsapp } : {}),
  });

  const channels = config.whatsapp
    ? [config.whatsapp.meta ? "meta" : "", config.whatsapp.twilio ? "twilio" : ""]
        .filter(Boolean)
        .join("+")
    : "disabled";
  console.log(`AgentPOS buyer web on :${config.port}`);
  console.log(`  network  ${config.network}`);
  console.log(`  storage  ${config.dbFile}`);
  console.log(`  mandate  http://localhost:${config.port}/`);
  console.log(`  whatsapp ${channels}`);
  console.log(`  custody  this process stores PUBLIC wallet addresses only and cannot sign`);

  serve({ fetch: app.fetch, port: config.port });
} catch (err) {
  if (err instanceof AgentPOSError) {
    console.error(`\n${err.code}: ${err.message}`);
    console.error(`hint: ${err.hint}`);
  } else {
    console.error(err);
  }
  process.exit(1);
}
