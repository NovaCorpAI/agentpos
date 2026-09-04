/**
 * Server-rendered pages, one self-contained HTML document each, same constraints as
 * packages/site/src/dashboard.ts: zero external resources (no CDN, no fonts, no analytics)
 * and nothing interpolated without escaping. Plain forms, no client framework.
 */
import type { ActivityEntry, Proposal, ServiceStatus } from "./types.js";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #e6edf3; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 32px 20px 60px; }
  header { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
  h1 { font-size: 1.3rem; margin: 0; letter-spacing: -0.02em; }
  h2 { font-size: 1.05rem; margin: 28px 0 10px; }
  nav { margin-left: auto; display: flex; gap: 14px; }
  nav a { color: #8b949e; text-decoration: none; font-size: 0.92rem; }
  nav a[data-on] { color: #e6edf3; border-bottom: 2px solid #58a6ff; padding-bottom: 2px; }
  .net { font-family: ui-monospace, monospace; font-size: 0.75rem; color: #7ee2a8; background: #12261a; border: 1px solid #1f4030; border-radius: 999px; padding: 2px 10px; }
  .sub { color: #8b949e; margin: 0 0 20px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 18px; margin-bottom: 14px; }
  .banner { border-radius: 10px; padding: 10px 14px; margin-bottom: 16px; font-size: 0.92rem; }
  .banner.ok { background: #12261a; border: 1px solid #1f4030; color: #7ee2a8; }
  .banner.err { background: #2a1215; border: 1px solid #5a1e24; color: #ff9c9c; }
  .custody { color: #8b949e; font-size: 0.85rem; border-left: 3px solid #58a6ff; padding-left: 12px; margin: 16px 0; }
  label { display: block; color: #8b949e; font-size: 0.85rem; margin: 14px 0 4px; }
  input[type=text], input[type=email], select, textarea { width: 100%; background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 8px; padding: 8px 10px; font: inherit; }
  textarea { min-height: 74px; font-family: ui-monospace, monospace; font-size: 0.85rem; }
  .row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; }
  .check { display: flex; gap: 8px; align-items: center; margin-top: 14px; color: #e6edf3; font-size: 0.92rem; }
  .check input { width: auto; }
  button { background: #1f6feb; color: #fff; border: 0; border-radius: 8px; padding: 8px 18px; font: inherit; cursor: pointer; margin-top: 18px; }
  button.ghost { background: #161b22; color: #e6edf3; border: 1px solid #30363d; }
  button.danger { background: #161b22; color: #ff9c9c; border: 1px solid #5a1e24; }
  .actions { display: flex; gap: 10px; }
  .actions form { margin: 0; }
  .meta { color: #8b949e; font-size: 0.83rem; }
  .amount { font-size: 1.25rem; font-weight: 650; letter-spacing: -0.02em; }
  .tag { display: inline-block; font-size: 0.75rem; border-radius: 999px; padding: 1px 10px; margin-left: 8px; vertical-align: middle; }
  .tag.pending { color: #d29922; background: #271d12; border: 1px solid #4d3800; }
  .tag.approved { color: #7ee2a8; background: #12261a; border: 1px solid #1f4030; }
  .tag.rejected { color: #ff9c9c; background: #2a1215; border: 1px solid #5a1e24; }
  .tag.expired { color: #8b949e; background: #161b22; border: 1px solid #30363d; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-weight: 500; font-size: 0.8rem; }
  code, .mono { font-family: ui-monospace, monospace; font-size: 0.85em; color: #a5d6ff; word-break: break-all; }
  pre { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
  .empty { color: #8b949e; padding: 24px 0; text-align: center; }
`;

export interface LayoutInput {
  title: string;
  active: "mandate" | "proposals" | "activity";
  network: string;
  pendingCount: number;
  body: string;
}

export function layout(input: LayoutInput): string {
  const tab = (href: string, id: LayoutInput["active"], label: string) =>
    `<a href="${href}"${input.active === id ? " data-on" : ""}>${esc(label)}</a>`;
  const proposalsLabel = input.pendingCount > 0 ? `Proposals (${input.pendingCount})` : "Proposals";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.title)} · AgentPOS buyer</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>AgentPOS buyer</h1>
    <span class="net">${esc(input.network)}</span>
    <nav>
      ${tab("/", "mandate", "Mandate")}
      ${tab("/proposals", "proposals", proposalsLabel)}
      ${tab("/activity", "activity", "Activity")}
    </nav>
  </header>
  ${input.body}
</div>
</body>
</html>`;
}

// --- mandate editor ---------------------------------------------------------

export interface MandateFormValues {
  maxPerTx: string;
  maxTotal: string;
  period: string;
  stores: string;
  allowPhysicalGoods: boolean;
  email: string;
  walletAddress: string;
}

export function mandatePage(options: {
  values: MandateFormValues;
  network: string;
  pendingCount: number;
  saved?: boolean;
  error?: { code: string; message: string; hint: string };
}): string {
  const v = options.values;
  const banner = options.error
    ? `<div class="banner err"><strong>${esc(options.error.code)}</strong>: ${esc(options.error.message)}<br><span class="meta">${esc(options.error.hint)}</span></div>`
    : options.saved
      ? `<div class="banner ok">Mandate saved. The agent obeys it from the next action on.</div>`
      : "";
  const period = (value: string, label: string) =>
    `<option value="${value}"${v.period === value ? " selected" : ""}>${label}</option>`;
  const body = `
  <p class="sub">What your buying agent is allowed to do. It can never edit this page; only you can.</p>
  ${banner}
  <form method="post" action="/profile" class="card">
    <div class="row">
      <div>
        <label for="maxPerTx">Max per purchase (USDC)</label>
        <input type="text" id="maxPerTx" name="maxPerTx" value="${esc(v.maxPerTx)}" inputmode="decimal" required>
      </div>
      <div>
        <label for="maxTotal">Max per period (USDC)</label>
        <input type="text" id="maxTotal" name="maxTotal" value="${esc(v.maxTotal)}" inputmode="decimal" required>
      </div>
      <div>
        <label for="period">Period</label>
        <select id="period" name="period">
          ${period("day", "Day")}${period("week", "Week")}${period("month", "Month")}
        </select>
      </div>
    </div>
    <label for="stores">Allowed stores (one URL per line; empty allows any store)</label>
    <textarea id="stores" name="stores" placeholder="https://shop.example">${esc(v.stores)}</textarea>
    <div class="check">
      <input type="checkbox" id="allowPhysicalGoods" name="allowPhysicalGoods"${v.allowPhysicalGoods ? " checked" : ""}>
      <label for="allowPhysicalGoods" style="margin:0">Allow physical goods (things that ship to an address)</label>
    </div>
    <label for="email">Your contact email (stores send order updates here)</label>
    <input type="email" id="email" name="email" value="${esc(v.email)}" placeholder="you@example.com">
    <label for="walletAddress">Wallet public address (starts with G)</label>
    <input type="text" id="walletAddress" name="walletAddress" value="${esc(v.walletAddress)}" placeholder="G...">
    <p class="custody">This platform never stores or asks for a secret key. Payments are signed on your own machine; here you only link the public address so your agent knows which wallet the mandate is about.</p>
    <button type="submit">Save mandate</button>
  </form>`;
  return layout({
    title: "Mandate",
    active: "mandate",
    network: options.network,
    pendingCount: options.pendingCount,
    body,
  });
}

// --- proposals --------------------------------------------------------------

function statusTag(status: Proposal["status"]): string {
  const label = status === "approved" ? "approved · awaiting signature" : status;
  return `<span class="tag ${status}">${esc(label)}</span>`;
}

function proposalMeta(p: Proposal): string {
  return `<div class="meta">${esc(p.storeName)} · <span class="mono">${esc(p.storeUrl)}</span> · proposed ${esc(p.createdAt)}</div>`;
}

export function proposalsPage(options: {
  pending: Proposal[];
  approved: Proposal[];
  stores: string[];
  network: string;
  instructionsFor: (p: Proposal) => { checkoutUrl: string; cli: string; note: string };
  highlight?: string;
}): string {
  const pendingCards = options.pending
    .map(
      (p) => `
  <div class="card">
    <div class="amount">${esc(p.amount)} ${esc(p.asset)}${statusTag(p.status)}</div>
    <div>${esc(p.title)}</div>
    ${proposalMeta(p)}
    <div class="actions">
      <form method="post" action="/proposals/${esc(p.id)}/approve"><button type="submit">Approve</button></form>
      <form method="post" action="/proposals/${esc(p.id)}/reject"><button type="submit" class="danger">Reject</button></form>
    </div>
  </div>`,
    )
    .join("");

  const approvedCards = options.approved
    .map((p) => {
      const i = options.instructionsFor(p);
      return `
  <div class="card"${options.highlight === p.id ? ' style="border-color:#58a6ff"' : ""}>
    <div class="amount">${esc(p.amount)} ${esc(p.asset)}${statusTag(p.status)}</div>
    <div>${esc(p.title)}</div>
    ${proposalMeta(p)}
    <p class="custody">${esc(i.note)}</p>
    <div class="meta">Checkout: <span class="mono">${esc(i.checkoutUrl)}</span></div>
    <div class="meta">Pay from the machine that holds your key:</div>
    <pre><code>${esc(i.cli)}</code></pre>
    <div class="actions">
      <form method="post" action="/proposals/${esc(p.id)}/reject"><button type="submit" class="ghost">Cancel approval</button></form>
    </div>
  </div>`;
    })
    .join("");

  const storeOptions = options.stores
    .map((s) => `<option value="${esc(s)}">${esc(s)}</option>`)
    .join("");
  const proposeForm =
    options.stores.length > 0
      ? `
  <h2>Propose a purchase yourself</h2>
  <form method="post" action="/proposals" class="card">
    <div class="row">
      <div>
        <label for="storeUrl">Store</label>
        <select id="storeUrl" name="storeUrl">${storeOptions}</select>
      </div>
      <div>
        <label for="itemId">Item id</label>
        <input type="text" id="itemId" name="itemId" required>
      </div>
      <div>
        <label for="quantity">Quantity</label>
        <input type="text" id="quantity" name="quantity" value="1" inputmode="numeric">
      </div>
    </div>
    <button type="submit" class="ghost">Get a quote</button>
  </form>`
      : "";

  const body = `
  <p class="sub">What the agent wants to buy. Nothing is charged until you approve AND sign on your own machine.</p>
  <h2>Waiting for you</h2>
  ${pendingCards || '<div class="empty">No pending proposals.</div>'}
  <h2>Approved, awaiting signature</h2>
  ${approvedCards || '<div class="empty">Nothing approved and unpaid.</div>'}
  ${proposeForm}`;
  return layout({
    title: "Proposals",
    active: "proposals",
    network: options.network,
    pendingCount: options.pending.length,
    body,
  });
}

// --- activity ---------------------------------------------------------------

const KIND_LABEL: Record<ActivityEntry["kind"], string> = {
  "profile.saved": "mandate saved",
  search: "search",
  "proposal.created": "proposal created",
  "proposal.approved": "proposal approved",
  "proposal.rejected": "proposal rejected",
  "proposal.expired": "quote expired",
};

function activitySummary(e: ActivityEntry): string {
  const d = e.data;
  switch (e.kind) {
    case "profile.saved":
      return `max ${String(d.maxPerTx)} per purchase, ${String(d.maxTotal)} per ${String(d.period)}`;
    case "search":
      return `"${String(d.query)}" · ${String(d.results)} result(s)`;
    default:
      return [d.title, d.amount]
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
  const rows = options.activity
    .map(
      (e) =>
        `<tr><td class="meta">${esc(e.at)}</td><td>${esc(KIND_LABEL[e.kind] ?? e.kind)}</td><td class="meta">${esc(activitySummary(e))}</td></tr>`,
    )
    .join("");
  const history = options.proposals
    .map(
      (p) =>
        `<tr><td class="meta">${esc(p.createdAt)}</td><td>${esc(p.title)}</td><td>${esc(p.amount)} ${esc(p.asset)}</td><td>${statusTag(p.status)}</td></tr>`,
    )
    .join("");
  const s = options.status;
  const body = `
  <p class="sub">Everything the agent and you did, in order. Approved in this period: <strong>${esc(s.approvedInPeriod)} USDC</strong>${s.mandate ? ` of ${esc(s.mandate.maxTotal)} allowed per ${esc(s.mandate.period)}` : ""}.</p>
  <h2>Proposal history</h2>
  <div class="card">
    ${history ? `<table><tr><th>When</th><th>What</th><th>Amount</th><th>Status</th></tr>${history}</table>` : '<div class="empty">No proposals yet.</div>'}
  </div>
  <h2>Activity log</h2>
  <div class="card">
    ${rows ? `<table><tr><th>When</th><th>Event</th><th>Detail</th></tr>${rows}</table>` : '<div class="empty">Nothing yet.</div>'}
  </div>`;
  return layout({
    title: "Activity",
    active: "activity",
    network: options.network,
    pendingCount: s.pendingProposals,
    body,
  });
}

// --- error ------------------------------------------------------------------

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
  <p><a href="${esc(options.backHref)}" style="color:#58a6ff">&larr; back</a></p>`;
  return layout({
    title: "Error",
    active: "proposals",
    network: options.network,
    pendingCount: options.pendingCount,
    body,
  });
}
