/**
 * Entrypoint. Reads the environment, refuses to start on a bad configuration, and says out loud
 * which address will be paying fees so an operator notices immediately if it is the wrong one.
 */
import { serve } from "@hono/node-server";
import { AgentGateError, createLogger } from "@agentgate/core";
import { createFacilitatorApp } from "./app.js";
import { configFromEnv } from "./config.js";

const logger = createLogger({ base: { service: "facilitator" } });

try {
  const config = configFromEnv();
  const { app, signerAddress } = createFacilitatorApp({ config, logger });

  logger.info("facilitator.starting", {
    network: config.caip2,
    signer: signerAddress,
    allowedAssets: config.allowedAssets.length,
    apiKeys: config.apiKeys.length,
    maxFeeStroops: config.maxFeeStroops,
    // Host only: an RPC URL can embed the provider's API key, and a log line is one grep away
    // from a transcript. The full URL exists in the environment and nowhere else.
    rpcHost: config.rpcUrl ? new URL(config.rpcUrl).host : "(sdk default)",
  });
  // Printed, not just logged: the operator must fund this exact account, and a wrong address here
  // is the difference between "it works" and "every settlement fails at 3am".
  console.log(`x402 facilitator on :${config.port}`);
  console.log(`  network   ${config.caip2}`);
  console.log(`  fee payer ${signerAddress}   <- fund this account with XLM, nothing else`);
  console.log(`  health    http://localhost:${config.port}/health`);

  serve({ fetch: app.fetch, port: config.port });
} catch (err) {
  if (err instanceof AgentGateError) {
    console.error(`\n${err.code}: ${err.message}`);
    console.error(`hint: ${err.hint}`);
  } else {
    console.error(err);
  }
  process.exit(1);
}
