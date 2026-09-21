/**
 * Server-rendered pages for the buyer's control room ("Sala de control"), Spanish-first.
 * Same constraints as packages/site/src/dashboard.ts: one self-contained HTML document per
 * page, zero external resources (no CDN, no fonts, no analytics, no script) and nothing
 * interpolated without escaping. Plain forms, no client framework.
 *
 * Identity (docs/DISENO.md, temperament 4: "poder con límites"). This surface is not the
 * installer and not the merchant panel: it is a personal control room for money. Violet
 * `--accent` for anything agentic, green `--state-money` ONLY for money and settled facts,
 * amber `--state-wait` for what is waiting on a human decision, muted red `--state-stop`
 * for what the mandate blocked or what failed. Every state colour comes from a token in
 * STATE_TOKENS; no page writes a colour of its own.
 *
 * Spanish is written with its accents. A surface that approves payments and misspells
 * "contrasena" loses authority before the first decision.
 */
import { formatUsdc, usdc, usdcFromMinor } from "@agentpos/core";
import type { MandateBlock, MarketCallResult, MarketOffer } from "@agentpos/mcp-buyer";
import { CSRF_FIELD } from "./auth/http.js";
import type { AccessEntry, ActivityEntry, Proposal, ServiceStatus } from "./types.js";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The state palette, as CSS custom property names. Everything that paints a state (a tag,
 * a card edge, a timeline dot, a market verdict) resolves its colour through this map, so
 * the temperature of the surface can only be changed in one place.
 *
 * - `--state-wait` (ambar): waiting on a human decision.
 * - `--state-agent` (violeta): the agent's turn, nothing settled yet.
 * - `--state-money` (verde): money moved, a fact.
 * - `--state-stop` (rojo apagado): the mandate said no, or the attempt failed.
 * - `--state-off` (gris): expired or irrelevant, no alarm.
 */
export const STATE_TOKENS = {
  pending: "--state-wait",
  approved: "--state-agent",
  paid: "--state-money",
  rejected: "--state-stop",
  expired: "--state-off",
} as const satisfies Record<Proposal["status"], string>;

/** `.tag.<status>`, `.edge-<status>` and `.dot-<status>`, generated from STATE_TOKENS. */
const stateRules = (): string =>
  Object.entries(STATE_TOKENS)
    .map(([status, token]) => {
      const soft = `${token}-soft`;
      return [
        `.tag.${status} { color: var(${token}); background: var(${soft}); border-color: var(${token}); }`,
        `.edge-${status} { border-left-color: var(${token}); }`,
        `.dot-${status}::before { background: var(${token}); }`,
        `.on-${status} { color: var(${token}); }`,
      ].join("\n  ");
    })
    .join("\n  ");

/**
 * The whole stylesheet, exported so a test can assert the state colours are token driven
 * and that nothing paints a state with a literal.
 */
