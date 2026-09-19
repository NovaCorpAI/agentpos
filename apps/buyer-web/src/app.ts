/**
 * HTTP surface: the server-rendered pages for the human (/, /proposals, /activity, plus
 * /login and /setup) and a JSON API under /api that mirrors the service one-to-one, so
 * tests and other channels (WhatsApp bridge, mobile) exercise exactly what the pages use.
 *
 * Access model, in one paragraph. This surface can raise a spending limit and approve a
 * payment that the owner's own machine will then sign, so everything here is behind the
 * owner's login except four things: /health (a liveness probe), /login and /setup (the way
 * in), the WhatsApp webhooks and /api/signer/* (which authenticate themselves on every
 * single request, with a provider signature and a bearer token respectively, and therefore
 * carry no cookie and need no CSRF token). Everything else answers a redirect to /login
 * (pages) or a typed 401 (JSON) without a session, and every state-changing request needs
 * the per-session CSRF token. Approving a payment asks for the password again.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { AgentPOSError, compareUsdc, isAgentPOSError, usdc, usdcFromMinor } from "@agentpos/core";
import type { ErrorCode, Logger } from "@agentpos/core";
import { AuthService, setupDone } from "./auth/service.js";
import type { AuthenticatedSession, OwnerBootstrap } from "./auth/service.js";
import { AuthError, isAuthError } from "./auth/errors.js";
import type { RequestOrigin } from "./auth/fingerprint.js";
import {
  clearSessionCookie,
  csrfTokenFrom,
  isMutating,
  isPublicPath,
  isRecoverySessionPath,
  isSelfAuthenticated,
  originOf,
  safeNext,
  sessionIdFrom,
  writeSessionCookie,
} from "./auth/http.js";
import { BuyerWebService, parseAttributePairs } from "./service.js";
import type { MarketCallInput } from "./service.js";
import type { BuyerWebStorage } from "./storage.js";
import {
  MARKET_ATTRIBUTE_ROWS,
  accountPage,
  activityPage,
  errorPage,
  homePage,
  loginPage,
  newPasswordPage,
  operatorRecoveryPage,
  proposalsPage,
  recoverPage,
  recoveryCodesPage,
  setupPage,
} from "./pages.js";
import type {
  MandateFormValues,
  MarketFormValues,
  MarketSearch,
  SessionView,
} from "./pages.js";
import type { BuyerWebProfile, Proposal } from "./types.js";
import type { WhatsAppConfig } from "./config.js";
import { ConversationHandler } from "./whatsapp/conversation.js";
import { MetaTransport, createMetaWebhook } from "./whatsapp/meta.js";
import { createOwnerNotifier } from "./whatsapp/notify.js";
import { TwilioTransport, createTwilioWebhook } from "./whatsapp/twilio.js";
import { timingSafeEqualStrings } from "./whatsapp/types.js";
import type { WhatsAppLogger, WhatsAppTransport } from "./whatsapp/types.js";

export interface BuyerWebAppDeps {
  storage: BuyerWebStorage;
  network?: "testnet" | "mainnet";
  /** Tests inject the in-process store; production uses global fetch. */
  fetchImpl?: typeof globalThis.fetch;
  /** WhatsApp channel; routes are mounted only when this is present. */
  whatsapp?: WhatsAppConfig;
  /**
   * Bearer token for the signing bridge (`/api/signer/*`). It authorizes the buyer's OWN
   * signer daemon (`agentpos-buyer watch`) and nothing else: the daemon holds the wallet
   * key on the buyer's machine, this token only lets it read the approved queue and report
   * settled payments back. Routes are not mounted at all when it is absent. Min 24 chars.
   */
  signerToken?: string;
  /** Tests inject fake transports; production builds Meta/Twilio transports from config. */
  whatsappTransports?: { meta?: WhatsAppTransport; twilio?: WhatsAppTransport };
  /** Structured event log for the WhatsApp channel. Event codes and sender hashes only. */
  log?: WhatsAppLogger;
  /** Structured event log for the buyer service. Never carries a full postal address. */
  logger?: Logger;
  /**
   * Owner account from the environment, for a deploy that cannot stop at the setup form.
   * Email plus a scrypt HASH; it is authoritative on every start and replacing it closes
   * every open session. Absent means the account is created once at /setup.
   */
  owner?: OwnerBootstrap;
  /** Session lifetime; it slides forward on use. Tests shorten it. Default 12 h. */
  sessionTtlMs?: number;
  /** Clock, injected by tests that need to watch a session expire. */
  now?: () => Date;
}

/** Per-request state the access layer puts on the context. */
export interface BuyerWebEnv {
  Variables: {
    origin: RequestOrigin;
    auth?: AuthenticatedSession;
  };
}

