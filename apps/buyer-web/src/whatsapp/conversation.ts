/**
 * Provider-agnostic WhatsApp conversation: maps a text message to BuyerWebService calls
 * (searchOffers / propose / approve / reject / status), exactly the surface the web pages
 * use. Replies are Spanish-first with English command aliases.
 *
 * Allowlist first: only the configured owner number(s) may use the bot. Anyone else gets
 * one polite refusal, then silence.
 *
 * Conversation state (search result numbering, the pending proposal) lives in an in-memory
 * map with a 30 minute TTL: a restart or an expired entry only means searching again;
 * proposals themselves are safe in SQLite.
 */
import { isAgentPOSError } from "@agentpos/core";
import type { BuyerWebService } from "../service.js";
import { normalizeWhatsAppNumber, senderHash } from "./types.js";
import type { InboundMessage, WhatsAppLogger } from "./types.js";

const STATE_TTL_MS = 30 * 60 * 1000;
const MAX_RESULTS = 5;

interface OfferRef {
  itemId: string;
  storeUrl: string;
}

interface SenderState {
  offers: Map<number, OfferRef>;
  pendingProposalId: string | undefined;
  lastProposalId: string | undefined;
  touchedAt: number;
}

export interface ConversationDeps {
  service: BuyerWebService;
  /** E.164 numbers ("+569..." or "whatsapp:+569..."); normalized before comparing. */
  allowedNumbers: string[];
  log?: WhatsAppLogger;
  now?: () => Date;
}

const HELP_TEXT = [
  "Comandos disponibles:",
  "- buscar <texto> (search): busca productos en tus tiendas",
  "- comprar <numero> [cantidad] (buy): pide una propuesta de compra del resultado indicado",
  "- si / no (yes / no): aprueba o rechaza la propuesta pendiente",
  "- estado (status): estado de tu ultima propuesta",
  "- ayuda (help): muestra esta lista",
  "",
  "Aprobar por WhatsApp no paga: la firma ocurre en la maquina donde vive tu wallet.",
].join("\n");

const REFUSAL_TEXT =
  "Hola. Este asistente de compras es privado y solo atiende a su propietario, asi que no puedo ayudarte. Que tengas un buen dia.";

const UNSUPPORTED_TEXT =
  "Por ahora solo entiendo mensajes de texto. Escribe 'ayuda' para ver los comandos.";

const STATUS_ES: Record<string, string> = {
  pending: "pendiente de tu aprobacion",
  approved: "aprobada, en espera de firma",
  rejected: "rechazada",
  expired: "expirada",
  paid: "pagada",
};