export const BUYER_CSS = `
  :root {
    color-scheme: dark;
    --bg: #080b17;
    --surface: #0e1326;
    --surface-2: #141a30;
    --line: rgba(150,138,225,0.16);
    --line-2: rgba(150,138,225,0.28);
    --ink: #f3f1ff;
    --body: #a8afca;
    --muted: #7b83a6;
    --accent: #9a7cf5;
    --accent-ink: #c3b0ff;
    --accent-soft: rgba(154,124,245,0.12);
    --state-wait: #f2b544;
    --state-wait-soft: rgba(242,181,68,0.10);
    --state-agent: #b49bff;
    --state-agent-soft: rgba(154,124,245,0.12);
    --state-money: #26d0a0;
    --state-money-soft: rgba(38,208,160,0.10);
    --state-stop: #e08a8a;
    --state-stop-soft: rgba(224,138,138,0.09);
    --state-off: #7b83a6;
    --state-off-soft: rgba(123,131,166,0.10);
    --mono: Consolas, ui-monospace, "SFMono-Regular", monospace;
    --r-control: 6px;
    --r-card: 10px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background:
      radial-gradient(1100px 420px at 50% -220px, rgba(154,124,245,0.13), transparent 70%),
      var(--bg);
    color: var(--body);
    font: 15px/1.55 "Segoe UI", system-ui, sans-serif;
  }
  .wrap { max-width: 960px; margin: 0 auto; padding: 22px 16px 72px; }
  a { color: var(--accent-ink); }
  a:hover { color: var(--ink); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }

  /* --- chrome ------------------------------------------------------------- */
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding-bottom: 14px; border-bottom: 1px solid var(--line); }
  .wordmark { color: var(--ink); font-weight: 700; font-size: 1.05rem; letter-spacing: 0.10em; }
  .wordmark .pos { color: var(--accent); }
  .space { color: var(--muted); font-size: 0.86rem; letter-spacing: 0.02em; border-left: 1px solid var(--line-2); padding-left: 12px; }
  .net { font-family: var(--mono); font-size: 0.72rem; border-radius: 999px; padding: 2px 10px; border: 1px solid var(--line-2); color: var(--body); white-space: nowrap; }
  .net.main { color: var(--state-money); border-color: var(--state-money); }
  nav { margin-left: auto; display: flex; gap: 4px; flex-wrap: wrap; }
  nav a { color: var(--body); text-decoration: none; font-size: 0.92rem; padding: 10px 12px; min-height: 44px; display: inline-flex; align-items: center; border-bottom: 2px solid transparent; }
  nav a[data-on] { color: var(--ink); border-bottom-color: var(--accent); }
  nav a:hover { color: var(--ink); }
  .who { display: flex; align-items: center; gap: 10px; padding-left: 12px; border-left: 1px solid var(--line-2); }
  .who form { margin: 0; }
  .whoemail { color: var(--muted); font-size: 0.8rem; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .assure { display: flex; flex-wrap: wrap; gap: 4px 20px; margin: 14px 0 22px; padding: 10px 14px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); color: var(--muted); font-size: 0.82rem; }
  .assure span::before { content: "\\2713"; color: var(--accent); margin-right: 7px; }

  /* --- type --------------------------------------------------------------- */
  h2 { color: var(--ink); font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.14em; margin: 34px 0 12px; font-weight: 600; }
  h3 { color: var(--ink); font-size: 0.95rem; font-weight: 600; margin: 16px 0 2px; }
  .lead { color: var(--ink); font-size: 1.34rem; font-weight: 650; margin: 6px 0 4px; letter-spacing: -0.015em; }
  .sub { color: var(--muted); margin: 0 0 20px; }
  .meta { color: var(--muted); font-size: 0.83rem; }
  .title { color: var(--ink); margin: 2px 0; }
  code, .mono { font-family: var(--mono); font-size: 0.85em; color: var(--accent-ink); word-break: break-all; }
  .money { color: var(--state-money); }

  /* --- surfaces ----------------------------------------------------------- */
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); padding: 18px; margin-bottom: 14px; }
  .card.edge { border-left-width: 4px; border-left-style: solid; border-left-color: var(--line-2); }
  .banner { border-radius: var(--r-card); padding: 11px 14px; margin: 0 0 16px; font-size: 0.92rem; border: 1px solid; }
  .banner.ok { background: var(--state-money-soft); border-color: var(--state-money); color: var(--state-money); }
  .banner.err { background: var(--state-stop-soft); border-color: var(--state-stop); color: var(--state-stop); }
  .banner.warn { background: var(--state-wait-soft); border-color: var(--state-wait); color: var(--state-wait); }
  .banner strong { color: inherit; }
  .custody { color: var(--muted); font-size: 0.85rem; border-left: 3px solid var(--accent); padding-left: 12px; margin: 16px 0; }
  .fail { color: var(--state-stop); font-size: 0.85rem; border-left: 3px solid var(--state-stop); padding-left: 12px; margin: 12px 0; }
  .empty { color: var(--muted); padding: 22px 0; text-align: center; }
  pre { background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-control); padding: 10px 12px; overflow-x: auto; }

  /* --- controls ----------------------------------------------------------- */
  label { display: block; color: var(--muted); font-size: 0.84rem; margin: 14px 0 5px; }
  input[type=text], input[type=email], input[type=password], select, textarea {
    width: 100%; min-height: 44px; background: var(--surface-2); color: var(--ink);
    border: 1px solid var(--line-2); border-radius: var(--r-control); padding: 9px 11px; font: inherit;
  }
  textarea { min-height: 74px; font-family: var(--mono); font-size: 0.85rem; }
  button {
    background: var(--accent); color: #0b0716; font-weight: 650; border: 1px solid var(--accent);
    border-radius: var(--r-control); padding: 11px 20px; min-height: 44px; font-family: inherit;
    font-size: inherit; cursor: pointer; margin-top: 18px; transition: filter 140ms ease, background 140ms ease;
  }
  button:hover { filter: brightness(1.08); }
  button.ghost { background: transparent; color: var(--body); font-weight: 500; border-color: var(--line-2); }
  button.ghost:hover { color: var(--ink); border-color: var(--accent); }
  button.danger { background: transparent; color: var(--state-stop); font-weight: 600; border-color: var(--state-stop); }
  button.linkish { background: transparent; color: var(--body); font-weight: 500; border: 1px solid var(--line-2); padding: 8px 12px; min-height: 44px; margin: 0; font-size: 0.84rem; }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; }
  .actions form { margin: 0; }
  .row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; }
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 640px) { .row, .row2 { grid-template-columns: 1fr; } }

  /* --- the way in --------------------------------------------------------- */
  .gate { max-width: 440px; margin: 32px auto 0; }
  .gate button { width: 100%; }
  .gate .card { border-top: 3px solid var(--accent); }

  /* --- the mandate, as a contract ----------------------------------------- */
  .contract { background: var(--surface); border: 2px solid var(--line-2); border-radius: var(--r-card); padding: 20px; margin-bottom: 14px; position: relative; }
  .contract.live { border-color: var(--accent); }
  .contract-head { display: flex; align-items: flex-start; gap: 14px; flex-wrap: wrap; }
  .contract-head .lead { margin: 0; }
  .seal {
    margin-left: auto; font-size: 0.7rem; letter-spacing: 0.22em; text-transform: uppercase;
    color: var(--accent); border: 2px solid var(--accent); border-radius: 6px; padding: 5px 12px;
    transform: rotate(-3deg); white-space: nowrap;
  }
  .seal.none { color: var(--state-wait); border-color: var(--state-wait); }
  .limits { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; margin: 20px 0 4px; }
  .limit .k { color: var(--muted); font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 4px; }
  .limit .v { color: var(--ink); font-size: 1.7rem; font-weight: 650; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
  .limit .v small { font-size: 0.9rem; font-weight: 600; color: var(--muted); letter-spacing: 0; }
  .consumption { margin-top: 20px; padding-top: 16px; border-top: 1px dashed var(--line-2); }
  .consumption .heads { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; font-size: 0.83rem; color: var(--muted); }
  .consumption .heads b { font-variant-numeric: tabular-nums; font-weight: 650; }
  .bar { height: 10px; margin: 8px 0; background: var(--surface-2); border: 1px solid var(--line); border-radius: 999px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--state-money); transition: width 400ms ease; }
  .bar i.full { background: var(--state-stop); }
  .clauses { margin-top: 16px; padding-top: 14px; border-top: 1px dashed var(--line-2); display: grid; gap: 6px; }
  .clause { color: var(--body); font-size: 0.85rem; }
  .clause b { color: var(--ink); font-weight: 600; }
  details.editor { border: 1px solid var(--line); border-radius: var(--r-card); background: var(--surface); margin-bottom: 14px; }
  details.editor > summary { cursor: pointer; padding: 14px 18px; min-height: 44px; color: var(--accent-ink); font-size: 0.9rem; list-style: none; display: flex; align-items: center; gap: 10px; }
  details.editor > summary::-webkit-details-marker { display: none; }
  details.editor > summary::before { content: "+"; font-family: var(--mono); color: var(--accent); }
  details.editor[open] > summary::before { content: "\\2212"; }
  details.editor > form { border-top: 1px solid var(--line); margin: 0; padding: 4px 18px 20px; }

  /* --- decisions ---------------------------------------------------------- */
  .cardhead { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .amount { color: var(--ink); font-size: 1.9rem; font-weight: 650; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
  .tag { display: inline-block; font-size: 0.72rem; letter-spacing: 0.06em; text-transform: uppercase; border-radius: 999px; padding: 3px 11px; vertical-align: middle; border: 1px solid; }
  .confirm { margin: 18px 0 0; padding: 14px 16px; background: var(--surface-2); border: 1px solid var(--state-wait); border-radius: var(--r-card); }
  .confirm .step { color: var(--state-wait); font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.12em; }
  .confirm .k { color: var(--ink); font-size: 0.95rem; margin: 6px 0 2px; }
  .decide { margin-top: 18px; }
  .decide button { width: 100%; text-align: left; padding: 14px 18px; font-size: 1rem; }
  /* The gap is structural, not decorative: approve and reject never sit side by side, and
     this element always stands between them in the document. */
  .decision-gap { margin: 22px 0 14px; display: flex; align-items: center; gap: 14px; color: var(--muted); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.16em; }
  .decision-gap::before, .decision-gap::after { content: ""; flex: 1; height: 1px; background: var(--line); }
  .refuse button { width: 100%; text-align: left; padding: 13px 18px; }

  /* --- market call --------------------------------------------------------- */
  .searchrow { display: flex; gap: 10px; align-items: stretch; flex-wrap: wrap; }
  .searchrow input { flex: 1 1 240px; }
  .searchrow button { margin-top: 0; }
  .scroller { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: left; padding: 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.08em; }
  td { color: var(--body); }
  td form { margin: 0; }
  td button { margin-top: 0; white-space: nowrap; padding: 10px 14px; }
  td .title { display: block; }
  td.num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr.best td { background: var(--state-money-soft); }
  .chip { display: inline-block; font-size: 0.76rem; color: var(--body); background: var(--surface-2); border: 1px solid var(--line); border-radius: 999px; padding: 2px 9px; margin: 4px 4px 0 0; }
  .flag { display: inline-block; font-size: 0.7rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--state-money); border: 1px solid var(--state-money); border-radius: 999px; padding: 1px 8px; }
  .strip { display: flex; flex-wrap: wrap; gap: 8px; }
  .ans { display: inline-flex; align-items: baseline; gap: 8px; font-size: 0.8rem; color: var(--body); background: var(--surface-2); border: 1px solid var(--line); border-radius: 999px; padding: 5px 12px; }
  .ans b { color: var(--ink); font-weight: 600; }
  .ans i { font-style: normal; color: var(--muted); }
  .ans.up { border-color: var(--state-money); }
  .ans.down { border-color: var(--state-off); }
  .facets { display: grid; gap: 12px; }
  .facetrow { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .facetrow .fname { color: var(--ink); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.1em; }
  a.facet { display: inline-flex; align-items: center; min-height: 44px; text-decoration: none; color: var(--accent-ink); background: var(--accent-soft); border: 1px solid var(--line-2); border-radius: 999px; padding: 4px 13px; font-size: 0.85rem; transition: border-color 140ms ease, color 140ms ease; }
  a.facet:hover { border-color: var(--accent); color: var(--ink); }

  /* --- shipping reveal (CSS only, no script) ------------------------------- */
  input.toggle { width: auto; min-height: 0; margin: 18px 8px 0 0; vertical-align: middle; }
  label.togglelabel { display: inline; color: var(--ink); font-size: 0.92rem; margin: 0; }
  .ship { display: none; margin-top: 16px; padding: 4px 16px 16px; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-card); }
  input.toggle:checked ~ .ship { display: block; }

  /* --- channels, timeline, tables ------------------------------------------ */
  .chan { display: flex; gap: 12px; align-items: baseline; margin: 10px 0; }
  .chan .st { flex: 0 0 auto; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; border-radius: 999px; padding: 2px 10px; border: 1px solid; }
  .chan .st.on { color: var(--state-money); border-color: var(--state-money); }
  .chan .st.off { color: var(--state-off); border-color: var(--state-off); }
  .chan strong { color: var(--ink); font-weight: 600; }
  .timeline { list-style: none; margin: 0; padding: 0 0 0 8px; }
  .timeline li { position: relative; padding: 0 0 18px 22px; border-left: 1px solid var(--line); }
  .timeline li:last-child { border-left-color: transparent; }
  .timeline li::before { content: ""; position: absolute; left: -5px; top: 5px; width: 9px; height: 9px; border-radius: 50%; background: var(--accent); }
  .tl-label { color: var(--ink); font-weight: 600; font-size: 0.92rem; margin-right: 10px; }
  .tl-when { color: var(--muted); font-size: 0.8rem; font-family: var(--mono); }
  .tl-detail { color: var(--body); font-size: 0.88rem; margin-top: 1px; word-break: break-word; }

  /* --- the printable sheet -------------------------------------------------- */
  .sheet { border: 2px solid var(--line-2); border-radius: var(--r-card); padding: 22px; background: var(--surface); }
  .sheet .sheethead { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; border-bottom: 1px solid var(--line-2); padding-bottom: 12px; margin-bottom: 4px; }
  .sheet .sheettitle { color: var(--ink); font-weight: 650; letter-spacing: 0.02em; }
  ol.codes { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; padding: 0; margin: 18px 0; counter-reset: code; }
  ol.codes li { list-style: none; font-family: var(--mono); font-size: 1.05rem; letter-spacing: 0.08em; color: var(--ink); background: var(--surface-2); border: 1px solid var(--line-2); border-radius: var(--r-control); padding: 10px 12px; text-align: center; }
  .keepline { margin-top: 14px; color: var(--muted); font-size: 0.85rem; }

  ${stateRules()}

  @media print {
    body { background: #fff; color: #000; }
    header, nav, .who, .assure, .banner, .noprint, .net { display: none !important; }
    .wrap { max-width: none; padding: 0; }
    .sheet { border: 2px solid #000; background: #fff; }
    .sheet .sheettitle, ol.codes li { color: #000; }
    ol.codes li { background: #fff; border: 1px solid #000; }
    .keepline, .meta { color: #333; }
    a { color: #000; text-decoration: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
  }
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
   * exist, because "no puedo volver a entrar" is not a problem to discover on the bad day.
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
    input.pendingCount > 0 ? `Decisiones (${input.pendingCount})` : "Decisiones";
  const nav = input.session
    ? `<nav>
      ${tab("/", "home", "Mandato")}
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
    ? `<div class="banner warn noprint">
    <strong>Todavía no tienes códigos de recuperación.</strong> Son diez códigos en papel, la
    única forma de volver a entrar si olvidas la contraseña y nadie más tiene acceso a este
    servidor. Se muestran una sola vez.<br>
    <span class="meta">Se generan en un segundo y no cambian nada de lo que ya funciona.</span>
    <div class="actions">
      <form method="post" action="/cuenta/codigos">${csrfInput(input.reminder.csrf)}<button type="submit">Generar mis códigos</button></form>
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
<title>${esc(input.title)} · AgentPOS, sala de control</title>
<style>${BUYER_CSS}</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="wordmark">AGENT<span class="pos">POS</span></span>
    <span class="space">Sala de control</span>
    ${netBadge(input.network)}
    ${nav}
  </header>
  <div class="assure">
    <span>Tú apruebas cada pago</span>
    <span>Tu llave nunca sale de tu máquina</span>
    <span>Cada compra deja comprobante firmado</span>
  </div>
  ${reminder}
  ${input.body}
</div>
</body>
</html>`;
}

