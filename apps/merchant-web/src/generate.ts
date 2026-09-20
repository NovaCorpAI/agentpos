/**
 * Generates the two files a merchant needs (`agentpos.config.json` and `.env`), plus the exact
 * reverse-proxy snippets and next commands from docs/onboarding. The config is built through
 * `parseSiteConfig` (which runs `siteConfigSchema`), so what leaves this module is valid by
 * construction: if `npx agentpos serve` refuses it, this endpoint would have refused it first.
 *
 * Statelessness: the WooCommerce keys the merchant typed come straight back inside the generated
 * `.env` content and are not written, logged or stored anywhere on this server. The same holds
 * for the `MERCHANT_API_TOKEN` minted here: it exists in this function's return value, travels
 * to the browser once, and is never persisted or logged on our side.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { parseSiteConfig, SITE_CONFIG_FILE } from "@agentpos/site";
import type { SiteConfigInput } from "@agentpos/site";
import { validateWalletAddress } from "./wallet.js";

export const generateRequestSchema = z.object({
  /** Public URL of the merchant's site, e.g. https://shop.example */
  siteUrl: z.url(),
  displayName: z.string().trim().min(1),
  /** Stellar PUBLIC address (validated separately, with its own error codes). */
  payTo: z.string(),
  /** "generic" is the custom-hook platform: the merchant implements createOrder themselves. */
  platform: z.enum(["woocommerce", "generic"]),
  wooBaseUrl: z.url().optional(),
  wooConsumerKey: z.string().trim().optional(),
  wooConsumerSecret: z.string().trim().optional(),
});

export type GenerateRequest = z.infer<typeof generateRequestSchema>;

export interface GeneratedOutput {
  files: {
    config: { filename: string; content: string };
    env: { filename: string; content: string };
  };
  proxy: { nginx: string; caddy: string };
  /** The next commands, in order, exactly as docs/onboarding runs them. */
  commands: string[];
  /**
   * The store owner's token for the read-only merchant API (`MERCHANT_API_TOKEN`), minted fresh
   * on every call and already written into the `.env` above. Returned separately so the wizard
   * can show it, explain it and offer a copy button: it is what the merchant pastes into the
   * AgentPOS Cloud panel, and nothing else in the flow ever produced it for them.
   */
  merchantApiToken: string;
}

/**
 * 32 bytes of crypto randomness, base64url (43 characters, url-safe, no padding). Well above
 * the 24-character minimum `secretsFromEnv` enforces, and generated per request: this server
 * keeps no pool, no seed and no copy.
 */
function newMerchantApiToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Sidecar port and paths from docs/onboarding (the sidecar default). */
const SIDECAR = "http://127.0.0.1:8402";

const NGINX_SNIPPET = `location /.well-known/ucp { proxy_pass ${SIDECAR}; }
location /agentpos/       { proxy_pass ${SIDECAR}; }
location = /openapi.json   { proxy_pass ${SIDECAR}; }
location = /llms.txt       { proxy_pass ${SIDECAR}; }`;

const CADDY_SNIPPET = `handle /.well-known/ucp* {
  reverse_proxy ${SIDECAR}
}
handle /agentpos/* {
  reverse_proxy ${SIDECAR}
}
handle /openapi.json {
  reverse_proxy ${SIDECAR}
}
handle /llms.txt {
  reverse_proxy ${SIDECAR}
}`;

const COMMANDS = [
  "npx agentpos scan",
  "npx agentpos confirm",
  "npx agentpos publish",
  "npx agentpos serve",
];

function buildEnv(request: GenerateRequest, merchantApiToken: string): string {
  const lines = [
    "# Claves de AgentPOS. Este archivo vive en tu servidor: nunca lo subas a un repositorio.",
    "AGENTPOS_NETWORK=testnet",
    "# Llave del facilitador de pagos (testnet, gratis): https://channels.openzeppelin.com/testnet/gen",
    "AGENTPOS_FACILITATOR_API_KEY=",
    // Merchant-facing line, so it is written in the merchant's language (project convention:
    // no em dashes in Spanish text). It is the one value the Cloud panel asks for.
    "# Llave del panel de AgentPOS: deja que el panel lea tus órdenes, tus comprobantes y tus",
    "# reglas. Es de solo lectura: no puede mover dinero ni cambiar precios. No la compartas.",
    `MERCHANT_API_TOKEN=${merchantApiToken}`,
  ];
  if (request.platform === "woocommerce") {
    lines.push(
      "# Llave REST de WooCommerce (WP Admin > WooCommerce > Ajustes > Avanzado > API REST, Lectura/Escritura).",
      `AGENTPOS_WOO_CONSUMER_KEY=${request.wooConsumerKey ?? "ck_..."}`,
      `AGENTPOS_WOO_CONSUMER_SECRET=${request.wooConsumerSecret ?? "cs_..."}`,
    );
  }
  lines.push(
    "# Mainnet: solo cuando tu primera compra de prueba haya funcionado, y solo a propósito.",
    "# AGENTPOS_NETWORK=mainnet",
    "# AGENTPOS_ALLOW_MAINNET=true",
    "# AGENTPOS_FACILITATOR_URL=",
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Validates every field the way the sidecar itself would, and returns the file contents. Throws
 * `AgentPOSError` (`CONFIG_INVALID`, `SECRET_IN_CONFIG`) on anything the sidecar would reject.
 */
export function generateFiles(request: GenerateRequest): GeneratedOutput {
  const payTo = validateWalletAddress(request.payTo);

  // The exact object written to disk: minimal, like `npx agentpos init` writes it, so the file
  // stays readable and the sidecar's own defaults keep applying.
  const config: SiteConfigInput = {
    siteUrl: request.siteUrl,
    displayName: request.displayName,
    payTo,
    platform: request.platform,
    ...(request.platform === "woocommerce"
      ? { woocommerce: { baseUrl: request.wooBaseUrl ?? request.siteUrl } }
      : {}),
  };

  // Valid by construction: this is the same parse `npx agentpos serve` runs at startup,
  // including the refusal of any secret smuggled into the config.
  parseSiteConfig(config);

  const merchantApiToken = newMerchantApiToken();

  return {
    files: {
      config: {
        filename: SITE_CONFIG_FILE,
        content: `${JSON.stringify(config, null, 2)}\n`,
      },
      env: { filename: ".env", content: buildEnv(request, merchantApiToken) },
    },
    proxy: { nginx: NGINX_SNIPPET, caddy: CADDY_SNIPPET },
    commands: COMMANDS,
    merchantApiToken,
  };
}
