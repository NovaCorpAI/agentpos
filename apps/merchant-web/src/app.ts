/**
 * The merchant onboarding wizard's HTTP surface. STATELESS by design: no accounts, no database,
 * no session, nothing written server-side. Every endpoint takes what the browser sends, acts on
 * it once, and forgets it. The only state lives in the merchant's browser while they fill the
 * wizard, and in the files they download.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ZodType } from "zod";
import { AgentPOSError, createLogger, newTraceId } from "@agentpos/core";
import type { ErrorCode, Logger } from "@agentpos/core";
import { buildWizardHtml } from "./page.js";
import { generateFiles, generateRequestSchema } from "./generate.js";
import { validateWalletAddress } from "./wallet.js";
import { validateWooCredentials, wooValidationRequestSchema } from "./woo.js";
import { verifyDeployment } from "./verify.js";

export interface MerchantWebDeps {
  /** Tests inject a fake network; production uses global fetch. */
  fetchImpl?: typeof globalThis.fetch;
  logger?: Logger;
}

const MAX_BODY_BYTES = 64 * 1024;
const TRACE_HEADER = "x-agentpos-trace";

const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  CONFIG_INVALID: 400,
  SECRET_IN_CONFIG: 400,
  SITE_UNREACHABLE: 502,
  INTERNAL: 502,
};

function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof AgentPOSError) {
    return c.json({ error: err.toJSON() }, (STATUS_BY_CODE[err.code] ?? 500) as 400);
  }
  return c.json(
    {
      error: {
        code: "INTERNAL",
        message: String(err),
        hint: "Unexpected error; check server logs.",
        retryable: true,
      },
    },
    500,
  );
}

/** Body parsing that answers in our error vocabulary instead of a bare 400. */
async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AgentPOSError("CONFIG_INVALID", "The request body is not valid JSON", {
      hint: "Send a JSON object with content-type: application/json.",
    });
  }
}

function parsed<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AgentPOSError("CONFIG_INVALID", "Some fields are missing or invalid", {
      hint: "Fix the fields listed in details and try again.",
      details: { issues: result.error.issues },
    });
  }
  return result.data;
}

export function createMerchantWebApp(deps: MerchantWebDeps = {}): Hono {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const logger = deps.logger ?? createLogger({ base: { service: "merchant-web" } });

  const app = new Hono();

  app.onError((err, c) => {
    logger.error("http.error", {
      traceId: c.res.headers.get(TRACE_HEADER),
      path: c.req.path,
      error: err.message,
      code: err instanceof AgentPOSError ? err.code : undefined,
    });
    return errorResponse(c, err);
  });

  app.use("*", async (c, next) => {
    c.header(TRACE_HEADER, c.req.header(TRACE_HEADER)?.slice(0, 64) ?? newTraceId());
    await next();
  });
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json(
          {
            error: {
              code: "CONFIG_INVALID",
              message: "Request body too large",
              hint: `Keep requests under ${MAX_BODY_BYTES} bytes.`,
              retryable: false,
            },
          },
          413,
        ),
    }),
  );

  // The wizard itself: one self-contained page, no assets, no CDN.
  app.get("/", (c) => c.html(buildWizardHtml()));

  // Wallet check, so the wizard can refuse a secret key the moment it is pasted.
  app.post("/api/validate-wallet", async (c) => {
    const body = (await jsonBody(c)) as { address?: unknown };
    const address = validateWalletAddress(body?.address);
    return c.json({ ok: true, address });
  });

  // One-shot WooCommerce credential probe. Keys are used here and forgotten.
  app.post("/api/validate-woo", async (c) => {
    const request = parsed(wooValidationRequestSchema, await jsonBody(c));
    const result = await validateWooCredentials(request, fetchImpl);
    return c.json(result);
  });

  // Builds agentpos.config.json (via siteConfigSchema, valid by construction) and .env.
  app.post("/api/generate", async (c) => {
    const request = parsed(generateRequestSchema, await jsonBody(c));
    return c.json(generateFiles(request));
  });

  // Deployment checklist: the same discovery the reference buying agent performs.
  app.get("/api/verify", async (c) => {
    const domain = c.req.query("domain");
    if (!domain) {
      throw new AgentPOSError("CONFIG_INVALID", "Missing ?domain=", {
        hint: "Call /api/verify?domain=shop.example.",
      });
    }
    return c.json(await verifyDeployment(domain, fetchImpl));
  });

  return app;
}
