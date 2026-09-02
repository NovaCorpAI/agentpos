/**
 * The store's own metrics dashboard (G2): a single self-contained HTML page served by the
 * sidecar at {base}/dashboard, rendering {base}/metrics in the visitor's browser.
 *
 * Design constraints, all deliberate:
 *  - Served BY the store, from the store's domain. The traction artifact for a merchant is
 *    "my store sells to agents, look", on their URL, not a page of ours aggregating them.
 *  - Zero external resources: no CDN, no fonts, no analytics. It must work on a sidecar behind
 *    any CSP and leak nothing about who views it.
 *  - It renders only what /agentgate/metrics exposes, which is aggregates by construction. The
 *    page cannot show buyer data because the endpoint does not have any.
 */

const STRINGS = {
  es: {
    title: "Ventas a agentes",
    subtitle: "Métricas públicas y agregadas de esta tienda. Sin datos de compradores.",
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
  },
  en: {
    title: "Sales to agents",
    subtitle: "Public, aggregated metrics for this store. No buyer data.",
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
  // Static shell + client-side rendering. JSON.stringify guards every interpolated value that
  // could carry markup; displayName is merchant-controlled but escaped anyway.
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
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 28px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 16px; }
  .card .v { font-size: 1.6rem; font-weight: 650; letter-spacing: -0.02em; }
  .card .k { color: #8b949e; font-size: 0.85rem; margin-top: 2px; }
  .card .s { color: #8b949e; font-size: 0.78rem; margin-top: 6px; }
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
</style>
</head>
<body>
<div class="wrap">
  <h1>${esc(input.displayName)}<span class="net">${esc(input.network)} · ${esc(input.asset)}</span></h1>
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
</div>
<script>
"use strict";
const T = ${JSON.stringify(t)};
const METRICS = ${JSON.stringify(metricsPath)};
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
</script>
</body>
</html>`;
}
