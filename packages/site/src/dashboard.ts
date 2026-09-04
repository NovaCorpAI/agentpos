/**
 * The store's own dashboard (G2, extended for M1-M4): a single self-contained HTML page served
 * by the sidecar at {base}/dashboard. Three tabs, all rendered in the visitor's browser from
 * same-origin JSON endpoints:
 *  - Metrics:  {base}/metrics, aggregates by construction.
 *  - Catalog:  {base}/catalog, the published items exactly as an agent receives them.
 *  - Rules:    {base}/dashboard/rules, the limits and switches this store enforces on agents.
 *
 * Design constraints, all deliberate:
 *  - Served BY the store, from the store's domain. The traction artifact for a merchant is
 *    "my store sells to agents, look", on their URL, not a page of ours aggregating them.
 *  - Zero external resources: no CDN, no fonts, no analytics. It must work on a sidecar behind
 *    any CSP and leak nothing about who views it.
 *  - It only renders what those endpoints already expose: no buyer data (metrics are
 *    aggregates), no secrets (the rules endpoint reduces channels to booleans). Every value
 *    interpolated into markup, server- or client-side, is escaped.
 */

const STRINGS = {
  es: {
    title: "Ventas a agentes",
    subtitle: "Métricas públicas y agregadas de esta tienda. Sin datos de compradores.",
    tabMetrics: "Métricas",
    tabCatalog: "Catálogo",
    tabRules: "Reglas",
    paidOrders: "órdenes pagadas",
    total: "total vendido",
    payers: "wallets pagadoras únicas",
    agents: "agentes identificados",
    latency: "checkout → orden creada",
    held: "en revisión",
    pending: "por crear en plataforma",
    perDay: "Órdenes por día",
    range7: "7 días",
    range30: "30 días",
    range90: "90 días",
    empty: "Sin ventas en este período todavía.",
    error: "No se pudieron cargar las métricas.",
    footer: "Verificable por cualquiera en",
    updated: "actualizado",
    catalogSubtitle: "Los artículos publicados, tal como los recibe un agente.",
    itemsPublished: "artículos publicados",
    physical: "físico",
    digital: "digital",
    stockTracked: "stock controlado",
    stockUntracked: "stock sin control",
    catalogEmpty:
      "Todavía no hay artículos publicados. Ejecuta agentpos scan, revisa el borrador con agentpos confirm y expón con agentpos publish.",
    catalogError: "No se pudo cargar el catálogo.",
    rulesSubtitle:
      "Las reglas que esta tienda aplica a las compras de agentes. Solo lectura: se editan en agentpos.config.json.",
    rulePolicy: "Política de venta",
    ruleStatus: "estado",
    statusActive: "activa",
    statusSuspended: "suspendida (no se vende a agentes)",
    ruleMaxOrder: "máximo por orden",
    ruleMaxPeriod: "máximo por período",
    periodHourly: "por hora",
    periodDaily: "por día",
    periodWeekly: "por semana",
    ruleMaxQtyItem: "unidades máximas por artículo",
    ruleMaxQtyOrder: "unidades máximas por orden",
    ruleExcluded: "artículos excluidos",
    ruleShipTo: "países con despacho",
    allCountries: "todos los países donde ya despachas",
    ruleApprovalThreshold: "aprobación humana sobre",
    noLimit: "sin límite",
    ruleApprovals: "Aprobaciones humanas",
    enabled: "activado",
    disabled: "desactivado",
    ruleTtl: "tiempo para decidir",
    minutes: "min",
    channelWebhook: "webhook",
    channelWhatsapp: "WhatsApp",
    configured: "configurado",
    notConfigured: "no configurado",
    ruleIdentity: "Identidad de agentes",
    ruleMode: "modo",
    identityOpen: "abierto: cualquier agente puede comprar",
    identityIdentified: "identificado: la identidad se verifica y registra cuando se envía",
    identityVerifiedOnly: "solo verificados: se exige atestación del dueño",
    ruleAutoRegister: "registro automático",
    ruleReceipts: "Comprobantes firmados",
    ruleReceiptsPublic: "comprobante público por orden",
    ruleCheckout: "Cobro",
    ruleCartTtl: "vigencia del carrito",
    ruleNetwork: "red y activo",
    rulePayTo: "wallet que recibe los pagos",
    rulesError: "No se pudieron cargar las reglas.",
    yes: "sí",
    no: "no",
  },
  en: {
    title: "Sales to agents",
    subtitle: "Public, aggregated metrics for this store. No buyer data.",
    tabMetrics: "Metrics",
    tabCatalog: "Catalog",
    tabRules: "Rules",
    paidOrders: "paid orders",
    total: "total sold",
    payers: "unique paying wallets",
    agents: "identified agents",
    latency: "checkout → platform order",
    held: "on hold",
    pending: "pending platform order",
    perDay: "Orders per day",
    range7: "7 days",
    range30: "30 days",
    range90: "90 days",
    empty: "No sales in this period yet.",
    error: "Could not load metrics.",
    footer: "Verifiable by anyone at",
    updated: "updated",
    catalogSubtitle: "The published items, exactly as an agent receives them.",
    itemsPublished: "published items",
    physical: "physical",
    digital: "digital",
    stockTracked: "stock tracked",
    stockUntracked: "stock untracked",
    catalogEmpty:
      "No published items yet. Run agentpos scan, review the draft with agentpos confirm, then expose it with agentpos publish.",
    catalogError: "Could not load the catalog.",
    rulesSubtitle:
      "The rules this store enforces on agent purchases. Read-only: edit them in agentpos.config.json.",
    rulePolicy: "Sales policy",
    ruleStatus: "status",
    statusActive: "active",
    statusSuspended: "suspended (not selling to agents)",
    ruleMaxOrder: "max per order",
    ruleMaxPeriod: "max per period",
    periodHourly: "per hour",
    periodDaily: "per day",
    periodWeekly: "per week",
    ruleMaxQtyItem: "max units per item",
    ruleMaxQtyOrder: "max units per order",
    ruleExcluded: "excluded items",
    ruleShipTo: "shipping countries",
    allCountries: "every country you already ship to",
    ruleApprovalThreshold: "human approval above",
    noLimit: "no limit",
    ruleApprovals: "Human approvals",
    enabled: "enabled",
    disabled: "disabled",
    ruleTtl: "time to decide",
    minutes: "min",
    channelWebhook: "webhook",
    channelWhatsapp: "WhatsApp",
    configured: "configured",
    notConfigured: "not configured",
    ruleIdentity: "Agent identity",
    ruleMode: "mode",
    identityOpen: "open: any agent can buy",
    identityIdentified: "identified: identity is verified and recorded when sent",
    identityVerifiedOnly: "verified only: a valid owner attestation is required",
    ruleAutoRegister: "auto-register",
    ruleReceipts: "Signed receipts",
    ruleReceiptsPublic: "public receipt per order",
    ruleCheckout: "Payment",
    ruleCartTtl: "cart lifetime",
    ruleNetwork: "network and asset",
    rulePayTo: "wallet receiving payments",
    rulesError: "Could not load the rules.",
    yes: "yes",
    no: "no",
  },
} as const;

