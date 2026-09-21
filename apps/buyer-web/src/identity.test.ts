/**
 * The three promises this surface makes about itself, as tests (docs/DISENO.md,
 * temperament 4: "poder con límites"):
 *
 * 1. Spanish is written with its accents. A page that approves payments and writes
 *    "contrasena" reads as careless, so the rendered text of every page is scanned for the
 *    usual unaccented spellings.
 * 2. Every state colour comes from a token. No page paints "pendiente" amber by writing a
 *    hex value; it names `--state-wait` and the stylesheet resolves it.
 * 3. Approving and rejecting are never adjacent in the document. The destructive button
 *    cannot sit next to the one that commits the money, and no layout accident can bring
 *    them together, because a separator always stands between them in the DOM.
 */
import { describe, expect, it } from "vitest";
import { createBuyerWebApp } from "./app.js";
import { BUYER_CSS, STATE_TOKENS } from "./pages.js";
import { BuyerWebStorage } from "./storage.js";
import {
  MARKET_A,
  MARKET_B,
  MARKET_DOWN,
  MARKET_LEGACY,
  STORE_URL,
  inProcessMarket,
  inProcessStore,
  setUpOwner,
} from "./test-utils.js";
import type { BuyerWebClient } from "./test-utils.js";
import type { Proposal, ProposalStatus } from "./types.js";

function makeApp(market = false) {
  const storage = new BuyerWebStorage(":memory:");
  const fetchImpl = market ? inProcessMarket().fetchImpl : inProcessStore().fetchImpl;
  return { ...createBuyerWebApp({ storage, fetchImpl }), storage };
}

async function propose(client: BuyerWebClient, itemId = "sticker"): Promise<Proposal> {
  const res = await client.request("/api/proposals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ storeUrl: STORE_URL, itemId }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { proposal: Proposal }).proposal;
}

/**
 * What a reader actually sees: markup, the stylesheet and character entities removed. The
 * stylesheet has to go, because class names and custom properties are written in English
 * and in ASCII on purpose (`decision-gap`, `--state-wait`).
 */
function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/gi, " ");
}

/**
 * Spellings that are simply wrong in Spanish and that this surface used to print. Words
 * that are correct unaccented too ("quien recibe", "solo", "esta") are deliberately not
 * here: the list must only ever fail on a real mistake.
 */
const UNACCENTED = [
  "accion",
  "alli",
  "aprobacion",
  "aqui",
  "asi",
  "busqueda",
  "caracteristicas",
  "codigo",
  "codigos",
  "contrasena",
  "contrasenas",
  "cotizacion",
  "decision",
  "despues",
  "dia",
  "dias",
  "direccion",
  "dueno",
  "fisica",
  "fisicas",
  "fisico",
  "fisicos",
  "informacion",
  "invalido",
  "limite",
  "limites",
  "linea",
  "maquina",
  "maximo",
  "mas",
  "minimo",
  "numero",
  "pagina",
  "pais",
  "periodo",
  "proposito",
  "recuperacion",
  "region",
  // Only the singular: the plural "sesiones" carries no accent, and neither do
  // "direcciones", "aprobaciones" or any other plural of an -ión word.
  "sesion",
  "telefono",
  "todavia",
  "transaccion",
  "ultima",
  "ultimas",
  "ultimo",
  "ultimos",
  "unica",
  "unico",
  "valida",
  "valido",
];

function misspellings(html: string): string[] {
  const text = visibleText(html);
  return UNACCENTED.filter((word) => new RegExp(`\\b${word}\\b`, "i").test(text));
}

