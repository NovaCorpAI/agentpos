/**
 * Environment configuration. Deliberately tiny: a port, a database file and a network.
 * There is no slot for a secret because this service must never hold one.
 */
import { join } from "node:path";
import { AgentPOSError } from "@agentpos/core";
import { agentposHome } from "@agentpos/mcp-buyer";

export interface BuyerWebConfig {
  port: number;
  dbFile: string;
  network: "testnet" | "mainnet";
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
  return {
    port,
    network,
    dbFile: env.BUYER_WEB_DB ?? join(agentposHome(), "buyer-web.sqlite"),
  };
}