export interface BuyerWebApp {
  app: Hono<BuyerWebEnv>;
  fetch: (request: Request) => Response | Promise<Response>;
  service: BuyerWebService;
  /** The access layer, for the server entrypoint and for tests. */
  auth: AuthService;
}

const STATUS_BY_CODE: Partial<Record<ErrorCode, ContentfulStatusCode>> = {
  CONFIG_INVALID: 400,
  SECRET_IN_CONFIG: 400,
  ITEM_NOT_FOUND: 404,
  ITEM_NOT_PUBLISHED: 404,
  APPROVAL_NOT_FOUND: 404,
  CART_NOT_FOUND: 404,
  OUT_OF_STOCK: 409,
  APPROVAL_REJECTED: 409,
  APPROVAL_PENDING: 409,
  APPROVAL_UNAUTHORIZED: 401,
  APPROVAL_EXPIRED: 410,
  CART_EXPIRED: 410,
  SHIPPING_REQUIRED: 422,
  MANDATE_EXCEEDED: 403,
  SELLER_UNVERIFIED: 403,
  CONFIRMATION_REQUIRED: 403,
  SITE_UNREACHABLE: 502,
};

const proposeSchema = z.object({
  storeUrl: z.url(),
  itemId: z.string().min(1),
  quantity: z.coerce.number().int().min(1).max(999).default(1),
});

