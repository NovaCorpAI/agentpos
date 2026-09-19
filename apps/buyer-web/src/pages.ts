/**
 * Server-rendered pages for the buyer's space ("Espacio del comprador"), Spanish-first.
 * Same constraints as packages/site/src/dashboard.ts: one self-contained HTML document per
 * page, zero external resources (no CDN, no fonts, no analytics) and nothing interpolated
 * without escaping. Plain forms, no client framework.
 *
 * Visual identity (shared with the landing): background #0b1020, surfaces #0d1428/#101a33,
 * borders rgba(120,150,220,0.15), headings #f4f7ff, body #9fb0d0, muted #6d7ea6, accent
 * #7aa2ff, money/success #26d0a0. No emojis: this surface moves the user's money.
 */
import { formatUsdc, usdc, usdcFromMinor } from "@agentpos/core";
import type { Offer } from "@agentpos/mcp-buyer";
import type { ActivityEntry, Proposal, ServiceStatus } from "./types.js";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b1020; color: #9fb0d0; font: 15px/1.55 "Segoe UI", system-ui, sans-serif; }
  .wrap { max-width: 920px; margin: 0 auto; padding: 26px 20px 64px; }
  a { color: #7aa2ff; }
  header { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .wordmark { color: #f4f7ff; font-weight: 700; font-size: 1.05rem; letter-spacing: 0.08em; }
  .wordmark .pos { color: #7aa2ff; }
  .space { color: #6d7ea6; font-size: 0.88rem; border-left: 1px solid rgba(120,150,220,0.25); padding-left: 14px; }
  .net { font-family: Consolas, ui-monospace, monospace; font-size: 0.72rem; border-radius: 999px; padding: 2px 10px; border: 1px solid rgba(120,150,220,0.25); color: #9fb0d0; white-space: nowrap; }
  .net.main { color: #26d0a0; border-color: rgba(38,208,160,0.35); }
  nav { margin-left: auto; display: flex; gap: 16px; }
  nav a { color: #9fb0d0; text-decoration: none; font-size: 0.92rem; padding-bottom: 3px; }
  nav a[data-on] { color: #f4f7ff; border-bottom: 2px solid #7aa2ff; }
  .assure { display: flex; flex-wrap: wrap; gap: 4px 18px; margin: 16px 0 26px; padding: 9px 14px; background: #0d1428; border: 1px solid rgba(120,150,220,0.15); border-radius: 10px; color: #6d7ea6; font-size: 0.82rem; }
  .assure span::before { content: "\\2713"; color: #26d0a0; margin-right: 7px; }
  h2 { color: #f4f7ff; font-size: 1.02rem; margin: 30px 0 12px; font-weight: 600; }
  .lead { color: #f4f7ff; font-size: 1.28rem; font-weight: 600; margin: 6px 0 4px; letter-spacing: -0.01em; }
  .sub { color: #6d7ea6; margin: 0 0 20px; }
  .card { background: #0d1428; border: 1px solid rgba(120,150,220,0.15); border-radius: 14px; padding: 20px; margin-bottom: 14px; }
  .banner { border-radius: 10px; padding: 10px 14px; margin: 0 0 16px; font-size: 0.92rem; }
  .banner.ok { background: rgba(38,208,160,0.08); border: 1px solid rgba(38,208,160,0.3); color: #26d0a0; }
  .banner.err { background: rgba(255,130,130,0.07); border: 1px solid rgba(255,130,130,0.28); color: #ff9c9c; }
  .banner.warn { background: rgba(217,185,108,0.07); border: 1px solid rgba(217,185,108,0.32); color: #d9b96c; }
  .banner strong { color: inherit; }
  .custody { color: #6d7ea6; font-size: 0.85rem; border-left: 3px solid #7aa2ff; padding-left: 12px; margin: 16px 0; }
  label { display: block; color: #6d7ea6; font-size: 0.84rem; margin: 14px 0 5px; }
  input[type=text], input[type=email], select, textarea { width: 100%; background: #101a33; color: #f4f7ff; border: 1px solid rgba(120,150,220,0.22); border-radius: 8px; padding: 8px 10px; font: inherit; }
  input:focus, select:focus, textarea:focus { outline: 1px solid #7aa2ff; }
  textarea { min-height: 74px; font-family: Consolas, ui-monospace, monospace; font-size: 0.85rem; }
  .row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; }
  /* The shipping section is revealed by the checkbox alone: no script, no external resource.
     It stays in the document when hidden, so a saved address is posted back unchanged. */
  input.toggle { width: auto; margin: 18px 8px 0 0; vertical-align: middle; }
  label.togglelabel { display: inline; color: #f4f7ff; font-size: 0.92rem; margin: 0; }
  .ship { display: none; margin-top: 16px; padding: 4px 16px 16px; background: #101a33; border: 1px solid rgba(120,150,220,0.15); border-radius: 10px; }
  input.toggle:checked ~ .ship { display: block; }
  .ship h3 { color: #f4f7ff; font-size: 0.95rem; font-weight: 600; margin: 16px 0 2px; }
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  button { background: #7aa2ff; color: #0b1020; font-weight: 600; border: 0; border-radius: 8px; padding: 8px 18px; font-family: inherit; font-size: inherit; cursor: pointer; margin-top: 18px; }
  button.ghost { background: transparent; color: #9fb0d0; font-weight: 500; border: 1px solid rgba(120,150,220,0.3); }
  button.danger { background: transparent; color: #ff9c9c; font-weight: 500; border: 1px solid rgba(255,130,130,0.35); }
  .actions { display: flex; gap: 10px; }
  .actions form { margin: 0; }
  .meta { color: #6d7ea6; font-size: 0.83rem; }
  .title { color: #f4f7ff; margin: 2px 0; }
  .cardhead { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .amount { color: #26d0a0; font-size: 1.28rem; font-weight: 650; letter-spacing: -0.02em; }
  .money { color: #26d0a0; }
  .tag { display: inline-block; font-size: 0.74rem; border-radius: 999px; padding: 1px 10px; vertical-align: middle; }
  .tag.pending { color: #d9b96c; background: rgba(217,185,108,0.08); border: 1px solid rgba(217,185,108,0.35); }
  .tag.approved { color: #7aa2ff; background: rgba(122,162,255,0.08); border: 1px solid rgba(122,162,255,0.35); }
  .tag.rejected { color: #ff9c9c; background: rgba(255,130,130,0.07); border: 1px solid rgba(255,130,130,0.3); }
  .tag.expired { color: #6d7ea6; background: #101a33; border: 1px solid rgba(120,150,220,0.2); }
  .tag.paid { color: #26d0a0; background: rgba(38,208,160,0.08); border: 1px solid rgba(38,208,160,0.35); }
  .fail { color: #ff9c9c; font-size: 0.85rem; border-left: 3px solid rgba(255,130,130,0.5); padding-left: 12px; margin: 12px 0; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px; margin-bottom: 16px; }
  .stat .k { color: #6d7ea6; font-size: 0.78rem; margin-bottom: 2px; }
  .stat .v { color: #f4f7ff; font-size: 1.12rem; font-weight: 600; }
  .bar { height: 8px; margin: 8px 0 6px; background: #101a33; border: 1px solid rgba(120,150,220,0.15); border-radius: 999px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: #26d0a0; }
  .bar i.full { background: #ff9c9c; }
  .searchrow { display: flex; gap: 10px; align-items: center; }
  .searchrow input { flex: 1; }
  .searchrow button { margin-top: 0; }
  .offer { display: flex; justify-content: space-between; gap: 16px; align-items: center; flex-wrap: wrap; }
  .offer form { display: flex; gap: 10px; align-items: center; margin: 0; }
  .offer form input { width: 64px; text-align: center; }
  .offer form button { margin-top: 0; }
  .chan { display: flex; gap: 12px; align-items: baseline; margin: 8px 0; }
  .chan .st { flex: 0 0 auto; font-size: 0.72rem; border-radius: 999px; padding: 1px 10px; }
  .chan .st.on { color: #26d0a0; border: 1px solid rgba(38,208,160,0.35); }
  .chan .st.off { color: #6d7ea6; border: 1px solid rgba(120,150,220,0.25); }
  .chan strong { color: #f4f7ff; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid rgba(120,150,220,0.12); }
  th { color: #6d7ea6; font-weight: 500; font-size: 0.8rem; }
  td { color: #9fb0d0; }
  .timeline { list-style: none; margin: 0; padding: 0 0 0 8px; }
  .timeline li { position: relative; padding: 0 0 18px 22px; border-left: 1px solid rgba(120,150,220,0.18); }
  .timeline li:last-child { border-left-color: transparent; }
  .timeline li::before { content: ""; position: absolute; left: -5px; top: 5px; width: 9px; height: 9px; border-radius: 50%; background: #7aa2ff; }
  .timeline li.k-ok::before { background: #26d0a0; }
  .timeline li.k-err::before { background: #ff9c9c; }
  .timeline li.k-muted::before { background: #6d7ea6; }
  .tl-label { color: #f4f7ff; font-weight: 600; font-size: 0.92rem; margin-right: 10px; }
  .tl-when { color: #6d7ea6; font-size: 0.8rem; font-family: Consolas, ui-monospace, monospace; }
  .tl-detail { color: #9fb0d0; font-size: 0.88rem; margin-top: 1px; word-break: break-word; }
  code, .mono { font-family: Consolas, ui-monospace, monospace; font-size: 0.85em; color: #b9ccff; word-break: break-all; }
  pre { background: #101a33; border: 1px solid rgba(120,150,220,0.15); border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
  .empty { color: #6d7ea6; padding: 22px 0; text-align: center; }
`;

/** ISO timestamp -> "2026-09-07 14:32 UTC" (all our timestamps are already UTC). */
function fmtWhen(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

function netBadge(network: string): string {
  return network === "mainnet"
    ? `<span class="net main">red principal</span>`
    : `<span class="net">red de prueba (${esc(network)})</span>`;
}

/** Public explorer link for a settled transaction. A link only; the page loads nothing external. */
function txLink(network: string, txHash: string): string {
  const net = network === "mainnet" ? "public" : "testnet";
  const href = `https://stellar.expert/explorer/${net}/tx/${encodeURIComponent(txHash)}`;
  return `<a class="mono" href="${esc(href)}" rel="noopener noreferrer">${esc(txHash)}</a>`;
}

export interface LayoutInput {
  title: string;
  active: "home" | "proposals" | "activity";
  network: string;
  pendingCount: number;
  body: string;
}

export function layout(input: LayoutInput): string {
  const tab = (href: string, id: LayoutInput["active"], label: string) =>
    `<a href="${href}"${input.active === id ? " data-on" : ""}>${esc(label)}</a>`;
  const proposalsLabel =
    input.pendingCount > 0 ? `Propuestas (${input.pendingCount})` : "Propuestas";
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.title)} · AgentPOS, espacio del comprador</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="wordmark">AGENT<span class="pos">POS</span></span>
    <span class="space">Espacio del comprador</span>
    ${netBadge(input.network)}
    <nav>
      ${tab("/", "home", "Inicio")}
      ${tab("/proposals", "proposals", proposalsLabel)}
      ${tab("/activity", "activity", "Actividad")}
    </nav>
  </header>
  <div class="assure">
    <span>Tu llave nunca sale de tu maquina</span>
    <span>Limites de gasto que tu defines</span>
    <span>Cada compra con comprobante firmado</span>
  </div>
  ${input.body}
</div>
</body>
</html>`;
}

// --- shared bits -------------------------------------------------------------

const STATUS_LABEL: Record<Proposal["status"], string> = {
  pending: "pendiente",
  approved: "esperando firma",
  rejected: "rechazada",
  expired: "expirada",
  paid: "pagada",
};

function statusTag(status: Proposal["status"]): string {
  return `<span class="tag ${status}">${esc(STATUS_LABEL[status])}</span>`;
}

const PERIOD_ES: Record<string, string> = { day: "dia", week: "semana", month: "mes" };

function periodEs(period: string): string {
  return PERIOD_ES[period] ?? period;
}

function proposalMeta(p: Proposal): string {
  return `<div class="meta">${esc(p.storeName)} · <span class="mono">${esc(p.storeUrl)}</span> · propuesta el ${esc(fmtWhen(p.createdAt))}</div>`;
}

/**
 * Where a physical purchase lands, for the human to double check before approving. City and
 * country only: the full address lives in the mandate and is never printed on a page.
 */
function shippingLine(p: Proposal, shipping: { city: string; country: string } | undefined): string {
  if (!p.physical) return "";
  return shipping
    ? `<div class="meta">Producto fisico: se despacha a ${esc(shipping.city)}, ${esc(shipping.country)}.</div>`
    : `<div class="fail">Producto fisico sin direccion de despacho guardada: la tienda no puede despachar. Agrega tu direccion en el mandato antes de aprobar.</div>`;
}

interface PageError {
  code: string;
  message: string;
  hint: string;
}

function errBanner(error: PageError): string {
  return `<div class="banner err"><strong>${esc(error.code)}</strong>: ${esc(error.message)}<br><span class="meta">${esc(error.hint)}</span></div>`;
}

// --- home: mandate state, offer search, mandate editor, channels -------------

/** Every field a string, so a rejected form re-renders exactly what the human typed. */
export interface ShippingFormValues {
  name: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  phone: string;
}

export interface MandateFormValues {
  maxPerTx: string;
  maxTotal: string;
  period: string;
  stores: string;
  allowPhysicalGoods: boolean;
  email: string;
  shipping: ShippingFormValues;
  walletAddress: string;
}

export interface ChannelsState {
  /** True when at least one WhatsApp provider is mounted. */
  whatsapp: boolean;
  /** True when the signing bridge (/api/signer/*) is mounted. */
  signer: boolean;
}

export interface OfferSearch {
  query: string;
  offers?: Offer[];
  error?: PageError;
}

/**
 * Visual budget bar. Amount math is done in minor units (bigint); only the final
 * percentage, an integer 0..100 for a CSS width, leaves bigint land.
 */
function spendBar(spentDecimal: string, maxTotalDecimal: string, period: string): string {
  const spent = usdc(spentDecimal);
  const total = usdc(maxTotalDecimal);
  const remaining = formatUsdc(usdcFromMinor(total > spent ? total - spent : 0n));
  const pct = total > 0n ? Math.min(100, Number((spent * 100n) / total)) : 0;
  return `
    <div class="meta">Aprobado en este periodo: <span class="money">${esc(spentDecimal)} USDC</span> de ${esc(maxTotalDecimal)} USDC por ${esc(periodEs(period))}</div>
    <div class="bar"><i${pct >= 100 ? ' class="full"' : ""} style="width:${String(pct)}%"></i></div>
    <div class="meta">Disponible: <span class="money">${esc(remaining)} USDC</span></div>`;
}

function mandateState(status: ServiceStatus): string {
  const m = status.mandate;
  if (!m) {
    return `<div class="card"><div class="meta">Aun no hay mandato. Guarda abajo los limites de gasto para que tu agente pueda actuar.</div></div>`;
  }
  const wallet = status.walletLinked ? "Vinculada" : "Sin vincular";
  // City and country only: the street address never reaches a page, a log or the history.
  const shippingLine = status.shipping
    ? `Despacho a ${status.shipping.city}, ${status.shipping.country}`
    : "Sin direccion de despacho guardada";
  const storesLine =
    status.stores.length > 0
      ? `${String(status.stores.length)} tienda(s) permitida(s)`
      : "Cualquier tienda permitida (agrega URLs abajo para acotar y poder buscar)";
  return `
  <h2>Estado del mandato</h2>
  <div class="card">
    <div class="stats">
      <div class="stat"><div class="k">Maximo por compra</div><div class="v money">${esc(m.maxPerTx)} USDC</div></div>
      <div class="stat"><div class="k">Maximo por periodo</div><div class="v money">${esc(m.maxTotal)} USDC</div></div>
      <div class="stat"><div class="k">Periodo</div><div class="v">${esc(periodEs(m.period))}</div></div>
      <div class="stat"><div class="k">Wallet</div><div class="v">${esc(wallet)}</div></div>
    </div>
    ${spendBar(status.approvedInPeriod, m.maxTotal, m.period)}
    <div class="meta" style="margin-top:8px">${esc(storesLine)} · Bienes fisicos: ${m.allowPhysicalGoods ? "permitidos" : "no permitidos"} · ${esc(shippingLine)}</div>
    <div class="meta">Propuestas pendientes: ${String(status.pendingProposals)} · Esperando firma: ${String(status.approvedAwaitingSignature)}</div>
  </div>`;
}

function offerSearchSection(status: ServiceStatus, search: OfferSearch | undefined): string {
  if (!status.profileConfigured) {
    return `
  <h2>Buscador de ofertas</h2>
  <div class="card"><div class="meta">Guarda primero tu mandato: la busqueda usa tus tiendas permitidas y tus limites.</div></div>`;
  }
  const form = `
  <form method="get" action="/" class="card">
    <div class="searchrow">
      <input type="text" name="q" value="${esc(search?.query ?? "")}" placeholder="Que quieres comprar, por ejemplo: taza" aria-label="Buscar ofertas">
      <button type="submit">Buscar</button>
    </div>
    <p class="meta" style="margin:10px 0 0">Busca solo en tus tiendas permitidas. Proponer no compra nada: toda compra pasa por tu aprobacion y se firma en tu maquina.</p>
  </form>`;
  let results = "";
  if (search?.error) {
    results = errBanner(search.error);
  } else if (search?.offers) {
    results =
      search.offers.length === 0
        ? `<div class="empty">Sin resultados para "${esc(search.query)}" en tus tiendas.</div>`
        : search.offers
            .map(
              (o) => `
  <div class="card offer">
    <div>
      <div class="title">${esc(o.title)}</div>
      <div class="meta">${esc(o.siteName)} · <span class="mono">${esc(o.site)}</span></div>
    </div>
    <div class="amount">${esc(o.price.amount)} ${esc(o.price.asset)}</div>
    <form method="post" action="/proposals">
      <input type="hidden" name="storeUrl" value="${esc(o.site)}">
      <input type="hidden" name="itemId" value="${esc(o.id)}">
      <input type="text" name="quantity" value="1" inputmode="numeric" aria-label="Cantidad">
      <button type="submit" class="ghost">Proponer compra</button>
    </form>
  </div>`,
            )
            .join("");
  }
  return `
  <h2>Buscador de ofertas</h2>
  ${form}
  ${results}`;
}

function channelsSection(channels: ChannelsState): string {
  const row = (on: boolean, head: string, rest: string) => `
    <div class="chan">
      <span class="st ${on ? "on" : "off"}">${on ? "Activo" : "No configurado"}</span>
      <div><strong>${esc(head)}</strong>. ${esc(rest)}</div>
    </div>`;
  const whatsapp = channels.whatsapp
    ? row(true, "Canal WhatsApp activo", "Puedes buscar, proponer y aprobar desde tu telefono.")
    : row(
        false,
        "Canal WhatsApp",
        "Para activarlo, define WHATSAPP_ALLOWED_NUMBERS y las credenciales de Meta o Twilio en el entorno del servidor.",
      );
  const signer = channels.signer
    ? row(
        true,
        "Puente de firma configurado",
        "Tu watcher local (agentpos-buyer watch) firmara los pagos aprobados; el dinero solo se mueve desde tu maquina.",
      )
    : row(
        false,
        "Puente de firma",
        "Para activarlo, define SIGNER_TOKEN en este servidor y ejecuta agentpos-buyer watch en la maquina donde vive tu wallet.",
      );
  return `
  <h2>Canales</h2>
  <div class="card">
    ${whatsapp}
    ${signer}
  </div>`;
}

export function homePage(options: {
  values: MandateFormValues;
  network: string;
  status: ServiceStatus;
  channels: ChannelsState;
  saved?: boolean;
  error?: PageError;
  search?: OfferSearch;
}): string {
  const v = options.values;
  const banner = options.error
    ? errBanner(options.error)
    : options.saved
      ? `<div class="banner ok">Mandato guardado. El agente lo obedece desde la proxima accion.</div>`
      : "";
  // The state this platform must never hide: physical goods allowed with nowhere to ship.
  const shippingWarning = options.status.physicalWithoutShipping
    ? `<div class="banner warn"><strong>Tu mandato permite bienes fisicos, pero no hay a donde despachar.</strong> Sin direccion de despacho y correo de contacto la tienda no puede enviar el paquete y la compra falla al pagar.<br><span class="meta">Agrega tu direccion de despacho abajo o desactiva bienes fisicos.</span></div>`
    : "";
  const period = (value: string, label: string) =>
    `<option value="${value}"${v.period === value ? " selected" : ""}>${label}</option>`;
  const ship = (
    id: string,
    name: string,
    label: string,
    value: string,
    extra = "",
  ) => `<label for="${id}">${esc(label)}</label>
      <input type="text" id="${id}" name="${name}" value="${esc(value)}"${extra}>`;
  const body = `
  <p class="lead">Tu agente de compras: busca, propone y tu apruebas.</p>
  <p class="sub">El agente nunca puede cambiar tus limites ni pagar solo: cada compra espera tu aprobacion y se firma en tu propia maquina.</p>
  ${banner}
  ${shippingWarning}
  ${mandateState(options.status)}
  ${offerSearchSection(options.status, options.search)}
  <h2>Mandato</h2>
  <p class="sub" style="margin-bottom:12px">Lo que tu agente tiene permitido hacer. El agente no puede editar esta pagina; solo tu.</p>
  <form method="post" action="/profile" class="card">
    <div class="row">
      <div>
        <label for="maxPerTx">Maximo por compra (USDC)</label>
        <input type="text" id="maxPerTx" name="maxPerTx" value="${esc(v.maxPerTx)}" inputmode="decimal" required>
      </div>
      <div>
        <label for="maxTotal">Maximo por periodo (USDC)</label>
        <input type="text" id="maxTotal" name="maxTotal" value="${esc(v.maxTotal)}" inputmode="decimal" required>
      </div>
      <div>
        <label for="period">Periodo</label>
        <select id="period" name="period">
          ${period("day", "Dia")}${period("week", "Semana")}${period("month", "Mes")}
        </select>
      </div>
    </div>
    <label for="stores">Tiendas permitidas (una URL por linea; vacio permite cualquier tienda)</label>
    <textarea id="stores" name="stores" placeholder="https://tienda.ejemplo">${esc(v.stores)}</textarea>
    <input type="checkbox" class="toggle" id="allowPhysicalGoods" name="allowPhysicalGoods"${v.allowPhysicalGoods ? " checked" : ""}>
    <label class="togglelabel" for="allowPhysicalGoods">Permitir bienes fisicos (cosas que se envian a una direccion)</label>
    <div class="ship">
      <h3>Direccion de despacho</h3>
      <p class="meta" style="margin:2px 0 0">La tienda necesita esta direccion y tu correo de contacto para despachar. Se guarda aqui y viaja solo a la tienda donde compras; en esta pagina se muestran unicamente la ciudad y el pais.</p>
      ${ship("shipName", "shipName", "Nombre de quien recibe", v.shipping.name, ' autocomplete="name"')}
      ${ship("shipLine1", "shipLine1", "Direccion (calle y numero)", v.shipping.line1, ' autocomplete="address-line1"')}
      ${ship("shipLine2", "shipLine2", "Departamento, oficina o referencia (opcional)", v.shipping.line2, ' autocomplete="address-line2"')}
      <div class="row">
        <div>${ship("shipCity", "shipCity", "Ciudad", v.shipping.city, ' autocomplete="address-level2"')}</div>
        <div>${ship("shipRegion", "shipRegion", "Region o estado (opcional)", v.shipping.region, ' autocomplete="address-level1"')}</div>
        <div>${ship("shipPostalCode", "shipPostalCode", "Codigo postal", v.shipping.postalCode, ' autocomplete="postal-code"')}</div>
      </div>
      <div class="row2">
        <div>${ship("shipCountry", "shipCountry", "Pais (codigo de dos letras, por ejemplo CL)", v.shipping.country, ' maxlength="2" style="text-transform:uppercase" autocomplete="country"')}</div>
        <div>${ship("shipPhone", "shipPhone", "Telefono de contacto (opcional)", v.shipping.phone, ' autocomplete="tel"')}</div>
      </div>
    </div>
    <label for="email">Tu correo de contacto (las tiendas envian alli las novedades de la orden; obligatorio si permites bienes fisicos)</label>
    <input type="email" id="email" name="email" value="${esc(v.email)}" placeholder="tu@ejemplo.com">
    <label for="walletAddress">Direccion publica de tu wallet (empieza con G)</label>
    <input type="text" id="walletAddress" name="walletAddress" value="${esc(v.walletAddress)}" placeholder="G...">
    <p class="custody">Esta plataforma nunca guarda ni pide una llave secreta. Los pagos se firman en tu propia maquina; aqui solo vinculas la direccion publica para que tu agente sepa de que wallet trata el mandato.</p>
    <button type="submit">Guardar mandato</button>
  </form>
  ${channelsSection(options.channels)}`;
  return layout({
    title: "Inicio",
    active: "home",
    network: options.network,
    pendingCount: options.status.pendingProposals,
    body,
  });
}

// --- proposals ---------------------------------------------------------------

export function proposalsPage(options: {
  pending: Proposal[];
  approved: Proposal[];
  paid: Proposal[];
  stores: string[];
  network: string;
  /** City and country on file, shown on physical proposals so the human can check it. */
  shipping?: { city: string; country: string };
  signerConfigured: boolean;
  instructionsFor: (p: Proposal) => { checkoutUrl: string; cli: string; note: string };
  highlight?: string;
}): string {
  const pendingCards = options.pending
    .map(
      (p) => `
  <div class="card">
    <div class="cardhead"><span class="amount">${esc(p.amount)} ${esc(p.asset)}</span>${statusTag(p.status)}</div>
    <div class="title">${esc(p.title)}</div>
    ${proposalMeta(p)}
    ${shippingLine(p, options.shipping)}
    <div class="meta">Cotizacion congelada, valida hasta ${esc(fmtWhen(p.cartExpiresAt))}.</div>
    <div class="actions">
      <form method="post" action="/proposals/${esc(p.id)}/approve"><button type="submit">Aprobar</button></form>
      <form method="post" action="/proposals/${esc(p.id)}/reject"><button type="submit" class="danger">Rechazar</button></form>
    </div>
  </div>`,
    )
    .join("");

  const signingNote = options.signerConfigured
    ? "Puente de firma configurado: tu watcher local firmara este pago; el dinero solo se mueve desde tu maquina."
    : "Tu watcher local firmara este pago; el dinero solo se mueve desde tu maquina. Deja corriendo agentpos-buyer watch, o ejecuta el comando de abajo, donde vive tu wallet.";

  const approvedCards = options.approved
    .map((p) => {
      const i = options.instructionsFor(p);
      const failure = p.failure
        ? `<div class="fail">El ultimo intento de pago fallo con <strong>${esc(p.failure.code)}</strong>: ${esc(p.failure.message)} (${esc(fmtWhen(p.failure.at))})</div>`
        : "";
      return `
  <div class="card"${options.highlight === p.id ? ' style="border-color:#7aa2ff"' : ""}>
    <div class="cardhead"><span class="amount">${esc(p.amount)} ${esc(p.asset)}</span>${statusTag(p.status)}</div>
    <div class="title">${esc(p.title)}</div>
    ${proposalMeta(p)}
    ${shippingLine(p, options.shipping)}
    ${failure}
    <p class="custody">${esc(signingNote)}</p>
    <div class="meta">Pago (checkout): <span class="mono">${esc(i.checkoutUrl)}</span></div>
    <div class="meta">Para pagar a mano desde la maquina que tiene tu llave:</div>
    <pre><code>${esc(i.cli)}</code></pre>
    <div class="actions">
      <form method="post" action="/proposals/${esc(p.id)}/reject"><button type="submit" class="ghost">Cancelar aprobacion</button></form>
    </div>
  </div>`;
    })
    .join("");

  const paidCards = options.paid
    .map(
      (p) => `
  <div class="card">
    <div class="cardhead"><span class="amount">${esc(p.amount)} ${esc(p.asset)}</span>${statusTag(p.status)}</div>
    <div class="title">${esc(p.title)}</div>
    ${proposalMeta(p)}
    ${
      p.payment
        ? `<div class="meta">Pago liquidado el ${esc(fmtWhen(p.payment.paidAt))} · orden <span class="mono">${esc(p.payment.orderId)}</span></div>
    <div class="meta">Transaccion: ${txLink(options.network, p.payment.txHash)}</div>`
        : ""
    }
  </div>`,
    )
    .join("");

  const storeOptions = options.stores
    .map((s) => `<option value="${esc(s)}">${esc(s)}</option>`)
    .join("");
  const proposeForm =
    options.stores.length > 0
      ? `
  <h2>Proponer una compra tu mismo</h2>
  <form method="post" action="/proposals" class="card">
    <div class="row">
      <div>
        <label for="storeUrl">Tienda</label>
        <select id="storeUrl" name="storeUrl">${storeOptions}</select>
      </div>
      <div>
        <label for="itemId">Id del producto</label>
        <input type="text" id="itemId" name="itemId" required>
      </div>
      <div>
        <label for="quantity">Cantidad</label>
        <input type="text" id="quantity" name="quantity" value="1" inputmode="numeric">
      </div>
    </div>
    <button type="submit" class="ghost">Pedir cotizacion</button>
  </form>`
      : "";

  const body = `
  <p class="sub">Lo que tu agente quiere comprar. Nada se cobra hasta que apruebas, y la firma sale siempre de tu propia maquina.</p>
  <h2>Esperando tu decision</h2>
  ${pendingCards || '<div class="empty">No hay propuestas pendientes.</div>'}
  <h2>Aprobadas, esperando firma</h2>
  ${approvedCards || '<div class="empty">Nada aprobado sin pagar.</div>'}
  ${paidCards ? `<h2>Pagadas</h2>${paidCards}` : ""}
  ${proposeForm}`;
  return layout({
    title: "Propuestas",
    active: "proposals",
    network: options.network,
    pendingCount: options.pending.length,
    body,
  });
}

// --- activity ----------------------------------------------------------------

const KIND_LABEL: Record<ActivityEntry["kind"], string> = {
  "profile.saved": "mandato guardado",
  search: "busqueda",
  "proposal.created": "propuesta creada",
  "proposal.approved": "propuesta aprobada",
  "proposal.rejected": "propuesta rechazada",
  "proposal.expired": "cotizacion expirada",
  "signer.queue": "cola entregada al firmador",
  "proposal.paid": "pago liquidado",
  "proposal.payment_failed": "pago fallido",
};

/** Dot color on the timeline: green for money settled, red for failures, muted for noise. */
const KIND_CLASS: Partial<Record<ActivityEntry["kind"], string>> = {
  "proposal.paid": "k-ok",
  "proposal.payment_failed": "k-err",
  "proposal.rejected": "k-err",
  "proposal.expired": "k-muted",
  search: "k-muted",
  "signer.queue": "k-muted",
};

function activitySummary(e: ActivityEntry): string {
  const d = e.data;
  switch (e.kind) {
    case "profile.saved":
      return `limite ${String(d.maxPerTx)} USDC por compra, ${String(d.maxTotal)} USDC por ${periodEs(String(d.period))}`;
    case "search":
      return `"${String(d.query)}" · ${String(d.results)} resultado(s)`;
    case "signer.queue":
      return `${String(d.proposals)} propuesta(s) entregadas al firmador local`;
    case "proposal.paid":
      return `${String(d.title)} · ${String(d.amount)} USDC · transaccion ${String(d.txHash)}`;
    case "proposal.payment_failed":
      return `${String(d.title)} · ${String(d.code)}: ${String(d.message)}`;
    default:
      return [d.title, d.amount !== undefined ? `${String(d.amount)} USDC` : undefined]
        .filter((x) => x !== undefined)
        .map(String)
        .join(" · ");
  }
}

export function activityPage(options: {
  activity: ActivityEntry[];
  proposals: Proposal[];
  status: ServiceStatus;
  network: string;
}): string {
  const timeline = options.activity
    .map((e) => {
      const detail = activitySummary(e);
      return `<li${KIND_CLASS[e.kind] ? ` class="${KIND_CLASS[e.kind]}"` : ""}>
      <span class="tl-label">${esc(KIND_LABEL[e.kind] ?? e.kind)}</span><span class="tl-when">${esc(fmtWhen(e.at))}</span>
      ${detail ? `<div class="tl-detail">${esc(detail)}</div>` : ""}
    </li>`;
    })
    .join("");
  const history = options.proposals
    .map(
      (p) =>
        `<tr><td class="meta">${esc(fmtWhen(p.createdAt))}</td><td>${esc(p.title)}</td><td class="money">${esc(p.amount)} ${esc(p.asset)}</td><td>${statusTag(p.status)}${p.payment ? ` <span class="mono">${esc(p.payment.txHash)}</span>` : ""}</td></tr>`,
    )
    .join("");
  const s = options.status;
  const body = `
  <p class="sub">Todo lo que hicieron tu agente y tu, en orden. Aprobado en este periodo: <span class="money">${esc(s.approvedInPeriod)} USDC</span>${s.mandate ? ` de ${esc(s.mandate.maxTotal)} USDC permitidos por ${esc(periodEs(s.mandate.period))}` : ""}.</p>
  <h2>Historial de propuestas</h2>
  <div class="card">
    ${history ? `<table><tr><th>Fecha</th><th>Detalle</th><th>Monto</th><th>Estado</th></tr>${history}</table>` : '<div class="empty">Aun no hay propuestas.</div>'}
  </div>
  <h2>Linea de tiempo</h2>
  <div class="card">
    ${timeline ? `<ol class="timeline">${timeline}</ol>` : '<div class="empty">Nada todavia.</div>'}
  </div>`;
  return layout({
    title: "Actividad",
    active: "activity",
    network: options.network,
    pendingCount: s.pendingProposals,
    body,
  });
}

// --- error -------------------------------------------------------------------

export function errorPage(options: {
  network: string;
  pendingCount: number;
  code: string;
  message: string;
  hint: string;
  backHref: string;
}): string {
  const body = `
  <div class="banner err"><strong>${esc(options.code)}</strong>: ${esc(options.message)}</div>
  <p class="meta">${esc(options.hint)}</p>
  <p><a href="${esc(options.backHref)}">Volver a propuestas</a></p>`;
  return layout({
    title: "Error",
    active: "proposals",
    network: options.network,
    pendingCount: options.pendingCount,
    body,
  });
}
