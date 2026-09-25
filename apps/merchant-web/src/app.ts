/**
 * The merchant onboarding wizard's HTTP surface. STATELESS by design: no accounts, no database,
 * no session, nothing written server-side. Every endpoint takes what the browser sends, acts on
 * it once, and forgets it. The only state lives in the merchant's browser while they fill the
 * wizard, and in the files they download.
 *
 * Published on the open internet, three of those endpoints fetch a URL the caller chose. They
 * do it through `createGuardedFetch` (see ssrf.ts), one instance per inbound request, so this
 * server can only reach public addresses and only a bounded number of them per call.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ZodType } from "zod";
import { AgentPOSError, createLogger, newTraceId } from "@agentpos/core";
import type { ErrorCode, Logger } from "@agentpos/core";
import { buildWizardHtml } from "./page.js";
import { buildHoldingHtml } from "./hold.js";
import { generateFiles, generateRequestSchema } from "./generate.js";
import { validateWalletAddress } from "./wallet.js";
import { validateWooCredentials, wooValidationRequestSchema } from "./woo.js";
import { verifyDeployment, verifyRequestSchema } from "./verify.js";
import { createGuardedFetch } from "./ssrf.js";
import type { HostResolver } from "./ssrf.js";
import { rateLimit, TokenBucketLimiter, VERIFY_RULE, WOO_RULE } from "./limits.js";

export interface MerchantWebDeps {
  /** Tests inject a fake network; production uses global fetch. Always wrapped by the guard. */
  fetchImpl?: typeof globalThis.fetch;
  /** Hostname resolution for the SSRF guard. Tests inject a stub; production uses node:dns. */
  resolveHost?: HostResolver;
  logger?: Logger;
  /**
   * "open" serves the wizard. "waitlist" holds the door: the page becomes an invitation to the
   * waitlist and every /api endpoint answers 503 INSTALLER_CLOSED, so nothing can be generated
   * around the page. The container sets it (INSTALLER_GATE); a laptop run stays open.
   */
  gate?: InstallerGate;
}

export type InstallerGate = "open" | "waitlist";

const MAX_BODY_BYTES = 64 * 1024;
const TRACE_HEADER = "x-agentpos-trace";
/**
 * Outbound requests one inbound request may trigger. The checklist makes four probes, six when
 * the merchant also sends the panel key; anything above that is a redirect chain or a bug, and
 * either way this server stops being a probe for somebody else's scan.
 */
const MAX_OUTBOUND_PER_REQUEST = 8;

const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  CONFIG_INVALID: 400,
  SECRET_IN_CONFIG: 400,
  RATE_LIMITED: 429,
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
        hint: "Error inesperado de nuestro lado. Vuelve a intentarlo en un momento.",
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
    throw new AgentPOSError("CONFIG_INVALID", "Lo que llegó no es JSON válido", {
      hint: "Envía un objeto JSON con content-type: application/json.",
    });
  }
}

function parsed<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AgentPOSError("CONFIG_INVALID", "Falta completar algún dato, o alguno no es válido", {
      hint: "Revisa la dirección de tu tienda, su nombre y la dirección de tu wallet, y vuelve a intentarlo.",
      details: { issues: result.error.issues },
    });
  }
  return result.data;
}

export function createMerchantWebApp(deps: MerchantWebDeps = {}): Hono {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const logger = deps.logger ?? createLogger({ base: { service: "merchant-web" } });

  /**
   * One guarded fetch per inbound request: the guard refuses non-public addresses and the
   * instance carries the probe budget, so the budget cannot leak from one merchant to the next.
   */
  const outbound = (): typeof globalThis.fetch =>
    createGuardedFetch({
      fetchImpl,
      ...(deps.resolveHost !== undefined ? { resolve: deps.resolveHost } : {}),
      maxRequests: MAX_OUTBOUND_PER_REQUEST,
    });

  // Fresh limiters per app instance (tests get their own; the server builds the app once).
  const wooLimiter = new TokenBucketLimiter(WOO_RULE);
  const verifyLimiter = new TokenBucketLimiter(VERIFY_RULE);

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
              message: "Lo que enviaste es demasiado grande",
              hint: `Cada envío tiene que pesar menos de ${MAX_BODY_BYTES} bytes.`,
              retryable: false,
            },
          },
          413,
        ),
    }),
  );

  // Liveness stays answerable behind the gate: the healthcheck must not report a held door as
  // a dead container.
  app.get("/health", (c) =>
    c.json({ ok: true, service: "merchant-web", stateless: true, gate: deps.gate ?? "open" }),
  );

  // The held door. Registered before the wizard and the API so it wins every match: the page
  // invites to the waitlist and the API refuses in our error vocabulary, with a Retry-After so
  // a script that finds the door closed knows it is not broken.
  if (deps.gate === "waitlist") {
    app.get("/", (c) => c.html(buildHoldingHtml()));
    app.use("/api/*", async (c) => {
      c.header("retry-after", String(7 * 24 * 3600));
      return c.json(
        {
          error: {
            code: "INSTALLER_CLOSED",
            message: "El instalador todavía no está abierto al público",
            hint: "Súmate a la lista de espera en https://agentposhq.com/lista y te avisamos cuando abra.",
            retryable: true,
          },
        },
        503,
      );
    });
  }

  // Per-IP limits on the endpoints that make this server open outbound connections. The page
  // itself and the two pure-computation endpoints (wallet, generate) are not limited: they
  // touch nothing but this process.
  app.use("/api/validate-woo", rateLimit(wooLimiter, "validate-woo"));
  app.use("/api/verify", rateLimit(verifyLimiter, "verify"));

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
    const result = await validateWooCredentials(request, outbound());
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
      throw new AgentPOSError("CONFIG_INVALID", "Falta el parámetro ?domain=", {
        hint: "Llama a /api/verify?domain=mitienda.cl.",
      });
    }
    return c.json(await verifyDeployment(domain, outbound()));
  });

  // Same checklist, plus the merchant panel check. It is a POST because the store owner's key
  // travels with it: a body is not written to access logs the way a query string is, and this
  // app logs neither. The key is used for two probes against the merchant's own store and then
  // dropped with the request.
  app.post("/api/verify", async (c) => {
    const request = parsed(verifyRequestSchema, await jsonBody(c));
    return c.json(await verifyDeployment(request.domain, outbound(), request.merchantApiToken));
  });

  return app;
}