/** Every page of the surface, signed out and signed in, with content on it. */
async function everyPage(): Promise<Array<[string, string]>> {
  const pages: Array<[string, string]> = [];
  const add = async (name: string, res: Response) => {
    pages.push([name, await res.text()]);
  };

  // Signed out: the first thing anyone sees is /setup, then the ways back in.
  const fresh = makeApp();
  await add("/setup", await fresh.app.request("/setup"));

  const client = await setUpOwner(fresh.app);
  await add("/login", await fresh.app.request("/login"));
  await add("/recuperar", await fresh.app.request("/recuperar"));
  await add("/recuperar/operador", await fresh.app.request("/recuperar/operador?t=abc"));

  // The mandate, before and after it exists, plus the editor and the channels.
  await add("/ (sin mandato)", await client.request("/"));
  await client.request("/profile", {
    method: "POST",
    body: new URLSearchParams({
      maxPerTx: "25",
      maxTotal: "100",
      period: "week",
      stores: STORE_URL,
      email: "buyer@example.com",
      allowPhysicalGoods: "on",
      shipName: "Ana Perez",
      shipLine1: "Avenida Siempre Viva 742",
      shipCity: "Santiago",
      shipPostalCode: "8320000",
      shipCountry: "cl",
    }),
  });
  await add("/?saved=1", await client.request("/?saved=1"));

  // A decision waiting, one approved and waiting for the signature, and one paid.
  const pending = await propose(client, "poster");
  await add("/proposals (pendiente)", await client.request("/proposals"));
  const approved = await propose(client);
  await client.approve(approved.id);
  fresh.service.markPaid(approved.id, { txHash: "tx_identity_1", orderId: "ord-1" });
  const failing = await propose(client, "mug");
  await client.approve(failing.id);
  fresh.service.markPaymentFailed(failing.id, {
    code: "MANDATE_EXCEEDED",
    message: "Payment exceeds the per-transaction limit",
  });
  await add("/proposals (todo)", await client.request("/proposals"));
  expect(pending.status).toBe("pending");

  await add("/activity", await client.request("/activity"));
  await add("/cuenta", await client.request("/cuenta"));
  await add("/cuenta/codigos", await client.request("/cuenta/codigos", { method: "POST" }));
  await add("/cuenta (con codigos)", await client.request("/cuenta"));
  await add("error", await client.request("/proposals/no-existe/reject", { method: "POST" }));

  // The market call, with its comparison table, its status strip and its facets.
  const marketApp = makeApp(true);
  const buyer = await setUpOwner(marketApp.app);
  await buyer.request("/profile", {
    method: "POST",
    body: new URLSearchParams({
      maxPerTx: "25",
      maxTotal: "100",
      period: "week",
      stores: [MARKET_A, MARKET_B, MARKET_LEGACY, MARKET_DOWN].join("\n"),
      email: "buyer@example.com",
    }),
  });
  await add("/?q=lamina", await buyer.request("/?q=lamina&qty=2"));
  await add("/?attr=blanco", await buyer.request("/?q=lamina&attr=blanco"));
  return pages;
}

/** Rendered once: every page of the surface is expensive to build and never changes here. */
let rendered: Promise<Array<[string, string]>> | undefined;
const allPages = (): Promise<Array<[string, string]>> => (rendered ??= everyPage());

describe("the Spanish of this surface", () => {
  it("never prints an unaccented spelling on any page", async () => {
    const pages = await allPages();
    expect(pages.length).toBeGreaterThan(10);
    for (const [name, html] of pages) {
      expect([name, misspellings(html)]).toEqual([name, []]);
    }
  }, 30_000);

  it("would catch the old copy", () => {
    // The guard is worth nothing if it cannot fail: this is what the pages used to say.
    expect(misspellings("<p>Tu contrasena protege tus limites de gasto.</p>")).toEqual([
      "contrasena",
      "limites",
    ]);
    // And it does not fire on words that are correct without an accent.
    expect(misspellings("<p>Nombre de quien recibe, solo esta vez.</p>")).toEqual([]);
  });

  it("speaks with this surface's voice on the way in", async () => {
    const [, login] = (await allPages()).find(([name]) => name === "/login") ?? [];
    expect(login).toContain("Entra a tu sala de control");
    expect(login).toContain("Contraseña");
    expect(login).toContain("Sala de control");
  }, 30_000);
});