function formValues(profile: BuyerWebProfile | undefined): MandateFormValues {
  const s = profile?.shipping;
  return {
    maxPerTx: profile?.mandate.maxPerTx ?? "10",
    maxTotal: profile?.mandate.maxTotal ?? "50",
    period: profile?.mandate.period ?? "day",
    stores: (profile?.stores ?? []).join("\n"),
    allowPhysicalGoods: profile?.mandate.allowPhysicalGoods ?? false,
    email: profile?.email ?? "",
    shipping: {
      name: s?.name ?? "",
      line1: s?.line1 ?? "",
      line2: s?.line2 ?? "",
      city: s?.city ?? "",
      region: s?.region ?? "",
      postalCode: s?.postalCode ?? "",
      country: s?.country ?? "",
      phone: s?.phone ?? "",
    },
    walletAddress: profile?.walletAddress ?? "",
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The market call form as it arrives in the query string, kept verbatim so the page can render
 * back exactly what the human typed. Attribute rows are padded to the number of inputs shown.
 */
function marketFormValues(c: Context): MarketFormValues {
  const rows = c.req.queries("attr") ?? [];
  const padded = [...rows];
  while (padded.length < MARKET_ATTRIBUTE_ROWS) padded.push("");
  return {
    what: (c.req.query("q") ?? "").trim(),
    attributes: padded,
    maxPriceUsdc: (c.req.query("max") ?? "").trim(),
    quantity: (c.req.query("qty") ?? "1").trim() || "1",
    physical: (c.req.query("physical") ?? "").trim(),
  };
}

/** Form values -> what the service takes. Throws a typed CONFIG_INVALID on anything malformed. */
function marketCallInput(values: MarketFormValues): MarketCallInput {
  const quantity = Number(values.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
    throw new AgentPOSError("CONFIG_INVALID", `Cantidad invalida: '${values.quantity}'`, {
      hint: "Usa un numero entero entre 1 y 999.",
    });
  }
  if (values.physical !== "" && values.physical !== "true" && values.physical !== "false") {
    throw new AgentPOSError("CONFIG_INVALID", `Tipo de producto invalido`, {
      hint: "Elige cualquiera, solo fisicos o solo digitales.",
    });
  }
  return {
    what: values.what,
    attributes: parseAttributePairs(values.attributes),
    ...(values.maxPriceUsdc ? { maxPriceUsdc: values.maxPriceUsdc } : {}),
    quantity,
    ...(values.physical ? { physical: values.physical === "true" } : {}),
  };
}

export function createBuyerWebApp(deps: BuyerWebAppDeps): BuyerWebApp {
  const network = deps.network ?? "testnet";
  if (deps.signerToken !== undefined && deps.signerToken.length < 24) {
    throw new AgentPOSError("CONFIG_INVALID", "SIGNER_TOKEN is too short", {
      hint: "Use at least 24 characters, e.g. `openssl rand -hex 24`. A guessable token would let anyone mark proposals paid.",
    });
  }
  const service = new BuyerWebService({
    storage: deps.storage,
    network,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  // The WhatsApp transports are built once, here, because two things send through them:
  // the bot's replies and the recovery code. There is deliberately no second send path.
  const log: WhatsAppLogger =
    deps.log ??
    ((event, data) =>
      console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data })));
  const whatsappTransports: { meta?: WhatsAppTransport; twilio?: WhatsAppTransport } =
    deps.whatsapp
      ? {
          ...(deps.whatsapp.meta
            ? { meta: deps.whatsappTransports?.meta ?? new MetaTransport(deps.whatsapp.meta) }
            : {}),
          ...(deps.whatsapp.twilio
            ? {
                twilio:
                  deps.whatsappTransports?.twilio ?? new TwilioTransport(deps.whatsapp.twilio),
              }
            : {}),
        }
      : {};
  const notifier = deps.whatsapp
    ? createOwnerNotifier({ config: deps.whatsapp, transports: whatsappTransports, log })
    : undefined;
  const auth = new AuthService({
    storage: deps.storage,
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.sessionTtlMs !== undefined ? { sessionTtlMs: deps.sessionTtlMs } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(notifier ? { notifier } : {}),
  });
  if (deps.owner) auth.bootstrapOwner(deps.owner);
  const app = new Hono<BuyerWebEnv>();

  const pendingCount = () => service.pendingProposals().length;
  // Read-only channel state for the pages: whether each optional channel is mounted.
  const channels = {
    whatsapp: deps.whatsapp !== undefined,
    signer: deps.signerToken !== undefined,
  };

  // --- access layer ----------------------------------------------------------

  const wantsJson = (c: Context) =>
    c.req.path.startsWith("/api/") || (c.req.header("accept") ?? "").includes("application/json");

  /** The signed-in owner on a guarded route. The guard guarantees it is there. */
  const sessionOf = (c: Context<BuyerWebEnv>): AuthenticatedSession => {
    const authed = c.get("auth");
    if (!authed) {
      throw new AuthError("AUTH_REQUIRED", "Tu sesion no esta activa", {
        hint: "Entra de nuevo en /login.",
      });
    }
    return authed;
  };

  const viewOf = (c: Context<BuyerWebEnv>): SessionView => {
    const { account, session } = sessionOf(c);
    return { email: account.email, csrf: session.csrfToken };
  };

  const originIn = (c: Context<BuyerWebEnv>): RequestOrigin => c.get("origin") ?? originOf(c);

  /**
   * The nudge for an owner whose account predates recovery codes: this space already
   * exists in production without a set, and the day the password is lost is a bad day to
   * find that out. It offers to generate one, can be put away for the session, and comes
   * back on the next one until codes exist.
   */
  const reminderFor = (
    c: Context<BuyerWebEnv>,
    next: string,
  ): { csrf: string; next: string } | undefined => {
    const authed = c.get("auth");
    if (!authed || authed.session.scope !== "full") return undefined;
    if (!auth.needsRecoveryCodes()) return undefined;
    if (auth.reminderDismissed(authed.session.id)) return undefined;
    return { csrf: authed.session.csrfToken, next };
  };

  /**
   * One gate for the whole app. It resolves the session (sliding its expiry), sends an
   * anonymous visitor to /login or /setup, answers 401 on the JSON API instead of
   * redirecting a program into an HTML page, and checks the CSRF token on anything that
   * changes state. The self-authenticating routes never reach any of it.
   */
  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (path === "/health" || isSelfAuthenticated(path)) return next();
    const origin = originOf(c);
    c.set("origin", origin);
    const authed = auth.validateSession(sessionIdFrom(c), origin);
    if (authed) {
      c.set("auth", authed);
      writeSessionCookie(c, authed.session.id, auth.sessionMaxAgeSeconds);
    }
    /**
     * A recovery session is not a login. It proved a code, which buys exactly one thing:
     * setting a new password. Every other route on this site refuses it, before the
     * public-path shortcut below, so /login cannot be used to walk around the limit
     * either. This is the check that keeps a recovery from being a back door.
     */
    if (authed?.session.scope === "recovery" && !isRecoverySessionPath(path)) {
      throw new AuthError(
        "RECOVERY_SCOPE_LIMITED",
        "Estas en una recuperacion: lo unico que puedes hacer es fijar una contrasena nueva",
        {
          hint: "Termina en /recuperar/nueva-clave y despues entra normalmente en /login.",
        },
      );
    }
    // /login and /setup decide for themselves what an anonymous visitor sees.
    if (isPublicPath(path)) return next();
    if (!authed) {
      if (wantsJson(c)) {
        return c.json(
          {
            error: {
              code: "AUTH_REQUIRED",
              message: "Esta ruta necesita la sesion del dueno",
              hint: "Entra en /login con la cuenta del dueno; el navegador guarda la cookie de sesion.",
            },
          },
          401,
        );
      }
      if (!auth.hasOwner()) return c.redirect("/setup", 302);
      // Landing on the set-a-new-password page with no recovery in flight (an expired
      // one, a bookmark) belongs back at the start of the recovery, not at the login.
      if (path.startsWith("/recuperar")) return c.redirect("/recuperar", 302);
      const back = `${path}${c.req.url.includes("?") ? `?${c.req.url.split("?").slice(1).join("?")}` : ""}`;
      return c.redirect(`/login?next=${encodeURIComponent(back)}`, 302);
    }
    if (isMutating(c.req.method)) {
      auth.requireCsrf(authed.session, await csrfTokenFrom(c), origin);
    }
    return next();
  });

  // --- the way in: setup, login, logout --------------------------------------

  app.get("/setup", (c) => {
    if (auth.hasOwner()) throw setupDone();
    return c.html(setupPage({ network }));
  });

  app.post("/setup", async (c) => {
    if (auth.hasOwner()) throw setupDone();
    const body = await c.req.parseBody();
    const email = asString(body.email);
    try {
      const session = await auth.setup(
        { email, password: asString(body.password), confirm: asString(body.confirm) },
        originIn(c),
      );
      writeSessionCookie(c, session.id, auth.sessionMaxAgeSeconds);
      return c.redirect("/", 303);
    } catch (err) {
      if (!isAuthError(err)) throw err;
      return c.html(
        setupPage({
          network,
          email,
          error: { code: err.code, message: err.message, hint: err.hint },
        }),
        err.status as ContentfulStatusCode,
      );
    }
  });

  app.get("/login", (c) => {
    if (!auth.hasOwner()) return c.redirect("/setup", 302);
    // A recovery session is not signed in, so it gets the form, not the redirect.
    if (c.get("auth")?.session.scope === "full") return c.redirect("/", 302);
    return c.html(
      loginPage({
        network,
        next: safeNext(c.req.query("next")),
        ...(c.req.query("recuperada") === "1"
          ? {
              notice:
                "Contrasena cambiada. Todas las sesiones se cerraron: entra con la nueva. Si generaste codigos de recuperacion, el que usaste ya no sirve.",
            }
          : {}),
      }),
    );
  });

  // No CSRF token here, and none is possible: there is no session yet. The risk a token
  // would cover (someone forcing a login) is empty on a surface with a single account.
  app.post("/login", async (c) => {
    const body = await c.req.parseBody();
    const next = safeNext(asString(body.next));
    try {
      const session = await auth.login(
        { email: asString(body.email), password: asString(body.password) },
        originIn(c),
      );
      // Knowing the password settles it: an abandoned recovery row is dropped rather than
      // left alive for its fifteen minutes next to a real session.
      auth.discardRecoverySession(sessionIdFrom(c));
      writeSessionCookie(c, session.id, auth.sessionMaxAgeSeconds);
      return c.redirect(next, 303);
    } catch (err) {
      if (!isAuthError(err)) throw err;
      const page = loginPage({
        network,
        next,
        error: { code: err.code, message: err.message, hint: err.hint },
      });
      const headers = err.retryAfter ? { "retry-after": String(err.retryAfter) } : {};
      return c.html(page, err.status as ContentfulStatusCode, headers);
    }
  });

  app.post("/logout", (c) => {
    auth.logout(sessionIdFrom(c), originIn(c));
    clearSessionCookie(c);
    return c.redirect("/login", 303);
  });

  // --- the way back in: recovery ---------------------------------------------
  // Three paths, in the order the pages offer them: a printable code (always there, needs
  // no infrastructure), a code over the WhatsApp channel the owner already configured, and
  // a one-time URL printed on the server by whoever can already run commands on it. There
  // is no email reset on purpose: a self-hosted box has no mail server, and a reset that
  // silently needs SMTP is a reset that fails the day it is needed.

  const recoveryError = (err: unknown): { page: string; status: ContentfulStatusCode } | undefined => {
    if (!isAuthError(err)) return undefined;
    return {
      page: recoverPage({
        network,
        whatsapp: auth.whatsappRecoveryAvailable,
        error: { code: err.code, message: err.message, hint: err.hint },
      }),
      status: err.status as ContentfulStatusCode,
    };
  };

  app.get("/recuperar", (c) => {
    if (!auth.hasOwner()) return c.redirect("/setup", 302);
    const authed = c.get("auth");
    if (authed?.session.scope === "recovery") return c.redirect("/recuperar/nueva-clave", 302);
    if (authed) return c.redirect("/cuenta", 302);
    return c.html(recoverPage({ network, whatsapp: auth.whatsappRecoveryAvailable }));
  });

  // No CSRF token here, and none is possible: there is no session yet. Same reasoning as
  // /login, plus a rate limit per address and per account that escalates exactly as the
  // login one does.
  app.post("/recuperar", async (c) => {
    const body = await c.req.parseBody();
    try {
      const session = await auth.startRecovery(
        { email: asString(body.email), code: asString(body.code) },
        originIn(c),
      );
      writeSessionCookie(c, session.id, auth.sessionMaxAgeSeconds);
      return c.redirect("/recuperar/nueva-clave", 303);
    } catch (err) {
      const shaped = recoveryError(err);
      if (!shaped) throw err;
      const headers =
        isAuthError(err) && err.retryAfter ? { "retry-after": String(err.retryAfter) } : {};
      return c.html(shaped.page, shaped.status, headers);
    }
  });

  /**
   * "Send me a code on WhatsApp". The answer is the same page whatever happened: whether
   * the email matched, whether a message went out, whether the last one was 20 seconds
   * ago. Nothing here tells a stranger that this address has an account.
   */
  app.post("/recuperar/whatsapp", async (c) => {
    const body = await c.req.parseBody();
    const email = asString(body.email);
    await auth.requestWhatsAppCode(email, originIn(c));
    return c.html(
      recoverPage({
        network,
        whatsapp: auth.whatsappRecoveryAvailable,
        email,
        notice:
          "Si la cuenta existe, enviamos el codigo al WhatsApp del dueno. Vale 10 minutos y se escribe en el campo de arriba.",
      }),
    );
  });

  // The operator's one-time URL. The GET only shows a confirmation, so a link preview or
  // a crawler cannot burn the token; the POST spends it.
  app.get("/recuperar/operador", (c) => {
    const token = c.req.query("t") ?? "";
    return c.html(operatorRecoveryPage({ network, token }));
  });

  app.post("/recuperar/operador", async (c) => {
    const body = await c.req.parseBody();
    try {
      const session = await auth.startRecoveryWithOperatorToken(
        asString(body.token),
        originIn(c),
      );
      writeSessionCookie(c, session.id, auth.sessionMaxAgeSeconds);
      return c.redirect("/recuperar/nueva-clave", 303);
    } catch (err) {
      const shaped = recoveryError(err);
      if (!shaped) throw err;
      const headers =
        isAuthError(err) && err.retryAfter ? { "retry-after": String(err.retryAfter) } : {};
      return c.html(shaped.page, shaped.status, headers);
    }
  });

  app.get("/recuperar/nueva-clave", (c) => {
    const { session } = sessionOf(c);
    return c.html(newPasswordPage({ network, csrf: session.csrfToken }));
  });

  app.post("/recuperar/nueva-clave", async (c) => {
    const { session } = sessionOf(c);
    const body = await c.req.parseBody();
    try {
      await auth.completeRecovery(
        { password: asString(body.password), confirm: asString(body.confirm) },
        session,
        originIn(c),
      );
    } catch (err) {
      if (!isAuthError(err)) throw err;
      return c.html(
        newPasswordPage({
          network,
          csrf: session.csrfToken,
          error: { code: err.code, message: err.message, hint: err.hint },
        }),
        err.status as ContentfulStatusCode,
      );
    }
    // Every session died with the password, this one included: the cookie is worthless.
    clearSessionCookie(c);
    return c.redirect("/login?recuperada=1", 303);
  });

  // --- the account page ------------------------------------------------------

  app.get("/cuenta", (c) => {
    const session = viewOf(c);
    return c.html(
      accountPage({
        network,
        session,
        pendingCount: pendingCount(),
        codes: auth.recoveryCodes(),
        whatsapp: auth.whatsappRecoveryAvailable,
        ...(c.req.query("saved") === "1" ? { saved: true } : {}),
      }),
    );
  });

  app.post("/cuenta/clave", async (c) => {
    const { session } = sessionOf(c);
    const body = await c.req.parseBody();
    try {
      await auth.changePassword(
        {
          current: asString(body.current),
          password: asString(body.password),
          confirm: asString(body.confirm),
        },
        session,
        originIn(c),
      );
    } catch (err) {
      if (!isAuthError(err)) throw err;
      return c.html(
        accountPage({
          network,
          session: viewOf(c),
          pendingCount: pendingCount(),
          codes: auth.recoveryCodes(),
          whatsapp: auth.whatsappRecoveryAvailable,
          error: { code: err.code, message: err.message, hint: err.hint },
        }),
        err.status as ContentfulStatusCode,
      );
    }
    return c.redirect("/cuenta?saved=1", 303);
  });

  app.post("/cuenta/codigos", async (c) => {
    const session = viewOf(c);
    const codes = await auth.generateRecoveryCodes(originIn(c));
    // The only time these strings exist outside the owner's hands. Storage has hashes.
    return c.html(
      recoveryCodesPage({ network, codes, session, pendingCount: pendingCount() }),
    );
  });

  app.post("/cuenta/recordatorio", async (c) => {
    const { session } = sessionOf(c);
    auth.dismissCodeReminder(session.id);
    const body = await c.req.parseBody();
    return c.redirect(safeNext(asString(body.next)), 303);
  });

  // --- pages ---------------------------------------------------------------

  app.get("/", async (c) => {
    const values = marketFormValues(c);
    const asked = values.what.length > 0 || values.attributes.some((a) => a.trim().length > 0);
    let market: MarketSearch | undefined;
    if (asked) {
      try {
        market = { values, result: await service.marketCall(marketCallInput(values)) };
      } catch (err) {
        if (!isAgentPOSError(err)) throw err;
        market = { values, error: { code: err.code, message: err.message, hint: err.hint } };
      }
    }
    const reminder = reminderFor(c, "/");
    const page = homePage({
      values: formValues(service.getProfile()),
      network,
      status: service.status(),
      channels,
      session: viewOf(c),
      ...(market ? { market } : {}),
      ...(c.req.query("saved") === "1" ? { saved: true } : {}),
      ...(reminder ? { reminder } : {}),
    });
    // A refused market call answers with its own status, so a caller (or a crawler) is not
    // told a malformed request went fine. The page still shows the form, filled as typed.
    const failed = market?.error;
    return failed ? c.html(page, STATUS_BY_CODE[failed.code as ErrorCode] ?? 500) : c.html(page);
  });

  app.post("/profile", async (c) => {
    const body = await c.req.parseBody();
    const input = {
      maxPerTx: asString(body.maxPerTx),
      maxTotal: asString(body.maxTotal),
      period: asString(body.period) || "day",
      stores: asString(body.stores)
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
      allowPhysicalGoods: body.allowPhysicalGoods !== undefined,
      email: asString(body.email),
      shipping: {
        name: asString(body.shipName),
        line1: asString(body.shipLine1),
        line2: asString(body.shipLine2),
        city: asString(body.shipCity),
        region: asString(body.shipRegion),
        postalCode: asString(body.shipPostalCode),
        country: asString(body.shipCountry),
        phone: asString(body.shipPhone),
      },
      walletAddress: asString(body.walletAddress),
    };
    try {
      service.saveProfile(input);
    } catch (err) {
      if (isAgentPOSError(err)) {
        // Re-render the form with what the user typed, so nothing is lost.
        return c.html(
          homePage({
            values: {
              ...input,
              stores: input.stores.join("\n"),
              period: input.period,
            },
            network,
            status: service.status(),
            channels,
            session: viewOf(c),
            error: { code: err.code, message: err.message, hint: err.hint },
          }),
          STATUS_BY_CODE[err.code] ?? 500,
        );
      }
      throw err;
    }
    return c.redirect("/?saved=1", 303);
  });

  /**
   * Does approving this proposal ask for the password again? Above the mandate's
   * `requireConfirmAboveUsdc`, yes; and when no threshold is set, every amount does. A
   * mandate that never asks is a decision the owner has to make on purpose, not a default.
   */
  const needsReauth = (p: Proposal): boolean => {
    const threshold = service.getProfile()?.mandate.requireConfirmAboveUsdc;
    if (threshold === undefined) return true;
    return compareUsdc(usdcFromMinor(p.amountMinor), usdc(threshold)) >= 0;
  };

  /** Renders /proposals, optionally with a refused re-authentication on one card. */
  const proposalsHtml = (
    c: Context<BuyerWebEnv>,
    extra: { highlight?: string; reauthError?: { proposalId: string; message: string } } = {},
  ): string => {
    const shipping = service.status().shipping;
    const reminder = reminderFor(c, "/proposals");
    return proposalsPage({
      pending: service.pendingProposals(),
      approved: service.approvedProposals(),
      paid: service.paidProposals(),
      stores: service.getProfile()?.stores ?? [],
      network,
      ...(shipping ? { shipping } : {}),
      signerConfigured: channels.signer,
      instructionsFor: (p) => service.instructionsFor(p),
      session: viewOf(c),
      needsReauth,
      ...(extra.highlight ? { highlight: extra.highlight } : {}),
      ...(extra.reauthError ? { reauthError: extra.reauthError } : {}),
      ...(reminder ? { reminder } : {}),
    });
  };

  app.get("/proposals", (c) => {
    const highlight = c.req.query("approved");
    return c.html(proposalsHtml(c, highlight ? { highlight } : {}));
  });

  app.post("/proposals", async (c) => {
    const body = await c.req.parseBody();
    const parsed = proposeSchema.safeParse({
      storeUrl: asString(body.storeUrl),
      itemId: asString(body.itemId),
      quantity: asString(body.quantity) || "1",
    });
    if (!parsed.success) {
      throw new AgentPOSError("CONFIG_INVALID", "Invalid proposal form", {
        hint: "Pick a store, an item id and a quantity between 1 and 999.",
      });
    }
    await service.propose(parsed.data.itemId, parsed.data.storeUrl, parsed.data.quantity);
    return c.redirect("/proposals", 303);
  });

  /**
   * The password check that stands between a pending proposal and the payment queue.
   * Returns the typed refusal instead of throwing, so the page can put it on the card the
   * owner was looking at. `undefined` means the approval may go ahead.
   */
  const checkReauth = async (
    c: Context<BuyerWebEnv>,
    proposal: Proposal,
    password: string,
  ): Promise<AuthError | undefined> => {
    if (!needsReauth(proposal)) return undefined;
    if (password.length === 0) {
      return new AuthError(
        "REAUTH_REQUIRED",
        `Escribe tu contrasena para aprobar ${proposal.amount} ${proposal.asset} en ${proposal.storeName}.`,
        { hint: "Aprobar un pago pide la contrasena de nuevo, aunque la sesion siga abierta." },
      );
    }
    if (await auth.verifyOwnerPassword(password)) return undefined;
    auth.noteReauthFailed(
      originIn(c),
      `${proposal.amount} ${proposal.asset} en ${proposal.storeName}`,
    );
    return new AuthError("REAUTH_FAILED", "Contrasena incorrecta: la propuesta sigue pendiente.", {
      hint: "Vuelve a escribirla. Nada se aprobo y nada se cobro.",
    });
  };

  app.post("/proposals/:id/approve", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    // An unknown id falls through to service.approve, which answers the typed 404.
    const pending = service.getProposal(id);
    if (pending) {
      const refusal = await checkReauth(c, pending, asString(body.password));
      if (refusal) {
        return c.html(
          proposalsHtml(c, { reauthError: { proposalId: id, message: refusal.message } }),
          refusal.status as ContentfulStatusCode,
        );
      }
    }
    const { proposal } = service.approve(id);
    auth.noteApproval(
      originIn(c),
      `${proposal.amount} ${proposal.asset} en ${proposal.storeName}`,
    );
    return c.redirect(`/proposals?approved=${encodeURIComponent(proposal.id)}`, 303);
  });

  app.post("/proposals/:id/reject", (c) => {
    service.reject(c.req.param("id"));
    return c.redirect("/proposals", 303);
  });

  app.get("/activity", (c) => {
    const reminder = reminderFor(c, "/activity");
    return c.html(
      activityPage({
        activity: service.activity(),
        proposals: service.proposalHistory(),
        status: service.status(),
        network,
        session: viewOf(c),
        access: auth.access(),
        ...(reminder ? { reminder } : {}),
      }),
    );
  });

  // --- JSON API (what a messaging channel will call) -----------------------

  app.get("/health", (c) => c.json({ ok: true, network }));

  app.get("/api/status", (c) => c.json(service.status()));

  app.get("/api/offers", async (c) => {
    const offers = await service.searchOffers(c.req.query("q") ?? "");
    return c.json({ offers });
  });

  // The market call, same parameters as the home form (`q`, repeatable `attr`, `max`, `qty`,
  // `physical`), so a messaging channel asks exactly what the page asks.
  app.get("/api/market", async (c) =>
    c.json(await service.marketCall(marketCallInput(marketFormValues(c)))),
  );

  app.post("/api/proposals", async (c) => {
    const parsed = proposeSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      throw new AgentPOSError("CONFIG_INVALID", "Invalid proposal request", {
        hint: "Send JSON { storeUrl, itemId, quantity? }.",
        details: { issues: parsed.error.issues.map((i) => i.message) },
      });
    }
    const proposal = await service.propose(
      parsed.data.itemId,
      parsed.data.storeUrl,
      parsed.data.quantity,
    );
    return c.json({ proposal }, 201);
  });

  app.get("/api/proposals", (c) => c.json({ proposals: service.proposalHistory() }));

  // Same rule as the page: the session is not enough to approve a payment, the password is
  // asked again. The API takes it as `password` in the JSON body.
  app.post("/api/proposals/:id/approve", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { password?: unknown };
    const pending = service.getProposal(id);
    if (pending) {
      const refusal = await checkReauth(
        c,
        pending,
        typeof body.password === "string" ? body.password : "",
      );
      if (refusal) throw refusal;
    }
    const result = service.approve(id);
    auth.noteApproval(
      originIn(c),
      `${result.proposal.amount} ${result.proposal.asset} en ${result.proposal.storeName}`,
    );
    return c.json(result);
  });

  app.post("/api/proposals/:id/reject", (c) =>
    c.json({ proposal: service.reject(c.req.param("id")) }),
  );

  // --- signing bridge (mounted only when SIGNER_TOKEN is configured) --------
  // These endpoints exist for exactly one client: the buyer's OWN signer daemon
  // (`agentpos-buyer watch`) running on the machine that holds the wallet key. The
  // bearer token authorizes that daemon, nothing else; it cannot approve proposals,
  // and this server still cannot sign anything.

  if (deps.signerToken !== undefined) {
    const signerToken = deps.signerToken;
    app.use("/api/signer/*", async (c, next) => {
      const header = c.req.header("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
      if (token.length === 0 || !timingSafeEqualStrings(signerToken, token)) {
        return c.json(
          {
            error: {
              code: "APPROVAL_UNAUTHORIZED",
              message: "Signer token missing or wrong",
              hint: "Send `Authorization: Bearer <SIGNER_TOKEN>`; the daemon reads it from AGENTPOS_SIGNER_TOKEN.",
            },
          },
          401,
        );
      }
      await next();
    });

    app.get("/api/signer/queue", (c) => c.json({ proposals: service.signerQueue() }));

    const paidSchema = z.object({
      proposalId: z.string().min(1),
      txHash: z.string().min(1),
      orderId: z.string().min(1),
    });
    app.post("/api/signer/paid", async (c) => {
      const parsed = paidSchema.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) {
        throw new AgentPOSError("CONFIG_INVALID", "Invalid paid report", {
          hint: "Send JSON { proposalId, txHash, orderId }.",
          details: { issues: parsed.error.issues.map((i) => i.message) },
        });
      }
      const { proposalId, txHash, orderId } = parsed.data;
      return c.json({ proposal: service.markPaid(proposalId, { txHash, orderId }) });
    });

    const failedSchema = z.object({
      proposalId: z.string().min(1),
      code: z.string().min(1).max(64),
      message: z.string().min(1).max(500),
    });
    app.post("/api/signer/failed", async (c) => {
      const parsed = failedSchema.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) {
        throw new AgentPOSError("CONFIG_INVALID", "Invalid failure report", {
          hint: "Send JSON { proposalId, code, message }.",
          details: { issues: parsed.error.issues.map((i) => i.message) },
        });
      }
      const { proposalId, code, message } = parsed.data;
      return c.json({ proposal: service.markPaymentFailed(proposalId, { code, message }) });
    });
  }

  // --- WhatsApp channel (mounted only when configured) ----------------------

  if (deps.whatsapp) {
    const conversation = new ConversationHandler({
      service,
      allowedNumbers: deps.whatsapp.allowedNumbers,
      log,
    });
    if (deps.whatsapp.meta && whatsappTransports.meta) {
      const hooks = createMetaWebhook({
        config: deps.whatsapp.meta,
        conversation,
        transport: whatsappTransports.meta,
        log,
      });
      app.get("/whatsapp/meta", hooks.get);
      app.post("/whatsapp/meta", hooks.post);
    }
    if (deps.whatsapp.twilio && whatsappTransports.twilio) {
      const hooks = createTwilioWebhook({
        config: deps.whatsapp.twilio,
        conversation,
        transport: whatsappTransports.twilio,
        log,
      });
      app.post("/whatsapp/twilio", hooks.post);
    }
  }

  // --- errors ----------------------------------------------------------------

  app.onError((err, c) => {
    // Access refusals answer with their own codes: they are not commerce errors and an
    // agent (or a human) should be able to tell "you are not allowed" from "the cart died".
    if (isAuthError(err)) {
      const headers = err.retryAfter ? { "retry-after": String(err.retryAfter) } : {};
      const status = err.status as ContentfulStatusCode;
      if (wantsJson(c)) {
        return c.json(
          { error: { code: err.code, message: err.message, hint: err.hint } },
          status,
          headers,
        );
      }
      // A recovery session is not a login, so the error page must not paint the chrome of
      // one: no tabs, no email, no logout form. It gets pointed back at its one page.
      const recovering = c.get("auth")?.session.scope === "recovery";
      const authed = recovering ? undefined : c.get("auth");
      return c.html(
        errorPage({
          network,
          pendingCount: authed ? pendingCount() : 0,
          code: err.code,
          message: err.message,
          hint: err.hint,
          backHref: recovering ? "/recuperar/nueva-clave" : authed ? "/proposals" : "/login",
          backLabel: recovering
            ? "Volver a elegir tu contrasena"
            : authed
              ? "Volver a propuestas"
              : "Volver a entrar",
          ...(authed
            ? { session: { email: authed.account.email, csrf: authed.session.csrfToken } }
            : {}),
        }),
        status,
        headers,
      );
    }
    const shaped = isAgentPOSError(err)
      ? err
      : new AgentPOSError("INTERNAL", "Unexpected error", {
          hint: "Check the server logs; nothing was charged.",
          cause: err,
        });
    const status = STATUS_BY_CODE[shaped.code] ?? 500;
    if (wantsJson(c)) {
      return c.json(
        { error: { code: shaped.code, message: shaped.message, hint: shaped.hint } },
        status,
      );
    }
    const full = c.get("auth");
    const authed = full?.session.scope === "recovery" ? undefined : full;
    return c.html(
      errorPage({
        network,
        pendingCount: pendingCount(),
        code: shaped.code,
        message: shaped.message,
        hint: shaped.hint,
        backHref: "/proposals",
        ...(authed
          ? { session: { email: authed.account.email, csrf: authed.session.csrfToken } }
          : {}),
      }),
      status,
    );
  });

  return { app, fetch: (request: Request) => app.fetch(request), service, auth };
}
