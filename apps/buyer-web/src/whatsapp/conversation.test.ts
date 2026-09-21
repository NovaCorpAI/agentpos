/**
 * The provider-agnostic conversation against a real in-process store: allowlist first,
 * then the full search -> buy -> approve/reject loop in Spanish with English aliases.
 */
import { describe, expect, it } from "vitest";
import { BuyerWebService } from "../service.js";
import { BuyerWebStorage } from "../storage.js";
import { STORE_URL, inProcessStore } from "../test-utils.js";
import { ConversationHandler } from "./conversation.js";
import type { InboundMessage } from "./types.js";

const OWNER = "+56911111111";
const STRANGER = "+56999999999";

function makeConversation(options: {
  profile?: boolean;
  maxPerTx?: string;
  now?: () => Date;
} = {}) {
  const storage = new BuyerWebStorage(":memory:");
  const service = new BuyerWebService({
    storage,
    fetchImpl: inProcessStore().fetchImpl,
    ...(options.now ? { now: options.now } : {}),
  });
  if (options.profile !== false) {
    service.saveProfile({
      maxPerTx: options.maxPerTx ?? "25",
      maxTotal: "100",
      period: "week",
      stores: [STORE_URL],
    });
  }
  const conversation = new ConversationHandler({
    service,
    allowedNumbers: [OWNER],
    ...(options.now ? { now: options.now } : {}),
  });
  return { conversation, service };
}

function msg(text: string, from = OWNER): InboundMessage {
  return { from, text, id: "wamid.test", timestamp: "1700000000" };
}

describe("allowlist", () => {
  it("refuses a stranger once, politely, then stays silent", async () => {
    const { conversation } = makeConversation();
    const first = await conversation.handle(msg("buscar mug", STRANGER));
    expect(first).toContain("privado");
    // No trace of a command having run.
    expect(first).not.toContain("Resultados");
    const second = await conversation.handle(msg("hola", STRANGER));
    expect(second).toBeUndefined();
  });

  it("accepts the owner number with a whatsapp: prefix and formatting noise", async () => {
    const { conversation } = makeConversation();
    const reply = await conversation.handle(msg("ayuda", `whatsapp:${OWNER}`));
    expect(reply).toContain("Comandos disponibles");
  });

  it("gates unsupported (media) messages through the same allowlist", () => {
    const { conversation } = makeConversation();
    expect(conversation.handleUnsupported(STRANGER)).toContain("privado");
    expect(conversation.handleUnsupported(STRANGER)).toBeUndefined();
    expect(conversation.handleUnsupported(OWNER)).toContain("mensajes de texto");
  });
});

