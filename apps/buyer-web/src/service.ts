/**
 * Channel-agnostic buyer service: the web pages call it, and a future messaging channel
 * (WhatsApp) will call EXACTLY these functions. Nothing here knows about HTTP or HTML.
 *
 * Flow: searchOffers -> propose (quote frozen, human notified) -> approve | reject.
 * approve() marks the proposal approved and returns payment instructions; it does NOT pay.
 * This process holds no key and cannot pay. The buyer pays from their own machine
 * (agentpos-buyer CLI, or its `watch` signing bridge) where the local signer lives; the
 * bridge then reports the settled txHash back through markPaid()/markPaymentFailed().
 */
import { randomUUID } from "node:crypto";
import { AgentPOSError, addUsdc, formatUsdc, usdcFromMinor } from "@agentpos/core";
import type { Address, Logger, UsdcMinor } from "@agentpos/core";
import { annotateMandate, BuyerService, evaluateMandate, periodStart } from "@agentpos/mcp-buyer";
import type { MarketCallResult, Offer, Profile } from "@agentpos/mcp-buyer";
import type { BuyerWebStorage } from "./storage.js";
import { buyerWebProfileSchema } from "./types.js";
import type {
  ApprovalResult,
  BuyerWebProfile,
  PaymentInstructions,
  Proposal,
  ServiceStatus,
  SignerQueueItem,
} from "./types.js";

/**
 * Satisfies the mcp-buyer Profile shape when no wallet is linked yet. Format-only: it is
 * never funded, never published and never signs; buyer-web never calls BuyerService.buy().
 */
const PLACEHOLDER_ADDRESS = `G${"A".repeat(55)}`;

/**
 * Custody rule, structurally: buyer-web builds a BuyerService with a key file that does not
 * exist and no passphrase, so even a future bug that reached the signing path would fail with
 * "Wallet is locked" before touching any file.
 */
const NO_KEY_FILE = "buyer-web-never-has-a-key";

/** The shipping address as the form sends it: every field a (possibly empty) string. */
export interface ShippingInput {
  name?: string;
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  phone?: string;
}

export interface SaveProfileInput {
  /** Decimal USDC, e.g. "25" or "9.5". */
  maxPerTx: string;
  maxTotal: string;
  period?: string;
  /** Store URLs the agent may buy from; empty means any store. */
  stores?: string[];
  allowPhysicalGoods?: boolean;
  email?: string;
  /**
   * Where physical orders ship. Required (complete) whenever `allowPhysicalGoods` is on:
   * a store refuses a physical cart without it, and the human must learn that here and not
   * at payment time. Omitted or all-blank keeps whatever address was already on file.
   */
  shipping?: ShippingInput;
  /** Public wallet address (G...). A secret (S...) is refused loudly. */
  walletAddress?: string;
}

/** A market call as the form (or a messaging channel) sends it. */
export interface MarketCallInput {
  /** What the human is looking for, in their own words. */
  what: string;
  /** Exact attribute filters, e.g. `{ Fondo: "blanco" }`. Names vary by store. */
  attributes?: Record<string, string>;
  /** Decimal USDC ceiling and floor on the UNIT price. Empty strings mean "no bound". */
  maxPriceUsdc?: string;
  minPriceUsdc?: string;
  physical?: boolean;
  quantity?: number;
}

/**
 * `clave=valor` rows, as typed by a human, into attribute filters. Blank rows are ignored
 * (the form always posts its empty rows); a row with something in it but no `=` is refused,
 * because silently dropping it would answer a question nobody asked.
 */
export function parseAttributePairs(rows: string[]): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const row of rows) {
    const text = row.trim();
    if (text.length === 0) continue;
    const index = text.indexOf("=");
    const name = index > 0 ? text.slice(0, index).trim() : "";
    const value = index > 0 ? text.slice(index + 1).trim() : "";
    if (name.length === 0 || value.length === 0) {
      throw new AgentPOSError("CONFIG_INVALID", `Filtro inválido: '${text.slice(0, 40)}'`, {
        hint: "Escribe cada filtro como clave=valor, por ejemplo Fondo=blanco. Deja la fila vacía si no quieres filtrar.",
        details: { pair: text.slice(0, 40) },
      });
    }
    attributes[name] = value;
  }
  return attributes;
}