export interface DashboardInput {
  displayName: string;
  basePath: string;
  locale: "en" | "es";
  network: string;
  asset: string;
}

export function buildDashboardHtml(input: DashboardInput): string {
  const t = STRINGS[input.locale];
  const metricsPath = `${input.basePath}/metrics`;
  const catalogPath = `${input.basePath}/catalog`;
  const rulesPath = `${input.basePath}/dashboard/rules`;
  // Static shell + client-side rendering. JSON.stringify guards every interpolated value that
  // could carry markup; displayName is merchant-controlled but escaped anyway. The client
  // script escapes again everything it takes from the JSON endpoints (item titles, attributes).
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="${input.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.displayName)} · ${esc(t.title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #e6edf3; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 40px 20px; }
  h1 { font-size: 1.4rem; margin: 0; letter-spacing: -0.02em; }
  .sub { color: #8b949e; margin: 6px 0 28px; }
  .net { display: inline-block; font-family: ui-monospace, monospace; font-size: 0.78rem; color: #7ee2a8; background: #12261a; border: 1px solid #1f4030; border-radius: 999px; padding: 2px 10px; margin-left: 8px; vertical-align: middle; }
  .tabs { display: flex; gap: 20px; border-bottom: 1px solid #30363d; margin: 20px 0 24px; }
  .tabs button { background: none; border: none; border-bottom: 2px solid transparent; color: #8b949e; padding: 8px 2px 10px; cursor: pointer; font: inherit; font-size: 0.95rem; }
  .tabs button[data-on] { color: #e6edf3; border-bottom-color: #58a6ff; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 28px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 16px; }
  .card .v { font-size: 1.6rem; font-weight: 650; letter-spacing: -0.02em; }
  .card .k { color: #8b949e; font-size: 0.85rem; margin-top: 2px; }
  .card .s { color: #8b949e; font-size: 0.78rem; margin-top: 6px; }
  .card h3 { margin: 0 0 10px; font-size: 0.95rem; }
  .rangebar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
  .rangebar h2 { font-size: 1rem; margin: 0 auto 0 0; }
  .rangebar button { background: #161b22; color: #8b949e; border: 1px solid #30363d; border-radius: 8px; padding: 4px 12px; cursor: pointer; font: inherit; font-size: 0.82rem; }
  .rangebar button[data-on] { color: #e6edf3; border-color: #58a6ff; }
  .chart { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 18px; min-height: 180px; }
  .chart svg { width: 100%; height: 170px; display: block; }
  .bar { fill: #58a6ff; }
  .bar:hover { fill: #79b8ff; }
  .axis { fill: #8b949e; font-size: 10px; }
  .msg { color: #8b949e; padding: 40px 0; text-align: center; }
  .foot { color: #484f58; font-size: 0.8rem; margin-top: 28px; }
  .foot code { color: #8b949e; }
  .igrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
  .item .t { font-weight: 650; }
  .item .p { color: #7ee2a8; font-family: ui-monospace, monospace; margin: 4px 0 8px; }
  .badge { display: inline-block; font-size: 0.75rem; color: #8b949e; border: 1px solid #30363d; border-radius: 999px; padding: 1px 8px; margin: 0 6px 4px 0; }
  .rgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; align-items: start; }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; border-top: 1px solid #21262d; font-size: 0.85rem; }
  .row:first-of-type { border-top: none; }
  .rk { color: #8b949e; }
  .rv { text-align: right; }
  .rv.mono { font-family: ui-monospace, monospace; font-size: 0.72rem; word-break: break-all; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${esc(input.displayName)}<span class="net">${esc(input.network)} · ${esc(input.asset)}</span></h1>
  <div class="tabs" role="tablist">
    <button data-tab="metrics" data-on>${esc(t.tabMetrics)}</button>
    <button data-tab="catalog">${esc(t.tabCatalog)}</button>
    <button data-tab="rules">${esc(t.tabRules)}</button>
  </div>
  <section id="tab-metrics">
    <p class="sub">${esc(t.subtitle)}</p>
    <div class="cards" id="cards"></div>
    <div class="rangebar">
      <h2>${esc(t.perDay)}</h2>
      <button data-days="7">${esc(t.range7)}</button>
      <button data-days="30" data-on>${esc(t.range30)}</button>
      <button data-days="90">${esc(t.range90)}</button>
    </div>
    <div class="chart" id="chart"><div class="msg">…</div></div>
    <p class="foot">${esc(t.footer)} <code>${esc(metricsPath)}</code> · <span id="updated"></span></p>
  </section>
  <section id="tab-catalog" hidden>
    <p class="sub">${esc(t.catalogSubtitle)}</p>
    <div id="catalog-body"><div class="msg">…</div></div>
    <p class="foot">${esc(t.footer)} <code>${esc(catalogPath)}</code></p>
  </section>
  <section id="tab-rules" hidden>
    <p class="sub">${esc(t.rulesSubtitle)}</p>
    <div id="rules-body"><div class="msg">…</div></div>
    <p class="foot">${esc(t.footer)} <code>${esc(rulesPath)}</code></p>
  </section>
</div>
<script>
"use strict";
const T = ${JSON.stringify(t)};
const METRICS = ${JSON.stringify(metricsPath)};
const CATALOG = ${JSON.stringify(catalogPath)};
const RULES = ${JSON.stringify(rulesPath)};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmtMs = (ms) => ms === undefined ? "–" : ms >= 1000 ? (ms / 1000).toFixed(1) + " s" : ms + " ms";

function card(value, key, small) {
  return '<div class="card"><div class="v">' + value + '</div><div class="k">' + key + '</div>' +
    (small ? '<div class="s">' + small + '</div>' : '') + '</div>';
}

function render(m) {
  const held = [];
  if (m.heldOrders > 0) held.push(m.heldOrders + " " + T.held);
  if (m.pendingPlatformOrders > 0) held.push(m.pendingPlatformOrders + " " + T.pending);
  document.getElementById("cards").innerHTML =
    card(m.paidOrders, T.paidOrders, held.join(" · ")) +
    card(m.total + " " + m.asset, T.total) +
    card(m.uniquePayers, T.payers, m.uniqueIdentifiedAgents + " " + T.agents) +
    card("p50 " + fmtMs(m.latencyMs.p50), T.latency, "p95 " + fmtMs(m.latencyMs.p95));
  document.getElementById("updated").textContent = T.updated + " " + new Date(m.until).toLocaleString();

  const chart = document.getElementById("chart");
  const days = m.byDay;
  if (days.length === 0) { chart.innerHTML = '<div class="msg">' + T.empty + '</div>'; return; }
  const W = 840, H = 170, PAD = 24;
  const max = Math.max(...days.map((d) => d.orders));
  const bw = Math.max(3, Math.min(40, (W - PAD) / days.length - 3));
  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img">';
  days.forEach((d, i) => {
    const h = Math.max(2, (d.orders / max) * (H - 40));
    const x = PAD + i * ((W - PAD) / days.length);
    svg += '<rect class="bar" x="' + x + '" y="' + (H - 24 - h) + '" width="' + bw + '" height="' + h + '">' +
      '<title>' + d.day + ": " + d.orders + " · " + d.total + " " + m.asset + '</title></rect>';
    if (days.length <= 14 || i % Math.ceil(days.length / 10) === 0)
      svg += '<text class="axis" x="' + x + '" y="' + (H - 8) + '">' + d.day.slice(5) + '</text>';
  });
  svg += '<text class="axis" x="2" y="12">' + max + '</text></svg>';
  chart.innerHTML = svg;
}

async function load(days) {
  try {
    const res = await fetch(METRICS + "?days=" + days, { headers: { accept: "application/json" } });
    render(await res.json());
  } catch {
    document.getElementById("chart").innerHTML = '<div class="msg">' + T.error + '</div>';
  }
}
document.querySelectorAll(".rangebar button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".rangebar button").forEach((x) => x.removeAttribute("data-on"));
  b.setAttribute("data-on", "");
  load(b.dataset.days);
}));
load(30);

// --- catalog tab: the store exactly as an agent sees it ---------------------
function renderCatalog(data) {
  const body = document.getElementById("catalog-body");
  const items = data.items || [];
  if (items.length === 0) { body.innerHTML = '<div class="msg">' + esc(T.catalogEmpty) + '</div>'; return; }
  let html = '<p class="sub">' + items.length + " " + esc(T.itemsPublished) + '</p><div class="igrid">';
  items.forEach((it) => {
    const attrs = Object.entries(it.attributes || {}).map(([k, v]) => esc(k) + ": " + esc(v)).join(" · ");
    html += '<div class="card item"><div class="t">' + esc(it.title) + '</div>' +
      '<div class="p">' + esc(it.price.amount) + " " + esc(it.price.asset) + '</div>' +
      '<div><span class="badge">' + esc(it.physical ? T.physical : T.digital) + '</span>' +
      '<span class="badge">' + esc(it.stockMode === "tracked" ? T.stockTracked : T.stockUntracked) + '</span></div>' +
      (attrs ? '<div class="s">' + attrs + '</div>' : '') + '</div>';
  });
  body.innerHTML = html + "</div>";
}

async function loadCatalog() {
  try {
    const res = await fetch(CATALOG, { headers: { accept: "application/json" } });
    renderCatalog(await res.json());
  } catch {
    document.getElementById("catalog-body").innerHTML = '<div class="msg">' + esc(T.catalogError) + '</div>';
  }
}

// --- rules tab: what the store enforces -------------------------------------
function row(k, v, mono) {
  return '<div class="row"><span class="rk">' + esc(k) + '</span><span class="rv' + (mono ? " mono" : "") + '">' + esc(v) + '</span></div>';
}
function rcard(title, rows) {
  return '<div class="card"><h3>' + esc(title) + '</h3>' + rows.join("") + '</div>';
}

function renderRules(r) {
  const p = r.policy;
  const money = (v) => v === null ? T.noLimit : v + " " + r.asset;
  const num = (v) => v === null ? T.noLimit : String(v);
  const conf = (b) => b ? T.configured : T.notConfigured;
  const yesno = (b) => b ? T.yes : T.no;
  const periodName = { hourly: T.periodHourly, daily: T.periodDaily, weekly: T.periodWeekly }[p.period] || p.period;
  const idMode = { "open": T.identityOpen, "identified": T.identityIdentified, "verified-only": T.identityVerifiedOnly }[r.identity.mode] || r.identity.mode;
  document.getElementById("rules-body").innerHTML = '<div class="rgrid">' +
    rcard(T.rulePolicy, [
      row(T.ruleStatus, p.status === "active" ? T.statusActive : T.statusSuspended),
      row(T.ruleMaxOrder, money(p.maxOrderUsdc)),
      row(T.ruleMaxPeriod, p.maxPeriodUsdc === null ? T.noLimit : money(p.maxPeriodUsdc) + " " + periodName),
      row(T.ruleMaxQtyItem, num(p.maxQuantityPerItem)),
      row(T.ruleMaxQtyOrder, num(p.maxQuantityPerOrder)),
      row(T.ruleExcluded, String(p.excludedItemsCount)),
      row(T.ruleShipTo, p.allowedShippingCountries.length > 0 ? p.allowedShippingCountries.join(", ") : T.allCountries),
      row(T.ruleApprovalThreshold, p.approvalThresholdUsdc === null ? T.notConfigured : money(p.approvalThresholdUsdc)),
    ]) +
    rcard(T.ruleApprovals, [
      row(T.ruleStatus, r.approvals.enabled ? T.enabled : T.disabled),
      row(T.ruleTtl, r.approvals.ttlMinutes + " " + T.minutes),
      row(T.channelWebhook, conf(r.approvals.channels.webhook)),
      row(T.channelWhatsapp, conf(r.approvals.channels.whatsapp)),
    ]) +
    rcard(T.ruleIdentity, [
      row(T.ruleMode, idMode),
      row(T.ruleAutoRegister, yesno(r.identity.autoRegister)),
    ]) +
    rcard(T.ruleReceipts, [
      row(T.ruleStatus, r.receipts.enabled ? T.enabled : T.disabled),
      row(T.ruleReceiptsPublic, yesno(r.receipts.publicOrderReceipts)),
    ]) +
    rcard(T.ruleCheckout, [
      row(T.ruleCartTtl, r.cartTtlMinutes + " " + T.minutes),
      row(T.ruleNetwork, r.network + " · " + r.asset),
      row(T.rulePayTo, r.payTo, true),
    ]) +
    '</div>';
}

async function loadRules() {
  try {
    const res = await fetch(RULES, { headers: { accept: "application/json" } });
    renderRules(await res.json());
  } catch {
    document.getElementById("rules-body").innerHTML = '<div class="msg">' + esc(T.rulesError) + '</div>';
  }
}

// --- tab switching, loading each tab's data once ----------------------------
const tabLoaded = { catalog: false, rules: false };
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tabs button").forEach((x) => x.removeAttribute("data-on"));
  b.setAttribute("data-on", "");
  document.querySelectorAll("section[id^=tab-]").forEach((s) => { s.hidden = true; });
  const tab = b.dataset.tab;
  document.getElementById("tab-" + tab).hidden = false;
  if (tab === "catalog" && !tabLoaded.catalog) { tabLoaded.catalog = true; loadCatalog(); }
  if (tab === "rules" && !tabLoaded.rules) { tabLoaded.rules = true; loadRules(); }
}));
</script>
</body>
</html>`;
}