describe("commands", () => {
  it("buscar returns a numbered list with title, price and store", async () => {
    const { conversation } = makeConversation();
    const reply = await conversation.handle(msg("buscar mug"));
    expect(reply).toContain('Resultados para "mug"');
    expect(reply).toContain("1. Ceramic Mug - 9.9 USDC - Faro Demo Store");
    expect(reply).toContain("comprar <número>");
  });

  it("search (English alias) works and an empty result is honest", async () => {
    const { conversation } = makeConversation();
    expect(await conversation.handle(msg("search mug"))).toContain("Ceramic Mug");
    expect(await conversation.handle(msg("buscar nothing-here"))).toContain(
      "No encontré resultados",
    );
  });

  it("comprar freezes a real quote and asks for si/no", async () => {
    const { conversation, service } = makeConversation();
    await conversation.handle(msg("buscar mug"));
    const reply = await conversation.handle(msg("comprar 1"));
    expect(reply).toContain("precio congelado");
    expect(reply).toContain("1 x Ceramic Mug");
    expect(reply).toContain("Total: 9.9 USDC");
    expect(reply).toContain("Faro Demo Store");
    expect(reply).toContain("Responde 'sí' para aprobar o 'no' para rechazar.");
    expect(service.pendingProposals()).toHaveLength(1);
  });

  it("comprar with a quantity multiplies the frozen total", async () => {
    const { conversation } = makeConversation();
    await conversation.handle(msg("buscar mug"));
    const reply = await conversation.handle(msg("comprar 1 2"));
    expect(reply).toContain("2 x Ceramic Mug");
    expect(reply).toContain("Total: 19.8 USDC");
  });

  it("comprar without a prior search points back to buscar", async () => {
    const { conversation } = makeConversation();
    const reply = await conversation.handle(msg("comprar 1"));
    expect(reply).toContain("última búsqueda");
    expect(reply).toContain("buscar");
  });

  it("search results expire after 30 minutes (state TTL)", async () => {
    let nowMs = Date.parse("2026-09-05T12:00:00Z");
    const { conversation } = makeConversation({ now: () => new Date(nowMs) });
    await conversation.handle(msg("buscar mug"));
    nowMs += 31 * 60 * 1000;
    const reply = await conversation.handle(msg("comprar 1"));
    expect(reply).toContain("última búsqueda");
  });

  it("si approves: awaiting signature, with the exact local payment command", async () => {
    const { conversation, service } = makeConversation();
    await conversation.handle(msg("buscar mug"));
    await conversation.handle(msg("comprar 1"));
    const reply = await conversation.handle(msg("si"));
    expect(reply).toContain("aprobada, en espera de firma");
    expect(reply).toContain("no guarda llaves");
    expect(reply).toContain("agentpos-buyer demo");
    expect(service.approvedProposals()).toHaveLength(1);
    // Approving does not pay: no payment artifact anywhere in the reply.
    expect(reply).not.toContain("txHash");
  });

  it("accepts the accented 'sí' and the English 'yes'", async () => {
    const { conversation } = makeConversation();
    await conversation.handle(msg("buscar sticker"));
    await conversation.handle(msg("comprar 1"));
    expect(await conversation.handle(msg("sí"))).toContain("aprobada");
    await conversation.handle(msg("buscar sticker"));
    await conversation.handle(msg("comprar 1"));
    expect(await conversation.handle(msg("YES"))).toContain("aprobada");
  });

  it("no rejects the pending proposal", async () => {
    const { conversation, service } = makeConversation();
    await conversation.handle(msg("buscar sticker"));
    await conversation.handle(msg("comprar 1"));
    const reply = await conversation.handle(msg("no"));
    expect(reply).toContain("rechazada");
    expect(reply).toContain("No se cobró nada");
    expect(service.proposalHistory().at(0)?.status).toBe("rejected");
  });

  it("si/no without a pending proposal explain what to do first", async () => {
    const { conversation } = makeConversation();
    expect(await conversation.handle(msg("si"))).toContain("No hay ninguna propuesta pendiente");
    expect(await conversation.handle(msg("no"))).toContain("propuesta pendiente");
  });

  it("estado reports the last proposal's status", async () => {
    const { conversation } = makeConversation();
    await conversation.handle(msg("buscar mug"));
    await conversation.handle(msg("comprar 1"));
    expect(await conversation.handle(msg("estado"))).toContain("pendiente de tu aprobación");
    await conversation.handle(msg("si"));
    expect(await conversation.handle(msg("status"))).toContain("aprobada, en espera de firma");
  });

  it("estado shows 'pagada' with the txHash once the signing bridge reports the payment", async () => {
    const { conversation, service } = makeConversation();
    await conversation.handle(msg("buscar mug"));
    await conversation.handle(msg("comprar 1"));
    await conversation.handle(msg("si"));
    const proposal = service.approvedProposals().at(0);
    service.markPaid(proposal!.id, { txHash: "tx_wa_1", orderId: "order-9" });
    const reply = await conversation.handle(msg("estado"));
    expect(reply).toContain("pagada");
    expect(reply).toContain("Transacción: tx_wa_1");
  });

  it("estado explains why an approved proposal has not been paid after a failed attempt", async () => {
    const { conversation, service } = makeConversation();
    await conversation.handle(msg("buscar mug"));
    await conversation.handle(msg("comprar 1"));
    await conversation.handle(msg("si"));
    const proposal = service.approvedProposals().at(0);
    service.markPaymentFailed(proposal!.id, {
      code: "MANDATE_EXCEEDED",
      message: "Payment exceeds the per-transaction limit",
    });
    const reply = await conversation.handle(msg("estado"));
    expect(reply).toContain("aprobada, en espera de firma");
    expect(reply).toContain("falló (MANDATE_EXCEEDED)");
  });

  it("estado with no proposals falls back to the service status", async () => {
    const { conversation } = makeConversation();
    const reply = await conversation.handle(msg("estado"));
    expect(reply).toContain("No hay propuestas");
    expect(reply).toContain("Pendientes: 0");
  });

  it("unknown text and ayuda/help return the command list", async () => {
    const { conversation } = makeConversation();
    for (const text of ["hola que tal", "ayuda", "help"]) {
      const reply = await conversation.handle(msg(text));
      expect(reply).toContain("Comandos disponibles");
      expect(reply).toContain("buscar <texto>");
      expect(reply).toContain("la firma ocurre en la máquina donde vive tu wallet");
    }
  });
});

describe("errors", () => {
  it("surfaces the typed error message and hint, never a stack trace", async () => {
    const { conversation } = makeConversation({ profile: false });
    const reply = await conversation.handle(msg("buscar mug"));
    expect(reply).toContain("No mandate configured yet");
    expect(reply).toContain("save spending limits");
    expect(reply).not.toContain("at "); // no stack frames
    expect(reply).not.toContain("AgentPOSError");
  });

  it("surfaces MANDATE_EXCEEDED from propose with its hint", async () => {
    const { conversation } = makeConversation({ maxPerTx: "5" });
    await conversation.handle(msg("buscar mug"));
    const reply = await conversation.handle(msg("comprar 1"));
    expect(reply).toContain("No se pudo");
    expect(reply).toMatch(/mandate|limit/i);
    expect(reply).not.toContain("AgentPOSError");
  });
});