export interface BuyerWebServiceDeps {
  storage: BuyerWebStorage;
  network?: "testnet" | "mainnet";
  /** Tests inject the in-process store; production uses global fetch. */
  fetchImpl?: typeof globalThis.fetch;
  now?: () => Date;
  /** Structured event log. Nothing written here may carry a full postal address. */
  logger?: Logger;
}

/**
 * The address fields a store cannot ship without, in form order, each with the reason it is
 * needed. The reason is shown to the human verbatim, so it says what the store cannot do.
 */
const REQUIRED_SHIPPING_FIELDS = [
  {
    key: "name",
    what: "el nombre de quien recibe",
    why: "saber a nombre de quien va el paquete",
  },
  { key: "line1", what: "la dirección (línea 1)", why: "una calle y un número" },
  { key: "city", what: "la ciudad", why: "la ciudad de destino" },
  { key: "postalCode", what: "el código postal", why: "el código postal" },
  { key: "country", what: "el país", why: "el país de destino" },
] as const;

/** The two ways out, spelled the same everywhere the human meets this refusal. */
const HINT_PHYSICAL_ON =
  "Completa la dirección de despacho en el mandato, o desactiva 'Permitir bienes físicos' si solo compras cosas digitales.";
const HINT_PHYSICAL_OFF =
  "Completa el campo que falta o deja toda la dirección de despacho vacía: con bienes físicos desactivados no hace falta.";

/** Trimmed form values, country normalized to uppercase ISO-2 as stores expect it. */
type TrimmedShipping = Record<keyof ShippingInput, string>;

function trimShipping(input: ShippingInput | undefined): TrimmedShipping {
  const t = (v: string | undefined) => (v ?? "").trim();
  return {
    name: t(input?.name),
    line1: t(input?.line1),
    line2: t(input?.line2),
    city: t(input?.city),
    region: t(input?.region),
    postalCode: t(input?.postalCode),
    country: t(input?.country).toUpperCase(),
    phone: t(input?.phone),
  };
}

export class BuyerWebService {
  private readonly storage: BuyerWebStorage;
  private readonly network: "testnet" | "mainnet";
  private readonly fetchImpl: typeof globalThis.fetch | undefined;
  private readonly now: () => Date;
  private readonly logger: Logger | undefined;
  /** Last set of proposal ids handed to the signer, to log queue deliveries without spamming. */
  private lastQueueKey = "";

  constructor(deps: BuyerWebServiceDeps) {
    this.storage = deps.storage;
    this.network = deps.network ?? "testnet";
    this.fetchImpl = deps.fetchImpl;
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger;
  }

  // --- profile / mandate -----------------------------------------------------

  getProfile(): BuyerWebProfile | undefined {
    return this.storage.getProfile();
  }

