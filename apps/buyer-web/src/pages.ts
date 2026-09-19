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
import type { MandateBlock, MarketCallResult, MarketOffer } from "@agentpos/mcp-buyer";
import { CSRF_FIELD } from "./auth/http.js";
import type { AccessEntry, ActivityEntry, Proposal, ServiceStatus } from "./types.js";

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
  .who { display: flex; align-items: center; gap: 10px; padding-left: 14px; margin-left: 14px; border-left: 1px solid rgba(120,150,220,0.25); }
  .who form { margin: 0; }
  .whoemail { color: #6d7ea6; font-size: 0.82rem; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button.linkish { background: transparent; color: #9fb0d0; font-weight: 500; border: 1px solid rgba(120,150,220,0.3); border-radius: 8px; padding: 3px 12px; margin: 0; font-size: 0.84rem; }
  .gate { max-width: 420px; margin: 40px auto 0; }
  .gate button { width: 100%; }
  input[type=password] { width: 100%; background: #101a33; color: #f4f7ff; border: 1px solid rgba(120,150,220,0.22); border-radius: 8px; padding: 8px 10px; font: inherit; }
  .confirm { margin-top: 14px; padding: 12px 14px; background: #101a33; border: 1px solid rgba(217,185,108,0.32); border-radius: 10px; }
  .confirm .k { color: #d9b96c; font-size: 0.84rem; margin-bottom: 6px; }
  .confirm label { margin-top: 8px; }
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
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid rgba(120,150,220,0.12); vertical-align: top; }
  td form { margin: 0; }
  td button { margin-top: 0; white-space: nowrap; }
  td .title { display: block; }
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
  .codes { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin: 14px 0; }
  .codes li { list-style: none; font-family: Consolas, ui-monospace, monospace; font-size: 1.02rem; letter-spacing: 0.06em; color: #f4f7ff; background: #101a33; border: 1px solid rgba(120,150,220,0.22); border-radius: 8px; padding: 8px 10px; text-align: center; }
  ol.codes { padding: 0; margin: 14px 0; }
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

/** The signed-in owner, as the header shows them. Absent on /login and /setup. */
export interface SessionView {
  email: string;
  csrf: string;
}

export interface LayoutInput {
  title: string;
  /** "none" is the signed-out chrome: wordmark and network badge, no tabs, no session. */
  active: "home" | "proposals" | "activity" | "account" | "none";
  network: string;
  pendingCount: number;
  body: string;
  session?: SessionView;
  /**
   * The nudge for an installation that predates recovery codes: it offers to generate a
   * set, and can be put away for this session. It comes back on the next one until codes
   * exist, because "I cannot get back in" is not a problem to discover on the bad day.
   */
  reminder?: { csrf: string; next: string };
}

/** The hidden field every state-changing form carries. Empty renders nothing. */
export function csrfInput(token: string | undefined): string {
  return token ? `<input type="hidden" name="${CSRF_FIELD}" value="${esc(token)}">` : "";
}

export function layout(input: LayoutInput): string {
  const tab = (href: string, id: LayoutInput["active"], label: string) =>
    `<a href="${href}"${input.active === id ? " data-on" : ""}>${esc(label)}</a>`;
  const proposalsLabel =
    input.pendingCount > 0 ? `Propuestas (${input.pendingCount})` : "Propuestas";
  const nav = input.session
    ? `<nav>
      ${tab("/", "home", "Inicio")}
      ${tab("/proposals", "proposals", proposalsLabel)}
      ${tab("/activity", "activity", "Actividad")}
      ${tab("/cuenta", "account", "Cuenta")}
    </nav>
    <div class="who">
      <span class="whoemail">${esc(input.session.email)}</span>
      <form method="post" action="/logout">${csrfInput(input.session.csrf)}<button type="submit" class="linkish">Salir</button></form>
    </div>`
    : "";
  const reminder = input.reminder
    ? `<div class="banner warn">
    <strong>Todavia no tienes codigos de recuperacion.</strong> Son diez codigos en papel, la
    unica forma de volver a entrar si olvidas la contrasena y nadie mas tiene acceso a este
    servidor. Se muestran una sola vez.<br>
    <span class="meta">Se generan en un segundo y no cambian nada de lo que ya funciona.</span>
    <div class="actions">
      <form method="post" action="/cuenta/codigos">${csrfInput(input.reminder.csrf)}<button type="submit">Generar mis codigos</button></form>
      <form method="post" action="/cuenta/recordatorio">${csrfInput(input.reminder.csrf)}<input type="hidden" name="next" value="${esc(input.reminder.next)}"><button type="submit" class="ghost">Ahora no</button></form>
    </div>
  </div>`
    : "";
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(input.title)} · AgentPOS, espacio del comprador</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="wordmark">AGENT<span class="pos">POS</span></span>
    <span class="space">Espacio del comprador</span>
    ${netBadge(input.network)}
    ${nav}
  </header>
  <div class="assure">
    <span>Tu llave nunca sale de tu maquina</span>
    <span>Limites de gasto que tu defines</span>
    <span>Cada compra con comprobante firmado</span>
  </div>
  ${reminder}
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
function shippingLine(
  p: Proposal,
  shipping: { city: string; country: string } | undefined,
): string {
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

// --- the way in: login and first-run setup -----------------------------------

/**
 * The login form. It says nothing about which accounts exist, on purpose: the refusal for
 * an unknown correo and for a wrong contrasena is the same sentence.
 */
export function loginPage(options: {
  network: string;
  next?: string;
  error?: PageError;
  notice?: string;
}): string {
  const body = `
  <div class="gate">
    <p class="lead">Entra a tu espacio</p>
    <p class="sub">Aqui se definen tus limites de gasto y se aprueban los pagos que tu maquina firma. Solo entra el dueno.</p>
    ${options.error ? errBanner(options.error) : ""}
    ${options.notice ? `<div class="banner ok">${esc(options.notice)}</div>` : ""}
    <form method="post" action="/login" class="card">
      <input type="hidden" name="next" value="${esc(options.next ?? "/")}">
      <label for="email">Correo</label>
      <input type="email" id="email" name="email" autocomplete="username" required>
      <label for="password">Contrasena</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required>
      <button type="submit">Entrar</button>
    </form>
    <p class="meta"><a href="/recuperar">Olvide mi contrasena</a></p>
    <p class="custody">Esta plataforma nunca guarda ni pide una llave secreta de wallet. Tu contrasena se guarda solo como un hash scrypt; ni nosotros ni nadie puede leerla desde la base de datos.</p>
  </div>`;
  return layout({
    title: "Entrar",
    active: "none",
    network: options.network,
    pendingCount: 0,
    body,
  });
}

/** First run: the one and only owner account. After this, /setup answers 404 forever. */
export function setupPage(options: {
  network: string;
  email?: string;
  error?: PageError;
}): string {
  const body = `
  <div class="gate">
    <p class="lead">Crea tu cuenta de dueno</p>
    <p class="sub">Esta instalacion todavia no tiene dueno. La cuenta se crea una sola vez y es la unica que puede cambiar tus limites y aprobar pagos.</p>
    ${options.error ? errBanner(options.error) : ""}
    <form method="post" action="/setup" class="card">
      <label for="email">Correo</label>
      <input type="email" id="email" name="email" value="${esc(options.email ?? "")}" autocomplete="username" required>
      <label for="password">Contrasena (minimo 12 caracteres)</label>
      <input type="password" id="password" name="password" autocomplete="new-password" required minlength="12">
      <label for="confirm">Repite la contrasena</label>
      <input type="password" id="confirm" name="confirm" autocomplete="new-password" required minlength="12">
      <button type="submit">Crear cuenta y entrar</button>
    </form>
    <p class="custody">Guarda esta contrasena donde guardas las importantes. No hay correo de recuperacion, a proposito: esto corre en tu servidor y tu servidor no tiene por que saber enviar correo. Apenas entres te mostramos diez codigos de recuperacion en papel, una sola vez.</p>
  </div>`;
  return layout({
    title: "Crear cuenta",
    active: "none",
    network: options.network,
    pendingCount: 0,
    body,
  });
}

// --- getting back in: recovery ------------------------------------------------

/**
 * The recovery form. It never says whether that email has an account here, and it never
 * says which of the two fields was wrong: one refusal, always the same words.
 *
 * Why there is no "send me an email": this runs on the owner's own server, and a
 * self-hosted box has no mail server to send from. The page says so, in one line, instead
 * of leaving a person hunting for a link that was never going to arrive.
 */
export function recoverPage(options: {
  network: string;
  /** True when WHATSAPP_ALLOWED_NUMBERS and a provider are configured. */
  whatsapp: boolean;
  email?: string;
  error?: PageError;
  /** Shown after asking for a code. Always the same sentence, whatever happened. */
  notice?: string;
}): string {
  const email = esc(options.email ?? "");
  const whatsapp = options.whatsapp
    ? `
    <form method="post" action="/recuperar/whatsapp" class="card">
      <p class="lead" style="font-size:1rem">O pide un codigo por WhatsApp</p>
      <p class="sub" style="margin-bottom:0">Llega solo al numero del dueno que esta en la lista del servidor, nunca a otro. Vale 10 minutos.</p>
      <label for="wemail">Correo</label>
      <input type="email" id="wemail" name="email" value="${email}" autocomplete="username" required>
      <button type="submit" class="ghost">Enviar codigo a mi WhatsApp</button>
    </form>`
    : "";
  const body = `
  <div class="gate">
    <p class="lead">Recuperar tu acceso</p>
    <p class="sub">Escribe tu correo y uno de tus codigos de recuperacion. Si el codigo sirve, lo unico que podras hacer es fijar una contrasena nueva.</p>
    ${options.error ? errBanner(options.error) : ""}
    ${options.notice ? `<div class="banner ok">${esc(options.notice)}</div>` : ""}
    <form method="post" action="/recuperar" class="card">
      <label for="email">Correo</label>
      <input type="email" id="email" name="email" value="${email}" autocomplete="username" required>
      <label for="code">Codigo de recuperacion (o el codigo de 6 digitos que pediste por WhatsApp)</label>
      <input type="text" id="code" name="code" placeholder="ABCD-EFGH-JKLM" autocomplete="one-time-code" required>
      <button type="submit">Continuar</button>
    </form>
    ${whatsapp}
    <p class="custody">Aqui no hay correo de recuperacion, y no es un olvido: este espacio corre en tu propio servidor, que no tiene por que saber enviar correo. Si perdiste la contrasena y no tienes codigos, la ultima via es la linea de comandos del servidor: <span class="mono">node dist/auth/recover-cli.js</span> imprime un enlace de un solo uso. Queda registrado en Accesos.</p>
  </div>`;
  return layout({
    title: "Recuperar acceso",
    active: "none",
    network: options.network,
    pendingCount: 0,
    body,
  });
}

/** The one thing a recovery session can do. Nothing else on this site answers it. */
export function newPasswordPage(options: {
  network: string;
  csrf: string;
  error?: PageError;
}): string {
  const body = `
  <div class="gate">
    <p class="lead">Elige una contrasena nueva</p>
    <p class="sub">Con esto termina la recuperacion. Se cierran todas las sesiones abiertas, la tuya incluida y la de cualquiera que estuviera dentro, y entras de nuevo con la contrasena nueva.</p>
    ${options.error ? errBanner(options.error) : ""}
    <form method="post" action="/recuperar/nueva-clave" class="card">
      ${csrfInput(options.csrf)}
      <label for="password">Contrasena nueva (minimo 12 caracteres)</label>
      <input type="password" id="password" name="password" autocomplete="new-password" required minlength="12">
      <label for="confirm">Repite la contrasena nueva</label>
      <input type="password" id="confirm" name="confirm" autocomplete="new-password" required minlength="12">
      <button type="submit">Guardar y cerrar todas las sesiones</button>
    </form>
    <p class="custody">Esta sesion de recuperacion no puede ver tu mandato, tus propuestas ni aprobar un pago. Solo sirve para esto, y dura 15 minutos.</p>
  </div>`;
  return layout({
    title: "Contrasena nueva",
    active: "none",
    network: options.network,
    pendingCount: 0,
    body,
  });
}

/**
 * What the operator's one-time URL opens: a confirmation, not the recovery itself. The
 * token is spent by the POST, so nothing that merely fetches the link (a chat preview, a
 * crawler, an antivirus proxy) can burn it.
 */
export function operatorRecoveryPage(options: {
  network: string;
  token: string;
  error?: PageError;
}): string {
  const body = `
  <div class="gate">
    <p class="lead">Enlace de recuperacion del servidor</p>
    <p class="sub">Este enlace lo genero alguien con acceso a la linea de comandos del servidor. Salta la contrasena, se usa una sola vez y queda registrado en el panel Accesos.</p>
    ${options.error ? errBanner(options.error) : ""}
    <form method="post" action="/recuperar/operador" class="card">
      <input type="hidden" name="token" value="${esc(options.token)}">
      <p class="meta" style="margin:0">Si no fuiste tu quien lo genero, cierra esta pagina y revisa Accesos.</p>
      <button type="submit">Continuar y fijar una contrasena nueva</button>
    </form>
  </div>`;
  return layout({
    title: "Enlace del servidor",
    active: "none",
    network: options.network,
    pendingCount: 0,
    body,
  });
}

// --- the account page ---------------------------------------------------------

/**
 * The ten codes, printed once. This page is the only time they exist outside the owner's
 * hands: only their scrypt hashes are kept, so there is no second chance to read them.
 */
export function recoveryCodesPage(options: {
  network: string;
  codes: string[];
  session: SessionView;
  pendingCount: number;
}): string {
  const items = options.codes.map((c) => `<li>${esc(c)}</li>`).join("");
  const body = `
  <p class="lead">Tus codigos de recuperacion</p>
  <div class="banner warn"><strong>Guardalas ahora: no se vuelven a mostrar.</strong> Imprimelas o copialas a donde guardas lo importante. Si cierras esta pagina sin copiarlas, tendras que generar un juego nuevo.</div>
  <div class="card">
    <ol class="codes">${items}</ol>
    <p class="meta">Cada codigo sirve una sola vez. Con uno de ellos y tu correo entras en <span class="mono">/recuperar</span> y fijas una contrasena nueva; al terminar se cierran todas las sesiones.</p>
    <p class="meta">Generar un juego nuevo anula estos ${String(options.codes.length)} al instante.</p>
  </div>
  <p><a href="/cuenta">Volver a mi cuenta</a></p>`;
  return layout({
    title: "Codigos de recuperacion",
    active: "account",
    network: options.network,
    pendingCount: options.pendingCount,
    session: options.session,
    body,
  });
}

/** Change the password, and look after the codes. Everything about the account, one page. */
export function accountPage(options: {
  network: string;
  session: SessionView;
  pendingCount: number;
  codes: { total: number; unused: number };
  /** True when the WhatsApp route is available as a second way back in. */
  whatsapp: boolean;
  saved?: boolean;
  error?: PageError;
}): string {
  const csrf = options.session.csrf;
  const codesState =
    options.codes.total === 0
      ? `<div class="banner warn"><strong>No tienes codigos de recuperacion.</strong> Sin ellos, si olvidas la contrasena solo queda la linea de comandos del servidor.</div>`
      : `<div class="meta">Te quedan <strong style="color:#f4f7ff">${String(options.codes.unused)}</strong> de ${String(options.codes.total)} codigos sin usar.</div>`;
  const whatsappLine = options.whatsapp
    ? `<div class="chan"><span class="st on">Activo</span><div><strong>Codigo por WhatsApp</strong>. Puedes pedir un codigo de 6 digitos desde /recuperar; llega solo al numero del dueno que esta en la lista del servidor.</div></div>`
    : `<div class="chan"><span class="st off">No configurado</span><div><strong>Codigo por WhatsApp</strong>. Se activa solo si defines WHATSAPP_ALLOWED_NUMBERS y las credenciales de Meta o Twilio en el servidor.</div></div>`;
  const body = `
  <p class="lead">Tu cuenta</p>
  <p class="sub">La contrasena que protege tus limites de gasto, y las formas de volver a entrar si la pierdes.</p>
  ${options.error ? errBanner(options.error) : ""}
  ${options.saved ? `<div class="banner ok">Contrasena cambiada. Las otras sesiones se cerraron; esta sigue abierta.</div>` : ""}
  <h2>Cambiar la contrasena</h2>
  <form method="post" action="/cuenta/clave" class="card">
    ${csrfInput(csrf)}
    <label for="current">Tu contrasena actual</label>
    <input type="password" id="current" name="current" autocomplete="current-password" required>
    <label for="password">Contrasena nueva (minimo 12 caracteres)</label>
    <input type="password" id="password" name="password" autocomplete="new-password" required minlength="12">
    <label for="confirm">Repite la contrasena nueva</label>
    <input type="password" id="confirm" name="confirm" autocomplete="new-password" required minlength="12">
    <p class="meta" style="margin:12px 0 0">Al guardar se cierran todas las demas sesiones. Esta, en la que estas escribiendo, sigue abierta.</p>
    <button type="submit">Cambiar contrasena</button>
  </form>
  <h2>Codigos de recuperacion</h2>
  <div class="card">
    ${codesState}
    <p class="meta" style="margin-top:10px">Diez codigos en papel, cada uno de un solo uso. Es la via que siempre funciona: no necesita correo, ni telefono, ni acceso al servidor.</p>
    <form method="post" action="/cuenta/codigos">
      ${csrfInput(csrf)}
      <button type="submit" class="${options.codes.total === 0 ? "" : "ghost"}">Generar codigos nuevos</button>
    </form>
    <p class="meta" style="margin:10px 0 0">Generar codigos nuevos anula los anteriores, usados o no. Se muestran una sola vez.</p>
  </div>
  <h2>Otras formas de volver a entrar</h2>
  <div class="card">
    ${whatsappLine}
    <div class="chan"><span class="st on">Siempre</span><div><strong>Linea de comandos del servidor</strong>. Quien pueda correr comandos en el servidor genera un enlace de un solo uso con <span class="mono">node dist/auth/recover-cli.js</span>. Vence a los 15 minutos y queda registrado en Accesos.</div></div>
    <p class="custody">No hay recuperacion por correo, y es deliberado: este espacio corre en tu propio servidor, que no tiene servidor de correo. Un boton que promete un correo que nunca llega es peor que no tenerlo.</p>
  </div>`;
  return layout({
    title: "Cuenta",
    active: "account",
    network: options.network,
    pendingCount: options.pendingCount,
    session: options.session,
    body,
  });
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

/** Rows the market call form posts back, kept as typed so nothing is lost on a refusal. */
export interface MarketFormValues {
  what: string;
  /** Free `clave=valor` rows: attribute names differ from store to store. */
  attributes: string[];
  maxPriceUsdc: string;
  quantity: string;
  /** "" (any), "true" (only physical) or "false" (only digital). */
  physical: string;
}

export interface MarketSearch {
  values: MarketFormValues;
  result?: MarketCallResult;
  error?: PageError;
}

/** Attribute rows the form always shows. Enough for a real query, few enough to stay readable. */
export const MARKET_ATTRIBUTE_ROWS = 3;

export function emptyMarketForm(): MarketFormValues {
  return {
    what: "",
    attributes: Array.from({ length: MARKET_ATTRIBUTE_ROWS }, () => ""),
    maxPriceUsdc: "",
    quantity: "1",
    physical: "",
  };
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

/** Why an offer cannot be paid, said the way the person who wrote the mandate would say it. */
const BLOCK_ES: Record<MandateBlock["reason"], string> = {
  per_payment_cap: "supera tu maximo por compra",
  period_budget: "supera lo que queda de tu limite del periodo",
  physical_not_allowed: "es un producto fisico y tu mandato no los permite",
  seller_not_allowed: "la tienda no esta en tu lista permitida",
};

const STORE_STATE_ES: Record<string, string> = {
  ok: "respondio",
  timeout: "no respondio a tiempo",
  error: "error",
  "unsupported-filters": "no entiende los filtros; se filtro aqui",
  "not-allowed": "fuera de tu mandato, no se consulto",
};

const STORE_STATE_CLASS: Record<string, string> = {
  ok: "on",
  timeout: "off",
  error: "off",
  "unsupported-filters": "on",
  "not-allowed": "off",
};

/** The market call as a query string, so a facet can be turned into a one-click refinement. */
function marketHref(values: MarketFormValues, extraAttribute?: string): string {
  const params = new URLSearchParams();
  if (values.what) params.set("q", values.what);
  const rows = values.attributes.map((a) => a.trim()).filter(Boolean);
  if (extraAttribute && !rows.includes(extraAttribute)) rows.push(extraAttribute);
  for (const row of rows) params.append("attr", row);
  if (values.maxPriceUsdc) params.set("max", values.maxPriceUsdc);
  if (values.quantity && values.quantity !== "1") params.set("qty", values.quantity);
  if (values.physical) params.set("physical", values.physical);
  return `/?${params.toString()}`;
}

function payableCell(offer: MarketOffer): string {
  if (offer.mandate.payable) {
    return offer.mandate.needsApproval
      ? `<span class="tag approved">si, con tu aprobacion</span>`
      : `<span class="tag paid">si</span>`;
  }
  const reasons = offer.mandate.blocks.map((b) => BLOCK_ES[b.reason]).join("; ");
  return `<span class="tag rejected">no</span><div class="meta">${esc(reasons)}</div>`;
}

function offerRow(offer: MarketOffer, quantity: number, csrf: string): string {
  const shown =
    Object.keys(offer.matchedAttributes).length > 0 ? offer.matchedAttributes : offer.attributes;
  const attributes = Object.entries(shown)
    .map(([name, value]) => `${name}: ${value}`)
    .join(" · ");
  const outOfStock =
    offer.stock === "out_of_stock"
      ? `<div class="meta">Sin stock en la tienda</div>`
      : offer.stock === "unknown"
        ? `<div class="meta">Stock no informado</div>`
        : "";
  return `
      <tr>
        <td>${esc(offer.store.name)}<div class="meta mono">${esc(offer.store.host)}</div></td>
        <td><span class="title">${esc(offer.title)}</span>${attributes ? `<div class="meta">${esc(attributes)}</div>` : ""}${offer.physical ? `<div class="meta">Producto fisico</div>` : ""}${outOfStock}</td>
        <td class="money">${esc(offer.unitPrice)}</td>
        <td class="money">${esc(offer.totalUsdc)} ${esc(offer.asset)}</td>
        <td>${payableCell(offer)}</td>
        <td>
          <form method="post" action="/proposals">
            ${csrfInput(csrf)}
            <input type="hidden" name="storeUrl" value="${esc(offer.store.url)}">
            <input type="hidden" name="itemId" value="${esc(offer.itemId)}">
            <input type="hidden" name="quantity" value="${esc(String(quantity))}">
            <button type="submit" class="ghost">Proponer compra</button>
          </form>
        </td>
      </tr>`;
}

function storesSection(result: MarketCallResult): string {
  const rows = result.stores
    .map((store) => {
      const label = STORE_STATE_ES[store.state] ?? store.state;
      const detail = store.error
        ? `<div class="meta">${esc(store.error.message)}</div>`
        : store.truncated
          ? `<div class="meta">Se leyeron ${String(store.offers)} de ${String(store.total ?? store.offers)} resultados.</div>`
          : "";
      return `
    <div class="chan">
      <span class="st ${STORE_STATE_CLASS[store.state] ?? "off"}">${esc(label)}</span>
      <div><strong>${esc(store.name)}</strong> · ${String(store.offers)} oferta(s) · <span class="mono">${esc(store.url)}</span>${detail}</div>
    </div>`;
    })
    .join("");
  return `
  <h2>Quien respondio</h2>
  <div class="card">${rows || '<div class="meta">Ninguna tienda fue consultada.</div>'}</div>`;
}

function facetsSection(values: MarketFormValues, result: MarketCallResult): string {
  const groups = Object.entries(result.facets);
  if (groups.length === 0) return "";
  const rows = groups
    .map(([name, entries]) => {
      const links = entries
        .map(
          (v) =>
            `<a href="${esc(marketHref(values, `${name}=${v.value}`))}">${esc(v.value)} (${String(v.count)})</a>`,
        )
        .join(" · ");
      return `<div class="meta" style="margin:6px 0"><strong style="color:#f4f7ff">${esc(name)}</strong>: ${links}</div>`;
    })
    .join("");
  return `
  <h2>Afinar el pedido</h2>
  <div class="card">
    ${rows}
    <p class="meta" style="margin:10px 0 0">Un clic agrega el filtro a tu pedido y vuelve a preguntar a todas tus tiendas.</p>
  </div>`;
}

function marketSection(
  status: ServiceStatus,
  search: MarketSearch | undefined,
  csrf: string,
): string {
  if (!status.profileConfigured) {
    return `
  <h2>Llamado al mercado</h2>
  <div class="card"><div class="meta">Guarda primero tu mandato: el llamado usa tus tiendas permitidas y tus limites.</div></div>`;
  }
  const values = search?.values ?? emptyMarketForm();
  const attributeRows = values.attributes
    .map(
      (row, i) =>
        `<input type="text" id="attr${String(i)}" name="attr" value="${esc(row)}" placeholder="${i === 0 ? "Fondo=blanco" : i === 1 ? "Passepartout=con" : "clave=valor"}" aria-label="Filtro ${String(i + 1)}">`,
    )
    .join("\n      ");
  const physicalOption = (value: string, label: string) =>
    `<option value="${value}"${values.physical === value ? " selected" : ""}>${label}</option>`;
  const form = `
  <form method="get" action="/" class="card">
    <div class="searchrow">
      <input type="text" name="q" value="${esc(values.what)}" placeholder="Que quieres comprar, por ejemplo: lamina 30x40" aria-label="Que buscas">
      <button type="submit">Preguntar a mis tiendas</button>
    </div>
    <label for="attr0">Caracteristicas (clave=valor, una por campo; los nombres los pone cada tienda)</label>
    <div class="row">
      ${attributeRows}
    </div>
    <div class="row">
      <div>
        <label for="max">Precio maximo por unidad (USDC, opcional)</label>
        <input type="text" id="max" name="max" value="${esc(values.maxPriceUsdc)}" inputmode="decimal" placeholder="40">
      </div>
      <div>
        <label for="qty">Cantidad</label>
        <input type="text" id="qty" name="qty" value="${esc(values.quantity)}" inputmode="numeric">
      </div>
      <div>
        <label for="physical">Tipo de producto</label>
        <select id="physical" name="physical">
          ${physicalOption("", "Cualquiera")}${physicalOption("true", "Solo fisicos")}${physicalOption("false", "Solo digitales")}
        </select>
      </div>
    </div>
    <p class="meta" style="margin:10px 0 0">Se pregunta lo mismo a todas tus tiendas permitidas, al mismo tiempo. Proponer no compra nada: toda compra pasa por tu aprobacion y se firma en tu maquina.</p>
  </form>`;
  if (search?.error) {
    return `
  <h2>Llamado al mercado</h2>
  ${form}
  ${errBanner(search.error)}`;
  }
  const result = search?.result;
  if (!result) {
    return `
  <h2>Llamado al mercado</h2>
  ${form}`;
  }
  const quantity = result.query.quantity;
  const table =
    result.offers.length === 0
      ? `<div class="empty">Ninguna tienda tiene algo para "${esc(result.query.what)}" con esas caracteristicas.</div>`
      : `
  <div class="card">
    <table>
      <tr><th>Tienda</th><th>Producto</th><th>Unitario</th><th>Total x${String(quantity)}</th><th>Pagable</th><th></th></tr>
      ${result.offers.map((o) => offerRow(o, quantity, csrf)).join("")}
    </table>
    <p class="meta" style="margin:12px 0 0">${String(result.offers.length)} oferta(s), de la mas barata a la mas cara, para ${String(quantity)} unidad(es). Una oferta marcada "no" se muestra igual: es tu limite el que la frena, no la tienda.</p>
  </div>`;
  return `
  <h2>Llamado al mercado</h2>
  ${form}
  ${table}
  ${storesSection(result)}
  ${facetsSection(values, result)}`;
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
  session: SessionView;
  saved?: boolean;
  error?: PageError;
  market?: MarketSearch;
  reminder?: { csrf: string; next: string };
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
  ${marketSection(options.status, options.market, options.session.csrf)}
  <h2>Mandato</h2>
  <p class="sub" style="margin-bottom:12px">Lo que tu agente tiene permitido hacer. El agente no puede editar esta pagina; solo tu.</p>
  <form method="post" action="/profile" class="card">
    ${csrfInput(options.session.csrf)}
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
    session: options.session,
    ...(options.reminder ? { reminder: options.reminder } : {}),
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
  session: SessionView;
  /** True when approving this proposal asks for the password again. */
  needsReauth: (p: Proposal) => boolean;
  highlight?: string;
  /** Shown on the proposal whose re-authentication was just refused. */
  reauthError?: { proposalId: string; message: string };
  reminder?: { csrf: string; next: string };
}): string {
  const csrf = options.session.csrf;
  const pendingCards = options.pending
    .map((p) => {
      // Approving is the moment this space commits money, so above the confirmation
      // threshold the password is asked again, right here, with the amount and the store
      // written next to the field: nobody approves by muscle memory on a borrowed screen.
      const failed =
        options.reauthError?.proposalId === p.id
          ? `<div class="fail">${esc(options.reauthError.message)}</div>`
          : "";
      const confirm = options.needsReauth(p)
        ? `
      <div class="confirm">
        <div class="k">Confirma con tu contrasena: vas a aprobar ${esc(p.amount)} ${esc(p.asset)} en ${esc(p.storeName)}.</div>
        ${failed}
        <label for="pw-${esc(p.id)}">Tu contrasena</label>
        <input type="password" id="pw-${esc(p.id)}" name="password" autocomplete="current-password" required>
      </div>`
        : failed;
      return `
  <div class="card">
    <div class="cardhead"><span class="amount">${esc(p.amount)} ${esc(p.asset)}</span>${statusTag(p.status)}</div>
    <div class="title">${esc(p.title)}</div>
    ${proposalMeta(p)}
    ${shippingLine(p, options.shipping)}
    <div class="meta">Cotizacion congelada, valida hasta ${esc(fmtWhen(p.cartExpiresAt))}.</div>
    <form method="post" action="/proposals/${esc(p.id)}/approve">
      ${csrfInput(csrf)}
      ${confirm}
      <div class="actions"><button type="submit">Aprobar</button></div>
    </form>
    <div class="actions">
      <form method="post" action="/proposals/${esc(p.id)}/reject">${csrfInput(csrf)}<button type="submit" class="danger">Rechazar</button></form>
    </div>
  </div>`;
    })
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
      <form method="post" action="/proposals/${esc(p.id)}/reject">${csrfInput(csrf)}<button type="submit" class="ghost">Cancelar aprobacion</button></form>
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
    ${csrfInput(csrf)}
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
    session: options.session,
    ...(options.reminder ? { reminder: options.reminder } : {}),
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

const ACCESS_LABEL: Record<AccessEntry["event"], string> = {
  setup: "cuenta creada",
  login_ok: "entrada correcta",
  login_failed: "intento fallido",
  login_rate_limited: "intento bloqueado",
  logout: "salida",
  session_expired: "sesion expirada",
  approval: "propuesta aprobada",
  reauth_failed: "contrasena incorrecta al aprobar",
  csrf_invalid: "formulario sin token valido",
  recovery_codes_generated: "codigos de recuperacion nuevos",
  recovery_code_sent: "codigo enviado por WhatsApp",
  recovery_started: "recuperacion iniciada",
  recovery_failed: "codigo de recuperacion rechazado",
  recovery_rate_limited: "recuperacion bloqueada",
  recovery_completed: "contrasena recuperada",
  password_changed: "contrasena cambiada",
  operator_token_issued: "enlace de recuperacion del servidor",
};

/** Red for what someone else may have done, green for money decisions, muted for routine. */
const ACCESS_CLASS: Partial<Record<AccessEntry["event"], string>> = {
  login_failed: "rejected",
  login_rate_limited: "rejected",
  reauth_failed: "rejected",
  csrf_invalid: "rejected",
  approval: "paid",
  session_expired: "expired",
  logout: "expired",
  recovery_failed: "rejected",
  recovery_rate_limited: "rejected",
  recovery_started: "pending",
  recovery_code_sent: "pending",
  operator_token_issued: "pending",
  recovery_completed: "paid",
  password_changed: "paid",
  recovery_codes_generated: "approved",
};

/**
 * The panel that answers "has anyone else been here?". Everything it shows is a hash or a
 * coarse label: the address, the browser and the email never land in this table whole.
 */
function accessSection(access: AccessEntry[]): string {
  if (access.length === 0) {
    return `
  <h2>Accesos</h2>
  <div class="card"><div class="empty">Sin registros todavia.</div></div>`;
  }
  const rows = access
    .map(
      (a) =>
        `<tr><td class="meta">${esc(fmtWhen(a.at))}</td><td><span class="tag ${ACCESS_CLASS[a.event] ?? "approved"}">${esc(ACCESS_LABEL[a.event] ?? a.event)}</span></td><td class="meta mono">${esc(a.ipHash)}</td><td class="meta">${esc(a.uaFamily)}</td><td class="meta">${esc(a.detail)}</td></tr>`,
    )
    .join("");
  return `
  <h2>Accesos</h2>
  <div class="card">
    <table><tr><th>Fecha</th><th>Que paso</th><th>Origen</th><th>Navegador</th><th>Detalle</th></tr>${rows}</table>
    <p class="meta" style="margin:12px 0 0">El origen es un hash corto de la direccion IP, no la direccion: sirve para reconocer "esto fui yo, desde casa" sin guardar de donde te conectas. Intentos fallidos seguidos de nada son ruido de internet; intentos fallidos seguidos de una entrada correcta que no reconoces, no.</p>
  </div>`;
}

export function activityPage(options: {
  activity: ActivityEntry[];
  proposals: Proposal[];
  status: ServiceStatus;
  network: string;
  session: SessionView;
  access: AccessEntry[];
  reminder?: { csrf: string; next: string };
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
  </div>
  ${accessSection(options.access)}`;
  return layout({
    title: "Actividad",
    active: "activity",
    network: options.network,
    pendingCount: s.pendingProposals,
    session: options.session,
    ...(options.reminder ? { reminder: options.reminder } : {}),
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
  backLabel?: string;
  /** Absent for an anonymous visitor: the error page must not render a session that is not there. */
  session?: SessionView;
}): string {
  const body = `
  <div class="banner err"><strong>${esc(options.code)}</strong>: ${esc(options.message)}</div>
  <p class="meta">${esc(options.hint)}</p>
  <p><a href="${esc(options.backHref)}">${esc(options.backLabel ?? "Volver a propuestas")}</a></p>`;
  return layout({
    title: "Error",
    active: options.session ? "proposals" : "none",
    network: options.network,
    pendingCount: options.pendingCount,
    ...(options.session ? { session: options.session } : {}),
    body,
  });
}