describe("state colours", () => {
  const ALL: ProposalStatus[] = ["pending", "approved", "rejected", "expired", "paid"];

  it("maps every proposal state to a token, and nothing else", () => {
    expect(Object.keys(STATE_TOKENS).sort()).toEqual([...ALL].sort());
    for (const token of Object.values(STATE_TOKENS)) {
      expect(token.startsWith("--state-")).toBe(true);
    }
  });

  it("paints each state from its token and never from a literal", () => {
    for (const status of ALL) {
      const token = STATE_TOKENS[status];
      // Declared once, on :root, with a soft companion for the fill.
      expect(BUYER_CSS).toContain(`${token}: `);
      expect(BUYER_CSS).toContain(`${token}-soft: `);
      // And every rule that paints this state resolves through the token.
      for (const selector of [`.tag.${status}`, `.edge-${status}`, `.dot-${status}::before`]) {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const rule = new RegExp(`${escaped} \\{([^}]*)\\}`).exec(BUYER_CSS)?.[1];
        expect([selector, rule !== undefined]).toEqual([selector, true]);
        expect([selector, (rule ?? "").includes(`var(${token})`)]).toEqual([selector, true]);
        expect([selector, /#[0-9a-f]{3,8}/i.test(rule ?? "")]).toEqual([selector, false]);
      }
    }
  });

  it("gives the pending, approved and paid cards their own temperature", async () => {
    const built = makeApp();
    const client = await setUpOwner(built.app);
    await client.request("/profile", {
      method: "POST",
      body: new URLSearchParams({
        maxPerTx: "25",
        maxTotal: "100",
        period: "week",
        stores: STORE_URL,
        email: "buyer@example.com",
      }),
    });
    await propose(client);
    const waiting = await (await client.request("/proposals")).text();
    expect(waiting).toContain('class="card edge edge-pending"');
    expect(waiting).toContain('class="tag pending"');

    const second = await propose(client, "mug");
    await client.approve(second.id);
    const signing = await (await client.request("/proposals")).text();
    expect(signing).toContain("edge-approved");
    expect(signing).toContain('class="tag approved"');

    built.service.markPaid(second.id, { txHash: "tx_identity_2", orderId: "ord-2" });
    const paid = await (await client.request("/proposals")).text();
    expect(paid).toContain("edge-paid");
    expect(paid).toContain('class="tag paid"');
    expect(paid).toContain("tx_identity_2");
  });
});

describe("a decision has weight", () => {
  async function pendingPage(): Promise<{ html: string; proposal: Proposal }> {
    const built = makeApp();
    const client = await setUpOwner(built.app);
    await client.request("/profile", {
      method: "POST",
      body: new URLSearchParams({
        maxPerTx: "25",
        maxTotal: "100",
        period: "week",
        stores: STORE_URL,
        email: "buyer@example.com",
      }),
    });
    const proposal = await propose(client);
    return { html: await (await client.request("/proposals")).text(), proposal };
  }

  it("never puts approve next to reject in the document", async () => {
    const { html, proposal } = await pendingPage();
    const approve = html.indexOf(`action="/proposals/${proposal.id}/approve"`);
    const reject = html.indexOf(`action="/proposals/${proposal.id}/reject"`);
    expect(approve).toBeGreaterThan(-1);
    expect(reject).toBeGreaterThan(approve);
    const between = html.slice(approve, reject);
    // The approve form is closed, and a separator stands between the two.
    expect(between).toContain("</form>");
    expect(between).toContain('class="decision-gap"');
    // They are never inside the same row of actions either.
    expect(between).not.toContain('class="actions"');
  });

  it("repeats the amount and the store inside both buttons", async () => {
    const { html, proposal } = await pendingPage();
    const what = `${proposal.amount} ${proposal.asset} en ${proposal.storeName}`;
    expect(html).toContain(`Aprobar ${what}`);
    expect(html).toContain(`Rechazar ${what}`);
  });

  it("presents the password as a step of the decision, not a stray field", async () => {
    const { html } = await pendingPage();
    expect(html).toContain("Paso 1 de 2");
    expect(html).toContain("Paso 2 de 2: Aprobar");
    expect(html).toContain('class="confirm"');
  });
});

describe("the mandate is the centrepiece", () => {
  it("shows the contract first and folds the editor away", async () => {
    const built = makeApp();
    const client = await setUpOwner(built.app);
    await client.request("/profile", {
      method: "POST",
      body: new URLSearchParams({
        maxPerTx: "25",
        maxTotal: "100",
        period: "week",
        stores: STORE_URL,
        email: "buyer@example.com",
      }),
    });
    const html = await (await client.request("/")).text();
    const contract = html.indexOf('class="contract live"');
    const editor = html.indexOf('<details class="editor"');
    expect(contract).toBeGreaterThan(-1);
    expect(editor).toBeGreaterThan(contract);
    // Folded: editing is the secondary action, and nothing opens it by itself.
    expect(html).not.toContain('<details class="editor" open>');
    expect(html).toContain("Editar el mandato");
    // The seal, the limits and the real numbers of the period.
    expect(html).toContain(">vigente<");
    expect(html).toContain("Máximo por compra");
    expect(html).toContain('Aprobado en este período: <b class="money">0 USDC</b>');
    expect(html).toContain('Disponible: <b class="money">100 USDC</b>');
    expect(html).toContain("0% del límite de 100 USDC por semana");
  });

  it("opens the editor by itself only when there is nothing to show yet", async () => {
    const built = makeApp();
    const client = await setUpOwner(built.app);
    const html = await (await client.request("/")).text();
    expect(html).toContain('<details class="editor" open>');
    expect(html).toContain("Todavía no hay mandato");
    expect(html).toContain(">sin firmar<");
  });
});