  saveProfile(input: SaveProfileInput): BuyerWebProfile {
    const wallet = input.walletAddress?.trim();
    if (wallet && wallet.startsWith("S")) {
      throw new AgentPOSError("SECRET_IN_CONFIG", "Eso parece una llave SECRETA, no una dirección", {
        hint: "Esta plataforma guarda solo direcciones públicas (empiezan con G). Deja la llave secreta en tu propia máquina; nunca la pegues en un sitio web, ni siquiera en este.",
      });
    }
    const stores = (input.stores ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
    const hosts: string[] = [];
    for (const url of stores) {
      try {
        hosts.push(new URL(url).host);
      } catch {
        throw new AgentPOSError("CONFIG_INVALID", `'${url}' no es una URL de tienda válida`, {
          hint: "Escribe URLs completas, una por línea, por ejemplo https://tienda.ejemplo",
        });
      }
    }
    const allowPhysicalGoods = input.allowPhysicalGoods ?? false;
    const email = input.email?.trim() ?? "";
    // Authoritative: the browser hides the section, the server decides. A mandate that allows
    // physical goods without a usable address is exactly the state that fails at payment.
    const shipping = this.resolveShipping(
      input.shipping,
      allowPhysicalGoods,
      this.storage.getProfile()?.shipping,
    );
    if (allowPhysicalGoods && email.length === 0) {
      throw new AgentPOSError(
        "SHIPPING_REQUIRED",
        "Falta tu correo de contacto: la tienda no puede despachar sin un correo donde avisarte de la orden.",
        { hint: HINT_PHYSICAL_ON },
      );
    }
    const parsed = buyerWebProfileSchema.safeParse({
      id: "default",
      network: this.network,
      stores,
      mandate: {
        maxPerTx: input.maxPerTx.trim(),
        maxTotal: input.maxTotal.trim(),
        period: input.period ?? "day",
        // The store list IS the seller allowlist; an empty list means any store.
        allowedSellers: hosts.length > 0 ? hosts : "any",
        allowPhysicalGoods,
        shippingAddressLocked: true,
      },
      ...(email ? { email } : {}),
      ...(shipping ? { shipping } : {}),
      ...(wallet ? { walletAddress: wallet } : {}),
      updatedAt: this.now().toISOString(),
    });
    if (!parsed.success) {
      throw new AgentPOSError("CONFIG_INVALID", "The mandate is invalid", {
        hint: "Amounts are decimal USDC with up to 7 decimals (e.g. 25 or 9.5); the wallet address starts with G.",
        details: {
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
      });
    }
    this.storage.saveProfile(parsed.data);
    this.storage.appendActivity(
      "profile.saved",
      {
        maxPerTx: parsed.data.mandate.maxPerTx,
        maxTotal: parsed.data.mandate.maxTotal,
        period: parsed.data.mandate.period,
        stores: parsed.data.stores,
        walletLinked: parsed.data.walletAddress !== undefined,
        // Presence only: the history a buyer shares must not carry their home address.
        shippingOnFile: parsed.data.shipping !== undefined,
      },
      this.now().toISOString(),
    );
    this.logger?.info("buyer_web.profile_saved", {
      allowPhysicalGoods: parsed.data.mandate.allowPhysicalGoods,
      walletLinked: parsed.data.walletAddress !== undefined,
      ...this.shippingLogFields(parsed.data.shipping),
    });
    return parsed.data;
  }

  // --- offers ----------------------------------------------------------------

  async searchOffers(query: string): Promise<Offer[]> {
    const profile = this.requireProfile();
    const offers = await this.buyerFor(profile).searchOffers(query);
    this.storage.appendActivity(
      "search",
      { query, results: offers.length },
      this.now().toISOString(),
    );
    return offers;
  }

  /**
   * Market call: the same request asked of every store in the mandate at once, answered with
   * comparable offers, who did not answer, and the attribute values to refine with.
   *
   * The payability labels are recomputed here against what THIS platform can account for: the
   * proposals the human already approved this period. The buyer's own machine keeps the
   * payment log; buyer-web only knows what it was asked to approve, and says so honestly.
   */
  async marketCall(input: MarketCallInput): Promise<MarketCallResult> {
    const profile = this.requireProfile();
    const result = await this.buyerFor(profile).marketCall({
      what: input.what,
      ...(input.attributes && Object.keys(input.attributes).length > 0
        ? { attributes: input.attributes }
        : {}),
      ...(input.maxPriceUsdc ? { maxPriceUsdc: input.maxPriceUsdc } : {}),
      ...(input.minPriceUsdc ? { minPriceUsdc: input.minPriceUsdc } : {}),
      ...(input.physical !== undefined ? { physical: input.physical } : {}),
      ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
    });
    const context = {
      mandate: profile.mandate,
      spentInPeriod: this.approvedInPeriod(profile),
    };
    const answer: MarketCallResult = {
      ...result,
      offers: result.offers.map((offer) => ({
        ...offer,
        mandate: annotateMandate(context, {
          totalMinor: usdcFromMinor(offer.totalMinor),
          host: offer.store.host,
          physical: offer.physical,
        }),
      })),
    };
    this.storage.appendActivity(
      "search",
      {
        query: input.what,
        results: answer.offers.length,
        stores: answer.stores.length,
        answered: answer.stores.filter((s) => s.state === "ok" || s.state === "unsupported-filters")
          .length,
      },
      this.now().toISOString(),
    );
    return answer;
  }

  // --- proposals -------------------------------------------------------------

  /**
   * Quote the purchase against the store (a real cart, a real price) and park it as a
   * pending proposal for the human. The mandate is evaluated NOW, before the human is
   * bothered: a proposal that could never be paid is refused, not queued.
   */
  async propose(itemId: string, storeUrl: string, quantity = 1): Promise<Proposal> {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      throw new AgentPOSError("CONFIG_INVALID", `Invalid quantity ${quantity}`, {
        hint: "Use an integer between 1 and 999.",
      });
    }
    const profile = this.requireProfile();
    const buyer = this.buyerFor(profile);
    const client = buyer.site(storeUrl);
    const info = await client.info();
    // A physical item the store could never ship is refused BEFORE the cart exists, so the
    // human reads why here instead of watching the payment fail later. The extra lookup only
    // happens when the profile is not ready to receive a parcel.
    const gap = this.shippingGap(profile);
    if (gap) {
      const item = await client.item(itemId);
      if (item.physical) throw gap;
    }
    const cart = await buyer.createCart(storeUrl, [{ itemId, quantity }]);
    const amount = usdcFromMinor(cart.quote.totalMinor);
    const hasPhysical = cart.quote.lines.some((l) => l.physical);
    const verdict = evaluateMandate(profile.mandate, {
      amount,
      siteHost: client.host,
      hasPhysicalItems: hasPhysical,
      spentInPeriod: this.approvedInPeriod(profile),
      // Approving the proposal IS the human confirmation this platform exists for, so a
      // CONFIRMATION_REQUIRED verdict is not an obstacle here: everything gets confirmed.
      humanApproved: true,
    });
    if (!verdict.ok) {
      throw new AgentPOSError(verdict.code, verdict.message, {
        hint: verdict.hint,
        details: verdict.details,
      });
    }
    const proposal: Proposal = {
      id: randomUUID(),
      status: "pending",
      storeUrl: client.url,
      storeName: info.name,
      itemId,
      title: cart.quote.lines.map((l) => `${l.quantity} x ${l.title}`).join(", "),
      quantity,
      amount: cart.quote.total,
      amountMinor: cart.quote.totalMinor,
      asset: cart.quote.asset,
      network: cart.quote.network,
      cartId: cart.cartId,
      checkoutUrl: cart.checkout,
      physical: hasPhysical,
      cartExpiresAt: cart.expiresAt,
      createdAt: this.now().toISOString(),
    };
    this.storage.saveProposal(proposal);
    this.storage.appendActivity(
      "proposal.created",
      {
        proposalId: proposal.id,
        store: proposal.storeUrl,
        title: proposal.title,
        amount: proposal.amount,
        asset: proposal.asset,
      },
      proposal.createdAt,
    );
    this.logger?.info("buyer_web.proposal_created", {
      proposalId: proposal.id,
      store: proposal.storeUrl,
      amount: proposal.amount,
      physical: proposal.physical,
      ...(proposal.physical ? this.shippingLogFields(profile.shipping) : {}),
    });
    return proposal;
  }

  /**
   * Mark the proposal approved and return the exact payment instructions. The money has NOT
   * moved when this returns: the proposal is "approved, awaiting signature" until the buyer
   * pays from the machine that holds the key. Idempotent on an already-approved proposal.
   */
  approve(proposalId: string): ApprovalResult {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status === "paid") {
      throw this.alreadyPaid(proposal);
    }
    if (proposal.status === "rejected") {
      throw new AgentPOSError("APPROVAL_REJECTED", "This proposal was already rejected", {
        hint: "Ask the agent to propose the purchase again if you changed your mind.",
      });
    }
    if (proposal.status === "expired" || this.cartExpired(proposal)) {
      if (proposal.status !== "expired") this.markExpired(proposal);
      throw new AgentPOSError("CART_EXPIRED", "The store's quote for this proposal expired", {
        hint: "Prices are only held for a short time. Ask the agent to propose the purchase again.",
      });
    }
    if (proposal.status === "pending") {
      const decided: Proposal = {
        ...proposal,
        status: "approved",
        decidedAt: this.now().toISOString(),
      };
      this.storage.saveProposal(decided);
      this.storage.appendActivity(
        "proposal.approved",
        { proposalId: decided.id, title: decided.title, amount: decided.amount },
        decided.decidedAt as string,
      );
      return { proposal: decided, instructions: this.instructionsFor(decided) };
    }
    return { proposal, instructions: this.instructionsFor(proposal) };
  }