/** Lowercase and strip accents so "sí", "Si" and "si" are the same command word. */
function commandWord(token: string): string {
  return token
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

export class ConversationHandler {
  private readonly service: BuyerWebService;
  private readonly allowed: Set<string>;
  private readonly log: WhatsAppLogger;
  private readonly now: () => Date;
  private readonly states = new Map<string, SenderState>();
  private readonly refused = new Set<string>();

  constructor(deps: ConversationDeps) {
    this.service = deps.service;
    this.allowed = new Set(deps.allowedNumbers.map(normalizeWhatsAppNumber));
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? (() => new Date());
  }

  /** Handle one text message. `undefined` means "send nothing" (repeat stranger). */
  async handle(msg: InboundMessage): Promise<string | undefined> {
    const refusal = this.gate(msg.from);
    if (refusal !== "allowed") return refusal;
    const state = this.stateFor(msg.from);
    const trimmed = msg.text.trim().replace(/\s+/g, " ");
    const [first = "", ...rest] = trimmed.split(" ");
    const command = commandWord(first);
    try {
      switch (command) {
        case "buscar":
        case "search":
          return await this.search(state, rest.join(" "));
        case "comprar":
        case "buy":
          return await this.buy(state, rest);
        case "si":
        case "yes":
          return this.approve(state);
        case "no":
          return this.reject(state);
        case "estado":
        case "status":
          return this.status(state);
        default:
          return HELP_TEXT;
      }
    } catch (err) {
      if (isAgentPOSError(err)) {
        this.log("whatsapp.command_error", {
          sender: senderHash(msg.from),
          code: err.code,
        });
        return `No se pudo: ${err.message}. ${err.hint}`;
      }
      this.log("whatsapp.command_failed", { sender: senderHash(msg.from) });
      return "Algo salio mal de nuestro lado. Intenta de nuevo en un momento.";
    }
  }

  /** Non-text (media, stickers, audio): same allowlist gate, then a polite decline. */
  handleUnsupported(from: string): string | undefined {
    const refusal = this.gate(from);
    if (refusal !== "allowed") return refusal;
    return UNSUPPORTED_TEXT;
  }

  // --- commands --------------------------------------------------------------

  private async search(state: SenderState, query: string): Promise<string> {
    const q = query.trim();
    if (!q) return "Dime que buscar. Por ejemplo: buscar taza";
    const offers = await this.service.searchOffers(q);
    if (offers.length === 0) {
      return `No encontre resultados para "${q}" en tus tiendas.`;
    }
    const top = offers.slice(0, MAX_RESULTS);
    state.offers = new Map(top.map((o, i) => [i + 1, { itemId: o.id, storeUrl: o.site }]));
    const lines = top.map(
      (o, i) => `${i + 1}. ${o.title} - ${o.price.amount} USDC - ${o.siteName}`,
    );
    return [
      `Resultados para "${q}":`,
      ...lines,
      "",
      "Responde 'comprar <numero>' para pedir una propuesta (por ejemplo: comprar 1).",
    ].join("\n");
  }

  private async buy(state: SenderState, args: string[]): Promise<string> {
    const n = Number(args[0]);
    const ref = Number.isInteger(n) ? state.offers.get(n) : undefined;
    if (!ref) {
      return "Ese numero no esta en tu ultima busqueda (los resultados duran 30 minutos). Usa 'buscar <texto>' y luego 'comprar <numero>'.";
    }
    const quantity = args[1] === undefined ? 1 : Number(args[1]);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      return "La cantidad debe ser un entero entre 1 y 999. Por ejemplo: comprar 1 2";
    }
    const proposal = await this.service.propose(ref.itemId, ref.storeUrl, quantity);
    state.pendingProposalId = proposal.id;
    state.lastProposalId = proposal.id;
    return [
      "Propuesta de compra (precio congelado):",
      proposal.title,
      `Total: ${proposal.amount} USDC`,
      `Tienda: ${proposal.storeName} (${proposal.storeUrl})`,
      "",
      "Responde 'si' para aprobar o 'no' para rechazar.",
    ].join("\n");
  }

  private approve(state: SenderState): string {
    if (!state.pendingProposalId) {
      return "No hay ninguna propuesta pendiente. Usa 'buscar' y luego 'comprar' primero.";
    }
    const { proposal, instructions } = this.service.approve(state.pendingProposalId);
    state.lastProposalId = proposal.id;
    state.pendingProposalId = undefined;
    return [
      "Propuesta aprobada, en espera de firma.",
      `${proposal.title} por ${proposal.amount} USDC en ${proposal.storeName}.`,
      "",
      "Este bot no guarda llaves y no puede pagar por ti. Para pagar, ejecuta en la maquina donde vive tu wallet:",
      instructions.cli,
      "",
      "Si en esa maquina corre 'agentpos-buyer watch', el pago se hara solo en unos segundos y aqui veras la propuesta como pagada.",
    ].join("\n");
  }

  private reject(state: SenderState): string {
    if (!state.pendingProposalId) {
      return "No hay ninguna propuesta pendiente que rechazar.";
    }
    const proposal = this.service.reject(state.pendingProposalId);
    state.lastProposalId = proposal.id;
    state.pendingProposalId = undefined;
    return `Propuesta rechazada (${proposal.title}). No se cobro nada.`;
  }

  private status(state: SenderState): string {
    if (state.lastProposalId) {
      const proposal = this.service.getProposal(state.lastProposalId);
      if (proposal) {
        const label = STATUS_ES[proposal.status] ?? proposal.status;
        const lines = [`Tu ultima propuesta (${proposal.title}, ${proposal.amount} USDC): ${label}.`];
        if (proposal.status === "paid" && proposal.payment) {
          lines.push(`Transaccion: ${proposal.payment.txHash}`);
        }
        if (proposal.status === "approved" && proposal.failure) {
          lines.push(
            `El ultimo intento de pago fallo (${proposal.failure.code}): ${proposal.failure.message}`,
          );
        }
        return lines.join("\n");
      }
    }
    const s = this.service.status();
    return [
      "No hay propuestas en este chat todavia.",
      `Pendientes: ${s.pendingProposals}. Aprobadas en espera de firma: ${s.approvedAwaitingSignature}.`,
    ].join("\n");
  }

  // --- allowlist and state ---------------------------------------------------

  /** Returns "allowed", one refusal text, or undefined (already refused: stay silent). */
  private gate(from: string): "allowed" | string | undefined {
    const key = normalizeWhatsAppNumber(from);
    if (this.allowed.has(key)) return "allowed";
    if (this.refused.has(key)) {
      this.log("whatsapp.refused_repeat", { sender: senderHash(from) });
      return undefined;
    }
    this.refused.add(key);
    this.log("whatsapp.refused", { sender: senderHash(from) });
    return REFUSAL_TEXT;
  }

  private stateFor(from: string): SenderState {
    const key = normalizeWhatsAppNumber(from);
    const nowMs = this.now().getTime();
    const existing = this.states.get(key);
    if (existing && nowMs - existing.touchedAt <= STATE_TTL_MS) {
      existing.touchedAt = nowMs;
      return existing;
    }
    const fresh: SenderState = {
      offers: new Map(),
      pendingProposalId: undefined,
      lastProposalId: existing?.lastProposalId,
      touchedAt: nowMs,
    };
    this.states.set(key, fresh);
    return fresh;
  }
}