// --- shared bits -------------------------------------------------------------

const STATUS_LABEL: Record<Proposal["status"], string> = {
  pending: "esperando tu decisión",
  approved: "esperando firma",
  rejected: "rechazada",
  expired: "expirada",
  paid: "pagada",
};

function statusTag(status: Proposal["status"]): string {
  return `<span class="tag ${status}">${esc(STATUS_LABEL[status])}</span>`;
}

const PERIOD_ES: Record<string, string> = { day: "día", week: "semana", month: "mes" };

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
    ? `<div class="meta">Producto físico: se despacha a ${esc(shipping.city)}, ${esc(shipping.country)}.</div>`
    : `<div class="fail">Producto físico sin dirección de despacho guardada: la tienda no puede despachar. Agrega tu dirección en el mandato antes de aprobar.</div>`;
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
 * an unknown correo and for a wrong contraseña is the same sentence.
 */
export function loginPage(options: {
  network: string;
  next?: string;
  error?: PageError;
  notice?: string;
}): string {
  const body = `
  <div class="gate">
    <p class="lead">Entra a tu sala de control</p>
    <p class="sub">Aquí fijas cuánto puede gastar tu agente y apruebas cada pago, uno por uno. Solo entra el dueño.</p>
    ${options.error ? errBanner(options.error) : ""}
    ${options.notice ? `<div class="banner ok">${esc(options.notice)}</div>` : ""}
    <form method="post" action="/login" class="card">
      <input type="hidden" name="next" value="${esc(options.next ?? "/")}">
      <label for="email">Correo</label>
      <input type="email" id="email" name="email" autocomplete="username" required>
      <label for="password">Contraseña</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required>
      <button type="submit">Entrar</button>
    </form>
    <p class="meta"><a href="/recuperar">Olvidé mi contraseña</a></p>
    <p class="custody">Esta plataforma nunca guarda ni pide una llave secreta de wallet. Tu contraseña se guarda solo como un hash scrypt: ni nosotros ni nadie puede leerla desde la base de datos.</p>
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
    <p class="lead">Crea tu cuenta de dueño</p>
    <p class="sub">Esta sala de control todavía no tiene dueño. La cuenta se crea una sola vez y es la única que puede cambiar tus límites y aprobar pagos.</p>
    ${options.error ? errBanner(options.error) : ""}
    <form method="post" action="/setup" class="card">
      <label for="email">Correo</label>
      <input type="email" id="email" name="email" value="${esc(options.email ?? "")}" autocomplete="username" required>
      <label for="password">Contraseña (mínimo 12 caracteres)</label>
      <input type="password" id="password" name="password" autocomplete="new-password" required minlength="12">
      <label for="confirm">Repite la contraseña</label>
      <input type="password" id="confirm" name="confirm" autocomplete="new-password" required minlength="12">
      <button type="submit">Crear cuenta y entrar</button>
    </form>
    <p class="custody">Guarda esta contraseña donde guardas las importantes. No hay correo de recuperación, a propósito: esto corre en tu servidor y tu servidor no tiene por qué saber enviar correo. Apenas entres te mostramos diez códigos de recuperación en papel, una sola vez.</p>
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
      <h3>O pide un código por WhatsApp</h3>
      <p class="meta">Llega solo al número del dueño que está en la lista del servidor, nunca a otro. Vale 10 minutos.</p>
      <label for="wemail">Correo</label>
      <input type="email" id="wemail" name="email" value="${email}" autocomplete="username" required>
      <button type="submit" class="ghost">Enviar código a mi WhatsApp</button>
    </form>`
    : "";
  const body = `
  <div class="gate">
    <p class="lead">Recupera el mando</p>
    <p class="sub">Escribe tu correo y uno de tus códigos de recuperación. Si el código sirve, lo único que podrás hacer es fijar una contraseña nueva: nada de mandato, nada de aprobaciones.</p>
    ${options.error ? errBanner(options.error) : ""}
    ${options.notice ? `<div class="banner ok">${esc(options.notice)}</div>` : ""}
    <form method="post" action="/recuperar" class="card">
      <label for="email">Correo</label>
      <input type="email" id="email" name="email" value="${email}" autocomplete="username" required>
      <label for="code">Código de recuperación (o el código de 6 dígitos que pediste por WhatsApp)</label>
      <input type="text" id="code" name="code" placeholder="ABCD-EFGH-JKLM" autocomplete="one-time-code" required>
      <button type="submit">Continuar</button>
    </form>
    ${whatsapp}
    <p class="custody">Aquí no hay correo de recuperación, y no es un olvido: esta sala corre en tu propio servidor, que no tiene por qué saber enviar correo. Si perdiste la contraseña y no tienes códigos, la última vía es la línea de comandos del servidor: <span class="mono">node dist/auth/recover-cli.js</span> imprime un enlace de un solo uso. Queda registrado en Accesos.</p>
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
    <p class="lead">Elige una contraseña nueva</p>
    <p class="sub">Con esto termina la recuperación. Se cierran todas las sesiones abiertas, la tuya incluida y la de cualquiera que estuviera dentro, y entras de nuevo con la contraseña nueva.</p>
    ${options.error ? errBanner(options.error) : ""}
    <form method="post" action="/recuperar/nueva-clave" class="card">
      ${csrfInput(options.csrf)}
      <label for="password">Contraseña nueva (mínimo 12 caracteres)</label>
      <input type="password" id="password" name="password" autocomplete="new-password" required minlength="12">
      <label for="confirm">Repite la contraseña nueva</label>
      <input type="password" id="confirm" name="confirm" autocomplete="new-password" required minlength="12">
      <button type="submit">Guardar y cerrar todas las sesiones</button>
    </form>
    <p class="custody">Esta sesión de recuperación no puede ver tu mandato, tus propuestas ni aprobar un pago. Solo sirve para esto, y dura 15 minutos.</p>
  </div>`;
  return layout({
    title: "Contraseña nueva",
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
    <p class="lead">Enlace de recuperación del servidor</p>
    <p class="sub">Este enlace lo generó alguien con acceso a la línea de comandos del servidor. Salta la contraseña, se usa una sola vez y queda registrado en el panel Accesos.</p>
    ${options.error ? errBanner(options.error) : ""}
    <form method="post" action="/recuperar/operador" class="card">
      <input type="hidden" name="token" value="${esc(options.token)}">
      <p class="meta" style="margin:0">Si no fuiste tú quien lo generó, cierra esta página y revisa Accesos.</p>
      <button type="submit">Continuar y fijar una contraseña nueva</button>
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
 * It is laid out as a sheet of paper, and `@media print` turns it into one.
 */
export function recoveryCodesPage(options: {
  network: string;
  codes: string[];
  session: SessionView;
  pendingCount: number;
}): string {
  const items = options.codes.map((c) => `<li>${esc(c)}</li>`).join("");
  const body = `
  <p class="lead noprint">Tus códigos de recuperación</p>
  <div class="banner warn noprint"><strong>Guárdalas ahora: no se vuelven a mostrar.</strong> Imprímelas (Ctrl+P) o cópialas a donde guardas lo importante. Si cierras esta página sin copiarlas, tendrás que generar un juego nuevo.</div>
  <div class="sheet">
    <div class="sheethead">
      <span class="sheettitle">AGENTPOS · códigos de recuperación</span>
      <span class="meta">Un solo uso cada uno · ${String(options.codes.length)} códigos</span>
    </div>
    <ol class="codes">${items}</ol>
    <p class="keepline">Con tu correo y uno de estos códigos entras en <span class="mono">/recuperar</span> y fijas una contraseña nueva; al terminar se cierran todas las sesiones.</p>
    <p class="keepline">Generar un juego nuevo anula estos ${String(options.codes.length)} al instante.</p>
    <p class="keepline">Guardado el ______________________ en ______________________________</p>
  </div>
  <p class="noprint"><a href="/cuenta">Volver a mi cuenta</a></p>`;
  return layout({
    title: "Códigos de recuperación",
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
      ? `<div class="banner warn"><strong>No tienes códigos de recuperación.</strong> Sin ellos, si olvidas la contraseña solo queda la línea de comandos del servidor.</div>`
      : `<div class="meta">Te quedan <strong style="color:var(--ink)">${String(options.codes.unused)}</strong> de ${String(options.codes.total)} códigos sin usar.</div>`;
  const whatsappLine = options.whatsapp
    ? `<div class="chan"><span class="st on">Activo</span><div><strong>Código por WhatsApp</strong>. Puedes pedir un código de 6 dígitos desde /recuperar; llega solo al número del dueño que está en la lista del servidor.</div></div>`
    : `<div class="chan"><span class="st off">No configurado</span><div><strong>Código por WhatsApp</strong>. Se activa solo si defines WHATSAPP_ALLOWED_NUMBERS y las credenciales de Meta o Twilio en el servidor.</div></div>`;
  const body = `
  <p class="lead">Tu cuenta</p>
  <p class="sub">La contraseña que protege tus límites de gasto, y las formas de volver a entrar si la pierdes.</p>
  ${options.error ? errBanner(options.error) : ""}
  ${options.saved ? `<div class="banner ok">Contraseña cambiada. Las otras sesiones se cerraron; esta sigue abierta.</div>` : ""}
  <h2>Cambiar la contraseña</h2>
  <form method="post" action="/cuenta/clave" class="card">
    ${csrfInput(csrf)}
    <label for="current">Tu contraseña actual</label>
    <input type="password" id="current" name="current" autocomplete="current-password" required>
    <label for="password">Contraseña nueva (mínimo 12 caracteres)</label>
    <input type="password" id="password" name="password" autocomplete="new-password" required minlength="12">
    <label for="confirm">Repite la contraseña nueva</label>
    <input type="password" id="confirm" name="confirm" autocomplete="new-password" required minlength="12">
    <p class="meta" style="margin:12px 0 0">Al guardar se cierran todas las demás sesiones. Esta, en la que estás escribiendo, sigue abierta.</p>
    <button type="submit">Cambiar contraseña</button>
  </form>
  <h2>Códigos de recuperación</h2>
  <div class="card">
    ${codesState}
    <p class="meta" style="margin-top:10px">Diez códigos en papel, cada uno de un solo uso. Es la vía que siempre funciona: no necesita correo, ni teléfono, ni acceso al servidor.</p>
    <form method="post" action="/cuenta/codigos">
      ${csrfInput(csrf)}
      <button type="submit" class="${options.codes.total === 0 ? "" : "ghost"}">Generar códigos nuevos</button>
    </form>
    <p class="meta" style="margin:10px 0 0">Generar códigos nuevos anula los anteriores, usados o no. Se muestran una sola vez.</p>
  </div>
  <h2>Otras formas de volver a entrar</h2>
  <div class="card">
    ${whatsappLine}
    <div class="chan"><span class="st on">Siempre</span><div><strong>Línea de comandos del servidor</strong>. Quien pueda correr comandos en el servidor genera un enlace de un solo uso con <span class="mono">node dist/auth/recover-cli.js</span>. Vence a los 15 minutos y queda registrado en Accesos.</div></div>
    <p class="custody">No hay recuperación por correo, y es deliberado: esta sala corre en tu propio servidor, que no tiene servidor de correo. Un botón que promete un correo que nunca llega es peor que no tenerlo.</p>
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

// --- home: the mandate, the market call, the channels -------------------------

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
 * The period consumption bar, with the real numbers on both sides. Amount math is done in
 * minor units (bigint); only the final percentage, an integer 0..100 for a CSS width,
 * leaves bigint land.
 */
function consumption(spentDecimal: string, maxTotalDecimal: string, period: string): string {
  const spent = usdc(spentDecimal);
  const total = usdc(maxTotalDecimal);
  const remaining = formatUsdc(usdcFromMinor(total > spent ? total - spent : 0n));
  const pct = total > 0n ? Math.min(100, Number((spent * 100n) / total)) : 0;
  return `
    <div class="consumption">
      <div class="heads">
        <span>Aprobado en este período: <b class="money">${esc(spentDecimal)} USDC</b></span>
        <span>Disponible: <b class="money">${esc(remaining)} USDC</b></span>
      </div>
      <div class="bar" aria-hidden="true"><i${pct >= 100 ? ' class="full"' : ""} style="width:${String(pct)}%"></i></div>
      <div class="meta">${String(pct)}% del límite de ${esc(maxTotalDecimal)} USDC por ${esc(periodEs(period))} ya está comprometido.</div>
    </div>`;
}

/**
 * The mandate as a contract, and the centrepiece of this surface: a defined border, a seal
 * that says whether it is in force, the limits in large type and the period consumption.
 * Editing it lives behind the fold, in `mandateEditor`.
 */
function mandateContract(status: ServiceStatus): string {
  const m = status.mandate;
  if (!m) {
    return `
  <div class="contract">
    <div class="contract-head">
      <div>
        <p class="lead">Todavía no hay mandato</p>
        <p class="meta">Sin mandato, tu agente no puede proponer ni pagar nada. Abre el editor de abajo y fija tus dos límites: cuánto por compra y cuánto por período.</p>
      </div>
      <span class="seal none">sin firmar</span>
    </div>
  </div>`;
  }
  const wallet = status.walletLinked ? "Vinculada" : "Sin vincular";
  // City and country only: the street address never reaches a page, a log or the history.
  const despacho = status.shipping
    ? `Despacho a ${status.shipping.city}, ${status.shipping.country}`
    : "Sin dirección de despacho guardada";
  const storesLine =
    status.stores.length > 0
      ? `${String(status.stores.length)} tienda(s) permitida(s)`
      : "Cualquier tienda permitida (agrega URLs en el editor para acotar y poder buscar)";
  return `
  <div class="contract live">
    <div class="contract-head">
      <div>
        <p class="lead">Tu mandato</p>
        <p class="meta">Esto es todo lo que tu agente tiene permitido. Fuera de estas líneas no puede pagar, y no puede cambiarlas: solo tú.</p>
      </div>
      <span class="seal">vigente</span>
    </div>
    <div class="limits">
      <div class="limit"><div class="k">Máximo por compra</div><div class="v money">${esc(m.maxPerTx)} <small>USDC</small></div></div>
      <div class="limit"><div class="k">Máximo por ${esc(periodEs(m.period))}</div><div class="v money">${esc(m.maxTotal)} <small>USDC</small></div></div>
      <div class="limit"><div class="k">Wallet</div><div class="v">${esc(wallet)}</div></div>
    </div>
    ${consumption(status.approvedInPeriod, m.maxTotal, m.period)}
    <div class="clauses">
      <div class="clause"><b>Tiendas:</b> ${esc(storesLine)}</div>
      <div class="clause"><b>Bienes físicos:</b> ${m.allowPhysicalGoods ? "permitidos" : "no permitidos"} · ${esc(despacho)}</div>
      <div class="clause"><b>En curso:</b> ${String(status.pendingProposals)} esperando tu decisión · ${String(status.approvedAwaitingSignature)} esperando firma</div>
    </div>
  </div>`;
}

/** Why an offer cannot be paid, said the way the person who wrote the mandate would say it. */
const BLOCK_ES: Record<MandateBlock["reason"], string> = {
  per_payment_cap: "supera tu máximo por compra",
  period_budget: "supera lo que queda de tu límite del período",
  physical_not_allowed: "es un producto físico y tu mandato no los permite",
  seller_not_allowed: "la tienda no está en tu lista permitida",
};

const STORE_STATE_ES: Record<string, string> = {
  ok: "respondió",
  timeout: "no respondió a tiempo",
  error: "error",
  "unsupported-filters": "no entiende los filtros; se filtró aquí",
  "not-allowed": "fuera de tu mandato, no se consultó",
};

const STORE_STATE_CLASS: Record<string, string> = {
  ok: "up",
  timeout: "down",
  error: "down",
  "unsupported-filters": "up",
  "not-allowed": "down",
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
      ? `<span class="tag approved">sí, con tu aprobación</span>`
      : `<span class="tag paid">sí</span>`;
  }
  const reasons = offer.mandate.blocks.map((b) => BLOCK_ES[b.reason]).join("; ");
  return `<span class="tag rejected">no</span><div class="meta">${esc(reasons)}</div>`;
}

function offerRow(offer: MarketOffer, quantity: number, csrf: string, best: boolean): string {
  const shown =
    Object.keys(offer.matchedAttributes).length > 0 ? offer.matchedAttributes : offer.attributes;
  const chips = Object.entries(shown)
    .map(([name, value]) => `<span class="chip">${esc(`${name}: ${value}`)}</span>`)
    .join("");
  const outOfStock =
    offer.stock === "out_of_stock"
      ? `<div class="meta">Sin stock en la tienda</div>`
      : offer.stock === "unknown"
        ? `<div class="meta">Stock no informado</div>`
        : "";
  return `
      <tr${best ? ' class="best"' : ""}>
        <td>${esc(offer.store.name)}<div class="meta mono">${esc(offer.store.host)}</div>${best ? `<div><span class="flag">más barata</span></div>` : ""}</td>
        <td><span class="title">${esc(offer.title)}</span>${offer.physical ? `<div class="meta">Producto físico</div>` : ""}${outOfStock}${chips ? `<div>${chips}</div>` : ""}</td>
        <td class="num">${esc(offer.unitPrice)}</td>
        <td class="num money">${esc(offer.totalUsdc)} ${esc(offer.asset)}</td>
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

/** Who answered, as a quiet status strip: it informs, it does not compete with the offers. */
function storesSection(result: MarketCallResult): string {
  const pills = result.stores
    .map((store) => {
      const label = STORE_STATE_ES[store.state] ?? store.state;
      const detail = store.error
        ? ` · ${store.error.message}`
        : store.truncated
          ? ` · se leyeron ${String(store.offers)} de ${String(store.total ?? store.offers)}`
          : "";
      return `<span class="ans ${STORE_STATE_CLASS[store.state] ?? "down"}"><b>${esc(store.name)}</b><i>${esc(label)}${esc(detail)}</i><i>${String(store.offers)} oferta(s)</i></span>`;
    })
    .join("");
  return `
  <h2>Quién respondió</h2>
  <div class="strip">${pills || '<span class="ans down"><i>Ninguna tienda fue consultada.</i></span>'}</div>`;
}

function facetsSection(values: MarketFormValues, result: MarketCallResult): string {
  const groups = Object.entries(result.facets);
  if (groups.length === 0) return "";
  const rows = groups
    .map(([name, entries]) => {
      const links = entries
        .map(
          (v) =>
            `<a class="facet" href="${esc(marketHref(values, `${name}=${v.value}`))}">${esc(v.value)} (${String(v.count)})</a>`,
        )
        .join("");
      return `<div class="facetrow"><span class="fname">${esc(name)}</span>${links}</div>`;
    })
    .join("");
  return `
  <h2>Afinar el pedido</h2>
  <div class="card">
    <div class="facets">${rows}</div>
    <p class="meta" style="margin:14px 0 0">Un clic agrega el filtro a tu pedido y vuelve a preguntar a todas tus tiendas.</p>
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
  <div class="card"><div class="meta">Guarda primero tu mandato: el llamado usa tus tiendas permitidas y tus límites.</div></div>`;
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
      <input type="text" name="q" value="${esc(values.what)}" placeholder="Qué quieres comprar, por ejemplo: lamina 30x40" aria-label="Qué buscas">
      <button type="submit">Preguntar a mis tiendas</button>
    </div>
    <label for="attr0">Características (clave=valor, una por campo; los nombres los pone cada tienda)</label>
    <div class="row">
      ${attributeRows}
    </div>
    <div class="row">
      <div>
        <label for="max">Precio máximo por unidad (USDC, opcional)</label>
        <input type="text" id="max" name="max" value="${esc(values.maxPriceUsdc)}" inputmode="decimal" placeholder="40">
      </div>
      <div>
        <label for="qty">Cantidad</label>
        <input type="text" id="qty" name="qty" value="${esc(values.quantity)}" inputmode="numeric">
      </div>
      <div>
        <label for="physical">Tipo de producto</label>
        <select id="physical" name="physical">
          ${physicalOption("", "Cualquiera")}${physicalOption("true", "Solo físicos")}${physicalOption("false", "Solo digitales")}
        </select>
      </div>
    </div>
    <p class="meta" style="margin:10px 0 0">Se pregunta lo mismo a todas tus tiendas permitidas, al mismo tiempo. Proponer no compra nada: toda compra pasa por tu aprobación y se firma en tu máquina.</p>
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
      ? `<div class="card"><div class="empty">Ninguna tienda tiene algo para "${esc(result.query.what)}" con esas características.</div></div>`
      : `
  <div class="card">
    <div class="scroller">
      <table>
        <tr><th>Tienda</th><th>Producto</th><th>Unitario</th><th>Total x${String(quantity)}</th><th>Pagable</th><th></th></tr>
        ${result.offers.map((o, i) => offerRow(o, quantity, csrf, i === 0)).join("")}
      </table>
    </div>
    <p class="meta" style="margin:12px 0 0">${String(result.offers.length)} oferta(s), de la más barata a la más cara, para ${String(quantity)} unidad(es). Una oferta marcada "no" se muestra igual: es tu límite el que la frena, no la tienda.</p>
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
    ? row(true, "Canal WhatsApp activo", "Puedes buscar, proponer y aprobar desde tu teléfono.")
    : row(
        false,
        "Canal WhatsApp",
        "Para activarlo, define WHATSAPP_ALLOWED_NUMBERS y las credenciales de Meta o Twilio en el entorno del servidor.",
      );
  const signer = channels.signer
    ? row(
        true,
        "Puente de firma configurado",
        "Tu watcher local (agentpos-buyer watch) firmará los pagos aprobados; el dinero solo se mueve desde tu máquina.",
      )
    : row(
        false,
        "Puente de firma",
        "Para activarlo, define SIGNER_TOKEN en este servidor y ejecuta agentpos-buyer watch en la máquina donde vive tu wallet.",
      );
  return `
  <h2>Canales</h2>
  <div class="card">
    ${whatsapp}
    ${signer}
  </div>`;
}

/** The mandate editor: a secondary action, folded away unless there is a reason to open it. */
function mandateEditor(v: MandateFormValues, csrf: string, open: boolean): string {
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
  return `
  <details class="editor"${open ? " open" : ""}>
    <summary>Editar el mandato</summary>
    <form method="post" action="/profile">
      ${csrfInput(csrf)}
      <p class="meta" style="margin:14px 0 0">Cambiar esto cambia lo que tu agente puede hacer desde la próxima acción. El agente no puede abrir este formulario: solo tú.</p>
      <div class="row">
        <div>
          <label for="maxPerTx">Máximo por compra (USDC)</label>
          <input type="text" id="maxPerTx" name="maxPerTx" value="${esc(v.maxPerTx)}" inputmode="decimal" required>
        </div>
        <div>
          <label for="maxTotal">Máximo por período (USDC)</label>
          <input type="text" id="maxTotal" name="maxTotal" value="${esc(v.maxTotal)}" inputmode="decimal" required>
        </div>
        <div>
          <label for="period">Período</label>
          <select id="period" name="period">
            ${period("day", "Día")}${period("week", "Semana")}${period("month", "Mes")}
          </select>
        </div>
      </div>
      <label for="stores">Tiendas permitidas (una URL por línea; vacío permite cualquier tienda)</label>
      <textarea id="stores" name="stores" placeholder="https://tienda.ejemplo">${esc(v.stores)}</textarea>
      <input type="checkbox" class="toggle" id="allowPhysicalGoods" name="allowPhysicalGoods"${v.allowPhysicalGoods ? " checked" : ""}>
      <label class="togglelabel" for="allowPhysicalGoods">Permitir bienes físicos (cosas que se envían a una dirección)</label>
      <div class="ship">
        <h3>Dirección de despacho</h3>
        <p class="meta" style="margin:2px 0 0">La tienda necesita esta dirección y tu correo de contacto para despachar. Se guarda aquí y viaja solo a la tienda donde compras; en esta página se muestran únicamente la ciudad y el país.</p>
        ${ship("shipName", "shipName", "Nombre de quien recibe", v.shipping.name, ' autocomplete="name"')}
        ${ship("shipLine1", "shipLine1", "Dirección (calle y número)", v.shipping.line1, ' autocomplete="address-line1"')}
        ${ship("shipLine2", "shipLine2", "Departamento, oficina o referencia (opcional)", v.shipping.line2, ' autocomplete="address-line2"')}
        <div class="row">
          <div>${ship("shipCity", "shipCity", "Ciudad", v.shipping.city, ' autocomplete="address-level2"')}</div>
          <div>${ship("shipRegion", "shipRegion", "Región o estado (opcional)", v.shipping.region, ' autocomplete="address-level1"')}</div>
          <div>${ship("shipPostalCode", "shipPostalCode", "Código postal", v.shipping.postalCode, ' autocomplete="postal-code"')}</div>
        </div>
        <div class="row2">
          <div>${ship("shipCountry", "shipCountry", "País (código de dos letras, por ejemplo CL)", v.shipping.country, ' maxlength="2" style="text-transform:uppercase" autocomplete="country"')}</div>
          <div>${ship("shipPhone", "shipPhone", "Teléfono de contacto (opcional)", v.shipping.phone, ' autocomplete="tel"')}</div>
        </div>
      </div>
      <label for="email">Tu correo de contacto (las tiendas envían allí las novedades de la orden; obligatorio si permites bienes físicos)</label>
      <input type="email" id="email" name="email" value="${esc(v.email)}" placeholder="tu@ejemplo.com">
      <label for="walletAddress">Dirección pública de tu wallet (empieza con G)</label>
      <input type="text" id="walletAddress" name="walletAddress" value="${esc(v.walletAddress)}" placeholder="G...">
      <p class="custody">Esta plataforma nunca guarda ni pide una llave secreta. Los pagos se firman en tu propia máquina; aquí solo vinculas la dirección pública para que tu agente sepa de qué wallet trata el mandato.</p>
      <button type="submit">Guardar mandato</button>
    </form>
  </details>`;
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
  const banner = options.error
    ? errBanner(options.error)
    : options.saved
      ? `<div class="banner ok">Mandato guardado. El agente lo obedece desde la próxima acción.</div>`
      : "";
  // The state this platform must never hide: physical goods allowed with nowhere to ship.
  const shippingWarning = options.status.physicalWithoutShipping
    ? `<div class="banner warn"><strong>Tu mandato permite bienes físicos, pero no hay a dónde despachar.</strong> Sin dirección de despacho y correo de contacto la tienda no puede enviar el paquete y la compra falla al pagar.<br><span class="meta">Agrega tu dirección de despacho abajo o desactiva bienes físicos.</span></div>`
    : "";
  // The editor opens by itself only when there is a reason: nothing saved yet, a refused
  // form to fix, or a mandate that promises physical goods it cannot ship.
  const editorOpen =
    options.error !== undefined ||
    !options.status.mandate ||
    options.status.physicalWithoutShipping;
  const body = `
  ${banner}
  ${shippingWarning}
  ${mandateContract(options.status)}
  ${mandateEditor(options.values, options.session.csrf, editorOpen)}
  ${marketSection(options.status, options.market, options.session.csrf)}
  ${channelsSection(options.channels)}`;
  return layout({
    title: "Mandato",
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
      const what = `${p.amount} ${p.asset} en ${p.storeName}`;
      // Approving is the moment this space commits money, so above the confirmation
      // threshold the password is asked again, right here, presented as a step of the
      // decision and not as a stray field: nobody approves by muscle memory.
      const failed =
        options.reauthError?.proposalId === p.id
          ? `<div class="fail">${esc(options.reauthError.message)}</div>`
          : "";
      const confirm = options.needsReauth(p)
        ? `
      <div class="confirm">
        <div class="step">Paso 1 de 2</div>
        <div class="k">Confirma con tu contraseña: vas a aprobar ${esc(what)}.</div>
        <p class="meta" style="margin:0">Se pide aunque tu sesión siga abierta. Es la última barrera antes de comprometer el dinero.</p>
        ${failed}
        <label for="pw-${esc(p.id)}">Tu contraseña</label>
        <input type="password" id="pw-${esc(p.id)}" name="password" autocomplete="current-password" required>
      </div>`
        : failed;
      const step2 = options.needsReauth(p) ? "Paso 2 de 2: " : "";
      return `
  <div class="card edge edge-pending">
    <div class="cardhead"><span class="amount">${esc(p.amount)} ${esc(p.asset)}</span>${statusTag(p.status)}</div>
    <div class="title">${esc(p.title)}</div>
    ${proposalMeta(p)}
    ${shippingLine(p, options.shipping)}
    <div class="meta">Cotización congelada, válida hasta ${esc(fmtWhen(p.cartExpiresAt))}.</div>
    <form method="post" action="/proposals/${esc(p.id)}/approve">
      ${csrfInput(csrf)}
      ${confirm}
      <div class="decide"><button type="submit">${esc(`${step2}Aprobar ${what}`)}</button></div>
    </form>
    <div class="decision-gap">o, si no lo quieres</div>
    <div class="refuse">
      <form method="post" action="/proposals/${esc(p.id)}/reject">${csrfInput(csrf)}<button type="submit" class="danger">${esc(`Rechazar ${what}`)}</button></form>
    </div>
  </div>`;
    })
    .join("");

  const signingNote = options.signerConfigured
    ? "Puente de firma configurado: tu watcher local firmará este pago; el dinero solo se mueve desde tu máquina."
    : "Tu watcher local firmará este pago; el dinero solo se mueve desde tu máquina. Deja corriendo agentpos-buyer watch, o ejecuta el comando de abajo, donde vive tu wallet.";

  const approvedCards = options.approved
    .map((p) => {
      const i = options.instructionsFor(p);
      const failure = p.failure
        ? `<div class="fail">El último intento de pago falló con <strong>${esc(p.failure.code)}</strong>: ${esc(p.failure.message)} (${esc(fmtWhen(p.failure.at))})</div>`
        : "";
      return `
  <div class="card edge edge-approved"${options.highlight === p.id ? ' style="border-color:var(--accent)"' : ""}>
    <div class="cardhead"><span class="amount">${esc(p.amount)} ${esc(p.asset)}</span>${statusTag(p.status)}</div>
    <div class="title">${esc(p.title)}</div>
    ${proposalMeta(p)}
    ${shippingLine(p, options.shipping)}
    ${failure}
    <p class="custody">${esc(signingNote)}</p>
    <div class="meta">Pago (checkout): <span class="mono">${esc(i.checkoutUrl)}</span></div>
    <div class="meta">Para pagar a mano desde la máquina que tiene tu llave:</div>
    <pre><code>${esc(i.cli)}</code></pre>
    <div class="actions">
      <form method="post" action="/proposals/${esc(p.id)}/reject">${csrfInput(csrf)}<button type="submit" class="ghost">Cancelar aprobación</button></form>
    </div>
  </div>`;
    })
    .join("");

  const paidCards = options.paid
    .map(
      (p) => `
  <div class="card edge edge-paid">
    <div class="cardhead"><span class="amount money">${esc(p.amount)} ${esc(p.asset)}</span>${statusTag(p.status)}</div>
    <div class="title">${esc(p.title)}</div>
    ${proposalMeta(p)}
    ${
      p.payment
        ? `<div class="meta">Pago liquidado el ${esc(fmtWhen(p.payment.paidAt))} · orden <span class="mono">${esc(p.payment.orderId)}</span></div>
    <div class="meta">Transacción: ${txLink(options.network, p.payment.txHash)}</div>`
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
  <h2>Proponer una compra tú mismo</h2>
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
    <button type="submit" class="ghost">Pedir cotización</button>
  </form>`
      : "";

  const body = `
  <p class="lead">Decisiones</p>
  <p class="sub">Lo que tu agente quiere comprar. Nada se cobra hasta que apruebas, y la firma sale siempre de tu propia máquina.</p>
  <h2>Esperando tu decisión</h2>
  ${pendingCards || '<div class="card"><div class="empty">No hay propuestas esperando tu decisión.</div></div>'}
  <h2>Aprobadas, esperando firma</h2>
  ${approvedCards || '<div class="card"><div class="empty">Nada aprobado sin pagar.</div></div>'}
  ${paidCards ? `<h2>Pagadas</h2>${paidCards}` : ""}
  ${proposeForm}`;
  return layout({
    title: "Decisiones",
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
  search: "búsqueda",
  "proposal.created": "propuesta creada",
  "proposal.approved": "propuesta aprobada",
  "proposal.rejected": "propuesta rechazada",
  "proposal.expired": "cotización expirada",
  "signer.queue": "cola entregada al firmador",
  "proposal.paid": "pago liquidado",
  "proposal.payment_failed": "pago fallido",
};

/**
 * Dot colour on the timeline, through the same state tokens as everything else: green for
 * money settled, muted red for what failed or was refused, grey for routine noise.
 */
const KIND_STATE: Partial<Record<ActivityEntry["kind"], Proposal["status"]>> = {
  "proposal.paid": "paid",
  "proposal.payment_failed": "rejected",
  "proposal.rejected": "rejected",
  "proposal.expired": "expired",
  search: "expired",
  "signer.queue": "expired",
  "proposal.created": "pending",
  "proposal.approved": "approved",
};

function activitySummary(e: ActivityEntry): string {
  const d = e.data;
  switch (e.kind) {
    case "profile.saved":
      return `límite ${String(d.maxPerTx)} USDC por compra, ${String(d.maxTotal)} USDC por ${periodEs(String(d.period))}`;
    case "search":
      return `"${String(d.query)}" · ${String(d.results)} resultado(s)`;
    case "signer.queue":
      return `${String(d.proposals)} propuesta(s) entregadas al firmador local`;
    case "proposal.paid":
      return `${String(d.title)} · ${String(d.amount)} USDC · transacción ${String(d.txHash)}`;
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
  session_expired: "sesión expirada",
  approval: "propuesta aprobada",
  reauth_failed: "contraseña incorrecta al aprobar",
  csrf_invalid: "formulario sin token válido",
  recovery_codes_generated: "códigos de recuperación nuevos",
  recovery_code_sent: "código enviado por WhatsApp",
  recovery_started: "recuperación iniciada",
  recovery_failed: "código de recuperación rechazado",
  recovery_rate_limited: "recuperación bloqueada",
  recovery_completed: "contraseña recuperada",
  password_changed: "contraseña cambiada",
  operator_token_issued: "enlace de recuperación del servidor",
};

/**
 * Muted red for what someone else may have done, green for a money decision that stands,
 * violet for a recovery in flight, grey for routine. Same tokens as everywhere else.
 */
const ACCESS_STATE: Partial<Record<AccessEntry["event"], Proposal["status"]>> = {
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
 * The panel that answers "¿ha entrado alguien más?". Everything it shows is a hash or a
 * coarse label: the address, the browser and the email never land in this table whole.
 */
function accessSection(access: AccessEntry[]): string {
  if (access.length === 0) {
    return `
  <h2>Accesos</h2>
  <div class="card"><div class="empty">Sin registros todavía.</div></div>`;
  }
  const rows = access
    .map(
      (a) =>
        `<tr><td class="meta">${esc(fmtWhen(a.at))}</td><td><span class="tag ${ACCESS_STATE[a.event] ?? "approved"}">${esc(ACCESS_LABEL[a.event] ?? a.event)}</span></td><td class="meta mono">${esc(a.ipHash)}</td><td class="meta">${esc(a.uaFamily)}</td><td class="meta">${esc(a.detail)}</td></tr>`,
    )
    .join("");
  return `
  <h2>Accesos</h2>
  <div class="card">
    <div class="scroller">
      <table><tr><th>Fecha</th><th>Qué pasó</th><th>Origen</th><th>Navegador</th><th>Detalle</th></tr>${rows}</table>
    </div>
    <p class="meta" style="margin:12px 0 0">El origen es un hash corto de la dirección IP, no la dirección: sirve para reconocer "esto fui yo, desde casa" sin guardar de dónde te conectas. Intentos fallidos seguidos de nada son ruido de internet; intentos fallidos seguidos de una entrada correcta que no reconoces, no.</p>
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
      const state = KIND_STATE[e.kind];
      return `<li${state ? ` class="dot-${state}"` : ""}>
      <span class="tl-label">${esc(KIND_LABEL[e.kind] ?? e.kind)}</span><span class="tl-when">${esc(fmtWhen(e.at))}</span>
      ${detail ? `<div class="tl-detail">${esc(detail)}</div>` : ""}
    </li>`;
    })
    .join("");
  const history = options.proposals
    .map(
      (p) =>
        `<tr><td class="meta">${esc(fmtWhen(p.createdAt))}</td><td>${esc(p.title)}</td><td class="num money">${esc(p.amount)} ${esc(p.asset)}</td><td>${statusTag(p.status)}${p.payment ? ` <span class="mono">${esc(p.payment.txHash)}</span>` : ""}</td></tr>`,
    )
    .join("");
  const s = options.status;
  const body = `
  <p class="lead">Actividad</p>
  <p class="sub">Todo lo que hicieron tu agente y tú, en orden. Aprobado en este período: <span class="money">${esc(s.approvedInPeriod)} USDC</span>${s.mandate ? ` de ${esc(s.mandate.maxTotal)} USDC permitidos por ${esc(periodEs(s.mandate.period))}` : ""}.</p>
  <h2>Historial de propuestas</h2>
  <div class="card">
    ${history ? `<div class="scroller"><table><tr><th>Fecha</th><th>Detalle</th><th>Monto</th><th>Estado</th></tr>${history}</table></div>` : '<div class="empty">Aún no hay propuestas.</div>'}
  </div>
  <h2>Línea de tiempo</h2>
  <div class="card">
    ${timeline ? `<ol class="timeline">${timeline}</ol>` : '<div class="empty">Nada todavía.</div>'}
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
  <p><a href="${esc(options.backHref)}">${esc(options.backLabel ?? "Volver a las decisiones")}</a></p>`;
  return layout({
    title: "Error",
    active: options.session ? "proposals" : "none",
    network: options.network,
    pendingCount: options.pendingCount,
    ...(options.session ? { session: options.session } : {}),
    body,
  });
}