  /** Reject a pending (or even an approved-but-unpaid) proposal. Idempotent. */
  reject(proposalId: string): Proposal {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status === "paid") {
      throw this.alreadyPaid(proposal);
    }
    if (proposal.status === "rejected") return proposal;
    const decided: Proposal = {
      ...proposal,
      status: "rejected",
      decidedAt: this.now().toISOString(),
    };
    this.storage.saveProposal(decided);
    this.storage.appendActivity(
      "proposal.rejected",
      { proposalId: decided.id, title: decided.title, amount: decided.amount },
      decided.decidedAt as string,
    );
    return decided;
  }

  getProposal(proposalId: string): Proposal | undefined {
    return this.storage.getProposal(proposalId);
  }

  pendingProposals(): Proposal[] {
    return this.storage.listProposals("pending");
  }

  approvedProposals(): Proposal[] {
    return this.storage.listProposals("approved");
  }

  paidProposals(): Proposal[] {
    return this.storage.listProposals("paid");
  }

  proposalHistory(): Proposal[] {
    return this.storage.listProposals();
  }

  // --- signing bridge --------------------------------------------------------
  // The other half lives in `agentpos-buyer watch`: the buyer's OWN machine polls this
  // queue, pays with the local wallet (which this server never sees) and reports back.

  /**
   * Approved-and-unpaid proposals, shaped for the signer daemon. Logged to the activity
   * trail once per distinct set of ids, so a 15-second poll does not flood the history.
   */
  signerQueue(): SignerQueueItem[] {
    const items = this.storage.listProposals("approved").map((p): SignerQueueItem => ({
      proposalId: p.id,
      storeUrl: p.storeUrl,
      itemId: p.itemId,
      quantity: p.quantity,
      title: p.title,
      amount: p.amount,
      amountMinor: p.amountMinor,
      asset: p.asset,
      network: p.network,
      approvedAt: p.decidedAt ?? p.createdAt,
    }));
    const key = items
      .map((i) => i.proposalId)
      .sort()
      .join(",");
    if (items.length > 0 && key !== this.lastQueueKey) {
      this.storage.appendActivity(
        "signer.queue",
        { proposals: items.length, proposalIds: items.map((i) => i.proposalId) },
        this.now().toISOString(),
      );
    }
    this.lastQueueKey = key;
    return items;
  }

  /**
   * Record that the buyer's own machine settled the payment for an approved proposal.
   * Idempotent on an already-paid proposal; anything else that is not `approved` is
   * refused with a typed error (a payment cannot be claimed for a proposal the human
   * never approved).
   */
  markPaid(proposalId: string, payment: { txHash: string; orderId: string }): Proposal {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status === "paid") return proposal;
    if (proposal.status !== "approved") throw this.notApproved(proposal);
    // A previous failed attempt is history once the payment settles.
    const { failure: _failure, ...rest } = proposal;
    const paidAt = this.now().toISOString();
    const paid: Proposal = {
      ...rest,
      status: "paid",
      payment: { ...payment, paidAt },
    };
    this.storage.saveProposal(paid);
    this.storage.appendActivity(
      "proposal.paid",
      {
        proposalId: paid.id,
        title: paid.title,
        amount: paid.amount,
        txHash: payment.txHash,
        orderId: payment.orderId,
      },
      paidAt,
    );
    return paid;
  }

  /**
   * Record why the signer daemon could not pay an approved proposal. The proposal STAYS
   * approved (the human's decision stands); the failure is shown so the human knows why the
   * money has not moved. A failure reported after the proposal was paid is ignored (stale).
   */
  markPaymentFailed(proposalId: string, failure: { code: string; message: string }): Proposal {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status === "paid") return proposal;
    if (proposal.status !== "approved") throw this.notApproved(proposal);
    const at = this.now().toISOString();
    const failed: Proposal = { ...proposal, failure: { ...failure, at } };
    this.storage.saveProposal(failed);
    this.storage.appendActivity(
      "proposal.payment_failed",
      { proposalId: failed.id, title: failed.title, code: failure.code, message: failure.message },
      at,
    );
    return failed;
  }

  instructionsFor(proposal: Proposal): PaymentInstructions {
    return {
      proposalId: proposal.id,
      storeUrl: proposal.storeUrl,
      cartId: proposal.cartId,
      checkoutUrl: proposal.checkoutUrl,
      amount: proposal.amount,
      asset: proposal.asset,
      network: proposal.network,
      signer: "local",
      cli: `agentpos-buyer demo ${proposal.storeUrl} --item ${proposal.itemId} -q ${proposal.quantity}`,
      note: "Approved, awaiting signature. This platform stores only your public wallet address and cannot pay for you: run the command on the machine that holds your wallet key.",
    };
  }

  // --- status ----------------------------------------------------------------

  status(): ServiceStatus {
    const profile = this.storage.getProfile();
    const pending = this.storage.listProposals("pending").length;
    const approved = this.storage.listProposals("approved").length;
    return {
      profileConfigured: profile !== undefined,
      walletLinked: profile?.walletAddress !== undefined,
      network: this.network,
      stores: profile?.stores ?? [],
      ...(profile
        ? {
            mandate: {
              maxPerTx: profile.mandate.maxPerTx,
              maxTotal: profile.mandate.maxTotal,
              period: profile.mandate.period,
              allowPhysicalGoods: profile.mandate.allowPhysicalGoods,
            },
          }
        : {}),
      ...(profile?.shipping
        ? { shipping: { city: profile.shipping.city, country: profile.shipping.country } }
        : {}),
      physicalWithoutShipping: profile !== undefined && this.shippingGap(profile) !== undefined,
      pendingProposals: pending,
      approvedAwaitingSignature: approved,
      approvedInPeriod: profile ? formatUsdc(this.approvedInPeriod(profile)) : "0",
    };
  }

  activity(limit = 200) {
    return this.storage.listActivity(limit);
  }

  // --- internals -------------------------------------------------------------

  // --- shipping --------------------------------------------------------------

  /**
   * Validates the shipping section the way the store will: complete or absent, never half.
   * Returns the address to persist, which is the previous one when the form sends nothing
   * (the section is collapsed while physical goods are off, and a saved address survives).
   */
  private resolveShipping(
    input: ShippingInput | undefined,
    allowPhysicalGoods: boolean,
    previous: Address | undefined,
  ): Address | undefined {
    const t = trimShipping(input);
    const typedSomething = Object.values(t).some((v) => v.length > 0);
    if (!typedSomething) {
      if (previous) return previous;
      if (allowPhysicalGoods) {
        throw new AgentPOSError(
          "SHIPPING_REQUIRED",
          "Falta la dirección de despacho: la tienda no puede despachar sin una dirección a dónde enviar el paquete.",
          {
            hint: HINT_PHYSICAL_ON,
            details: { missing: REQUIRED_SHIPPING_FIELDS.map((f) => f.key) },
          },
        );
      }
      return undefined;
    }
    const missing = REQUIRED_SHIPPING_FIELDS.filter((f) => t[f.key].length === 0);
    const first = missing.at(0);
    if (first) {
      throw new AgentPOSError(
        allowPhysicalGoods ? "SHIPPING_REQUIRED" : "CONFIG_INVALID",
        `Falta ${first.what}: la tienda no puede despachar sin ${first.why}.`,
        {
          hint: allowPhysicalGoods ? HINT_PHYSICAL_ON : HINT_PHYSICAL_OFF,
          details: { missing: missing.map((f) => f.key) },
        },
      );
    }
    if (!/^[A-Z]{2}$/.test(t.country)) {
      throw new AgentPOSError(
        allowPhysicalGoods ? "SHIPPING_REQUIRED" : "CONFIG_INVALID",
        "El país debe ser un código ISO de dos letras: la tienda no puede despachar sin saber a qué país.",
        { hint: "Por ejemplo CL para Chile, US para Estados Unidos, MX para México." },
      );
    }
    return {
      name: t.name,
      line1: t.line1,
      city: t.city,
      postalCode: t.postalCode,
      country: t.country,
      ...(t.line2 ? { line2: t.line2 } : {}),
      ...(t.region ? { region: t.region } : {}),
      ...(t.phone ? { phone: t.phone } : {}),
    };
  }

  /**
   * Why a PHYSICAL purchase cannot go through with this profile, or undefined when it can.
   * Only the broken state answers: a mandate that allows physical goods with nowhere to ship.
   */
  private shippingGap(profile: BuyerWebProfile): AgentPOSError | undefined {
    if (!profile.mandate.allowPhysicalGoods) return undefined;
    if (!profile.shipping) {
      return new AgentPOSError(
        "SHIPPING_REQUIRED",
        "No hay dirección de despacho guardada: la tienda no puede despachar sin una dirección a dónde enviar el paquete.",
        { hint: HINT_PHYSICAL_ON },
      );
    }
    if (!profile.email) {
      return new AgentPOSError(
        "SHIPPING_REQUIRED",
        "Falta tu correo de contacto: la tienda no puede despachar sin un correo donde avisarte de la orden.",
        { hint: HINT_PHYSICAL_ON },
      );
    }
    return undefined;
  }

  /** City and country only: a log line must never carry someone's street address. */
  private shippingLogFields(shipping: Address | undefined): Record<string, unknown> {
    return shipping
      ? { shippingCity: shipping.city, shippingCountry: shipping.country }
      : { shippingOnFile: false };
  }

  private requireProfile(): BuyerWebProfile {
    const profile = this.storage.getProfile();
    if (!profile) {
      throw new AgentPOSError("CONFIG_INVALID", "No mandate configured yet", {
        hint: "Open the mandate editor (/) and save spending limits before the agent can act.",
      });
    }
    return profile;
  }

  private requireProposal(proposalId: string): Proposal {
    const proposal = this.storage.getProposal(proposalId);
    if (!proposal) {
      throw new AgentPOSError("APPROVAL_NOT_FOUND", `No proposal '${proposalId}'`, {
        hint: "It may have been created by another profile or never existed; check /proposals.",
      });
    }
    return proposal;
  }

  private alreadyPaid(proposal: Proposal): AgentPOSError {
    return new AgentPOSError("CONFIG_INVALID", "This proposal is already paid", {
      hint: `Nothing left to decide: it settled with transaction ${proposal.payment?.txHash ?? "(unknown)"}.`,
    });
  }

  /** Typed refusal for marking paid/failed a proposal the human never approved. */
  private notApproved(proposal: Proposal): AgentPOSError {
    if (proposal.status === "pending") {
      return new AgentPOSError("APPROVAL_PENDING", "This proposal is not approved yet", {
        hint: "Only approved proposals can be paid; the human decides on /proposals first.",
      });
    }
    if (proposal.status === "rejected") {
      return new AgentPOSError("APPROVAL_REJECTED", "This proposal was rejected", {
        hint: "A rejected proposal can never be paid. Propose the purchase again.",
      });
    }
    return new AgentPOSError("APPROVAL_EXPIRED", "This proposal expired before payment", {
      hint: "Ask the agent to propose the purchase again for a fresh quote.",
    });
  }

  private cartExpired(proposal: Proposal): boolean {
    return new Date(proposal.cartExpiresAt).getTime() <= this.now().getTime();
  }

  private markExpired(proposal: Proposal): void {
    const expired: Proposal = {
      ...proposal,
      status: "expired",
      decidedAt: this.now().toISOString(),
    };
    this.storage.saveProposal(expired);
    this.storage.appendActivity(
      "proposal.expired",
      { proposalId: expired.id, title: expired.title },
      expired.decidedAt as string,
    );
  }

  /** What the human already approved in the current mandate period (paid or still awaiting
   * signature); the honest ceiling this platform can enforce, since settlement happens
   * off-box on the buyer's machine. */
  private approvedInPeriod(profile: BuyerWebProfile): UsdcMinor {
    const since = periodStart(profile.mandate.period, this.now());
    return this.storage
      .listProposals()
      .filter(
        (p) =>
          (p.status === "approved" || p.status === "paid") &&
          p.decidedAt !== undefined &&
          new Date(p.decidedAt) >= since,
      )
      .reduce((acc, p) => addUsdc(acc, usdcFromMinor(p.amountMinor)), usdcFromMinor(0n));
  }

  /** BuyerService over the web profile. Search and quoting only; it can never sign here. */
  private buyerFor(p: BuyerWebProfile): BuyerService {
    const profile: Profile = {
      name: "buyer-web",
      network: this.network,
      keyFile: NO_KEY_FILE,
      address: p.walletAddress ?? PLACEHOLDER_ADDRESS,
      mandate: p.mandate,
      sites: p.stores,
      createdAt: p.updatedAt,
      // Contact and address travel to the store through the mcp-buyer profile, exactly as
      // they do for the CLI: createCart reads them when the mandate locks the address.
      ...(p.email
        ? { buyer: { email: p.email, ...(p.shipping ? { name: p.shipping.name } : {}) } }
        : {}),
      ...(p.shipping ? { shipping: p.shipping } : {}),
    };
    return new BuyerService({
      profile,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
  }
}
