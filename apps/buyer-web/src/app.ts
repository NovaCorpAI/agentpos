/**
 * HTTP surface: three server-rendered pages for the human (/, /proposals, /activity) and a
 * JSON API under /api that mirrors the service one-to-one, so tests and future channels
 * (WhatsApp bridge, mobile) exercise exactly what the pages use.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { AgentPOSError, isAgentPOSError } from "@agentpos/core";
import type { ErrorCode } from "@agentpos/core";
import { BuyerWebService } from "./service.js";
import type { BuyerWebStorage } from "./storage.js";
import { activityPage, errorPage, mandatePage, proposalsPage } from "./pages.js";
import type { MandateFormValues } from "./pages.js";
import type { BuyerWebProfile } from "./types.js";
import type { WhatsAppConfig } from "./config.js";
import { ConversationHandler } from "./whatsapp/conversation.js";
import { MetaTransport, createMetaWebhook } from "./whatsapp/meta.js";
import { TwilioTransport, createTwilioWebhook } from "./whatsapp/twilio.js";
import type { WhatsAppLogger, WhatsAppTransport } from "./whatsapp/types.js";

export interface BuyerWebAppDeps {
  storage: BuyerWebStorage;
  network?: "testnet" | "mainnet";
  /** Tests inject the in-process store; production uses global fetch. */
  fetchImpl?: typeof globalThis.fetch;
  /** WhatsApp channel; routes are mounted only when this is present. */
  whatsapp?: WhatsAppConfig;
  /** Tests inject fake transports; production builds Meta/Twilio transports from config. */
  whatsappTransports?: { meta?: WhatsAppTransport; twilio?: WhatsAppTransport };
  /** Structured event log for the WhatsApp channel. Event codes and sender hashes only. */
  log?: WhatsAppLogger;
}

export interface BuyerWebApp {
  app: Hono;
  fetch: (request: Request) => Response | Promise<Response>;
  service: BuyerWebService;
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
  return {
    maxPerTx: profile?.mandate.maxPerTx ?? "10",
    maxTotal: profile?.mandate.maxTotal ?? "50",
    period: profile?.mandate.period ?? "day",
    stores: (profile?.stores ?? []).join("\n"),
    allowPhysicalGoods: profile?.mandate.allowPhysicalGoods ?? false,
    email: profile?.email ?? "",
    walletAddress: profile?.walletAddress ?? "",
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function createBuyerWebApp(deps: BuyerWebAppDeps): BuyerWebApp {
  const network = deps.network ?? "testnet";
  const service = new BuyerWebService({
    storage: deps.storage,
    network,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const app = new Hono();

  const pendingCount = () => service.pendingProposals().length;

  // --- pages ---------------------------------------------------------------

  app.get("/", (c) => {
    return c.html(
      mandatePage({
        values: formValues(service.getProfile()),
        network,
        pendingCount: pendingCount(),
        ...(c.req.query("saved") === "1" ? { saved: true } : {}),
      }),
    );
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
      walletAddress: asString(body.walletAddress),
    };
    try {
      service.saveProfile(input);
    } catch (err) {
      if (isAgentPOSError(err)) {
        // Re-render the form with what the user typed, so nothing is lost.
        return c.html(
          mandatePage({
            values: {
              ...input,
              stores: input.stores.join("\n"),
              period: input.period,
            },
            network,
            pendingCount: pendingCount(),
            error: { code: err.code, message: err.message, hint: err.hint },
          }),
          STATUS_BY_CODE[err.code] ?? 500,
        );
      }
      throw err;
    }
    return c.redirect("/?saved=1", 303);
  });

  app.get("/proposals", (c) => {
    const highlight = c.req.query("approved");
    return c.html(
      proposalsPage({
        pending: service.pendingProposals(),
        approved: service.approvedProposals(),
        stores: service.getProfile()?.stores ?? [],
        network,
        instructionsFor: (p) => service.instructionsFor(p),
        ...(highlight ? { highlight } : {}),
      }),
    );
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

  app.post("/proposals/:id/approve", (c) => {
    const { proposal } = service.approve(c.req.param("id"));
    return c.redirect(`/proposals?approved=${encodeURIComponent(proposal.id)}`, 303);
  });

  app.post("/proposals/:id/reject", (c) => {
    service.reject(c.req.param("id"));
    return c.redirect("/proposals", 303);
  });

  app.get("/activity", (c) => {
    return c.html(
      activityPage({
        activity: service.activity(),
        proposals: service.proposalHistory(),
        status: service.status(),
        network,
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

  app.post("/api/proposals/:id/approve", (c) => c.json(service.approve(c.req.param("id"))));

  app.post("/api/proposals/:id/reject", (c) =>
    c.json({ proposal: service.reject(c.req.param("id")) }),
  );

  // --- WhatsApp channel (mounted only when configured) ----------------------

  if (deps.whatsapp) {
    const log: WhatsAppLogger =
      deps.log ??
      ((event, data) =>
        console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data })));
    const conversation = new ConversationHandler({
      service,
      allowedNumbers: deps.whatsapp.allowedNumbers,
      log,
    });
    if (deps.whatsapp.meta) {
      const hooks = createMetaWebhook({
        config: deps.whatsapp.meta,
        conversation,
        transport: deps.whatsappTransports?.meta ?? new MetaTransport(deps.whatsapp.meta),
        log,
      });
      app.get("/whatsapp/meta", hooks.get);
      app.post("/whatsapp/meta", hooks.post);
    }
    if (deps.whatsapp.twilio) {
      const hooks = createTwilioWebhook({
        config: deps.whatsapp.twilio,
        conversation,
        transport: deps.whatsappTransports?.twilio ?? new TwilioTransport(deps.whatsapp.twilio),
        log,
      });
      app.post("/whatsapp/twilio", hooks.post);
    }
  }

  // --- errors ----------------------------------------------------------------

  const wantsJson = (c: Context) =>
    c.req.path.startsWith("/api/") || c.req.header("accept")?.includes("application/json");

  app.onError((err, c) => {
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
    return c.html(
      errorPage({
        network,
        pendingCount: pendingCount(),
        code: shaped.code,
        message: shaped.message,
        hint: shaped.hint,
        backHref: "/proposals",
      }),
      status,
    );
  });

  return { app, fetch: (request: Request) => app.fetch(request), service };
}
