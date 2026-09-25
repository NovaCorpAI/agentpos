/**
 * Entrypoint. There is nothing to configure because there is nothing stored: the wizard is a
 * page plus three stateless endpoints.
 */
import { serve } from "@hono/node-server";
import { createLogger } from "@agentpos/core";
import { createMerchantWebApp } from "./app.js";

const port = Number(process.env.PORT ?? 8410);
const logger = createLogger({ base: { service: "merchant-web" } });

const gate = process.env.INSTALLER_GATE === "waitlist" ? "waitlist" : "open";
const app = createMerchantWebApp({ logger, gate });

logger.info("merchant-web.starting", { port, gate });
console.log(`AgentPOS onboarding wizard on http://localhost:${port}`);
console.log("  stateless: no accounts, no database, nothing stored server-side");
if (gate === "waitlist") console.log("  gate: waitlist (the page invites to the list; /api answers 503 INSTALLER_CLOSED)");

serve({ fetch: app.fetch, port });
