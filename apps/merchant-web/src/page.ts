/**
 * The wizard page: one self-contained HTML document in the style of packages/site/src/dashboard.ts.
 *
 * Design constraints, all deliberate:
 *  - Zero external resources: no CDN, no fonts, no framework, no analytics. It works behind any
 *    CSP and leaks nothing about who views it.
 *  - Bilingual, Spanish first (copy tone: docs/onboarding.es.md; Spanish text uses no em dashes
 *    per project convention), with an EN toggle.
 *  - Everything the merchant types stays in the browser. The server endpoints act on a request
 *    and forget it; the page repeats that promise in the copy because it is the product's pitch.
 *  - API-derived text goes into the DOM via textContent, never innerHTML.
 */

const STRINGS = {
  es: {
    title: "Conecta tu tienda a AgentPOS",
    subtitle:
      "Genera tu configuración y verifica tu instalación, sin leer documentación. Nada de lo que escribas aquí se guarda en ningún servidor: todo queda en tu navegador y en los archivos que descargas.",
    tabSetup: "1 · Configurar",
    tabVerify: "2 · Verificar",
    s1Title: "Tu tienda",
    s1Url: "URL pública de tu tienda",
    s1UrlPh: "https://mitienda.cl",
    s1Name: "Nombre (lo que verán los agentes)",
    s1NamePh: "Tienda Faro",
    s1Platform: "¿Dónde viven tus órdenes?",
    s1Woo: "WooCommerce (API REST)",
    s1Generic: "Otra plataforma (hook personalizado)",
    s2Title: "Tu billetera Stellar",
    s2Note:
      "Aquí llega tu plata, directo y sin intermediarios. Solo la dirección pública; jamás tu llave secreta.",
    s2Addr: "Dirección pública (empieza con G)",
    s2Check: "Validar dirección",
    s2Ok: "Dirección válida.",
    s3Title: "Claves REST de WooCommerce",
    s3Note:
      "Con esto AgentPOS crea las órdenes en tu admin. Las claves se usan una sola vez para probar la conexión y quedan escritas en tu archivo .env; no se guardan en ningún servidor.",
    s3Where: "WP Admin → WooCommerce → Ajustes → Avanzado → API REST → Añadir clave (Lectura/Escritura).",
    s3BaseUrl: "URL del sitio WordPress",
    s3Ck: "Consumer key",
    s3Cs: "Consumer secret",
    s3Check: "Probar conexión",
    s3Checking: "Probando...",
    s3Ok: "Conexión correcta: la clave funciona.",
    s4Title: "Tus archivos",
    s4Note:
      "Dos archivos, generados con la misma validación que usa el sidecar: si aparecen aquí, el sidecar los acepta.",
    s4Generate: "Generar archivos",
    s4Copy: "Copiar",
    s4Copied: "Copiado",
    s4Download: "Descargar",
    s4ProxyTitle: "Rutas del proxy",
    s4ProxyNote:
      "Tu dominio tiene que redirigir estas rutas al sidecar (puerto 8402). Elige tu servidor:",
    s4CmdTitle: "Siguientes comandos",
    s4CmdNote:
      "En tu servidor, en la carpeta donde dejaste los dos archivos. El escáner solo lee tu tienda, tú fijas cada precio y nada se publica sin tu ok.",
    vTitle: "Verificación, sin confiar en nadie",
    vNote:
      "Escribe tu dominio y comprobamos lo mismo que comprueba un agente comprador real: que tu tienda se describe sola y que el sidecar responde.",
    vDomain: "Tu dominio",
    vDomainPh: "mitienda.cl",
    vRun: "Verificar",
    vRunning: "Verificando...",
    vAllOk: "Tu tienda está lista: los agentes pueden encontrarla y comprarte.",
    vSomeFail: "Todavía falta algo. Revisa las pistas de cada punto rojo.",
    vStore: "Tienda",
    vNetwork: "red",
    checkHealth: "El sidecar responde (/agentpos/health)",
    checkOpenapi: "Contrato OpenAPI (/openapi.json)",
    checkUcp: "Manifiesto UCP (/.well-known/ucp)",
    checkLlms: "llms.txt (recomendado)",
    errNetwork: "No se pudo contactar al servidor del asistente. ¿Sigue corriendo?",
    footer:
      "AgentPOS es open source (Apache-2.0). Este asistente no tiene cuentas ni base de datos; puedes cerrarlo cuando quieras.",
  },
  en: {
    title: "Connect your store to AgentPOS",
    subtitle:
      "Generate your configuration and verify your install, without reading docs. Nothing you type here is stored on any server: it all stays in your browser and in the files you download.",
    tabSetup: "1 · Configure",
    tabVerify: "2 · Verify",
    s1Title: "Your store",
    s1Url: "Public URL of your store",
    s1UrlPh: "https://myshop.example",
    s1Name: "Name (what agents will see)",
    s1NamePh: "Faro Store",
    s1Platform: "Where do your orders live?",
    s1Woo: "WooCommerce (REST API)",
    s1Generic: "Other platform (custom hook)",
    s2Title: "Your Stellar wallet",
    s2Note:
      "This is where your money arrives, directly, no intermediaries. Only the public address — never your secret key.",
    s2Addr: "Public address (starts with G)",
    s2Check: "Validate address",
    s2Ok: "Valid address.",
    s3Title: "WooCommerce REST keys",
    s3Note:
      "This is how AgentPOS creates orders in your admin. The keys are used once to test the connection and end up in your .env file; they are not stored on any server.",
    s3Where: "WP Admin → WooCommerce → Settings → Advanced → REST API → Add key (Read/Write).",
    s3BaseUrl: "WordPress site URL",
    s3Ck: "Consumer key",
    s3Cs: "Consumer secret",
    s3Check: "Test connection",
    s3Checking: "Testing...",
    s3Ok: "Connection works: the key is good.",
    s4Title: "Your files",
    s4Note:
      "Two files, generated with the very validation the sidecar runs: if they show up here, the sidecar accepts them.",
    s4Generate: "Generate files",
    s4Copy: "Copy",
    s4Copied: "Copied",
    s4Download: "Download",
    s4ProxyTitle: "Proxy rules",
    s4ProxyNote:
      "Your domain must forward these paths to the sidecar (port 8402). Pick your server:",
    s4CmdTitle: "Next commands",
    s4CmdNote:
      "On your server, in the folder holding the two files. The scanner reads only your store, you set every price, and nothing is published without your ok.",
    vTitle: "Verification, trusting nobody",
    vNote:
      "Type your domain and we check exactly what a real buying agent checks: that your store describes itself and the sidecar answers.",
    vDomain: "Your domain",
    vDomainPh: "myshop.example",
    vRun: "Verify",
    vRunning: "Verifying...",
    vAllOk: "Your store is ready: agents can find it and buy from you.",
    vSomeFail: "Something is still missing. Follow the hint on each red item.",
    vStore: "Store",
    vNetwork: "network",
    checkHealth: "Sidecar answers (/agentpos/health)",
    checkOpenapi: "OpenAPI contract (/openapi.json)",
    checkUcp: "UCP manifest (/.well-known/ucp)",
    checkLlms: "llms.txt (recommended)",
    errNetwork: "Could not reach the wizard server. Is it still running?",
    footer:
      "AgentPOS is open source (Apache-2.0). This wizard has no accounts and no database; close it whenever you want.",
  },
} as const;

export function buildWizardHtml(): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentPOS · Onboarding</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #e6edf3; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 40px 20px; }
  h1 { font-size: 1.5rem; margin: 0; letter-spacing: -0.02em; }
  h2 { font-size: 1.05rem; margin: 0 0 4px; }
  .sub { color: #8b949e; margin: 8px 0 24px; max-width: 64ch; }
  .top { display: flex; align-items: flex-start; gap: 12px; }
  .top h1 { margin-right: auto; }
  .lang button { background: none; border: 1px solid #30363d; color: #8b949e; border-radius: 8px; padding: 3px 10px; cursor: pointer; font: inherit; font-size: 0.8rem; }
  .lang button[data-on] { color: #e6edf3; border-color: #58a6ff; }
  .tabs { display: flex; gap: 8px; margin-bottom: 20px; }
  .tabs button { background: #161b22; color: #8b949e; border: 1px solid #30363d; border-radius: 10px; padding: 8px 18px; cursor: pointer; font: inherit; }
  .tabs button[data-on] { color: #e6edf3; border-color: #58a6ff; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  .card .note { color: #8b949e; font-size: 0.88rem; margin: 2px 0 14px; }
  .step { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 999px; background: #12261a; color: #7ee2a8; border: 1px solid #1f4030; font-size: 0.8rem; margin-right: 8px; }
  label { display: block; color: #8b949e; font-size: 0.82rem; margin: 12px 0 4px; }
  input, select { width: 100%; background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 8px; padding: 9px 12px; font: inherit; }
  input:focus, select:focus { outline: none; border-color: #58a6ff; }
  input.mono { font-family: ui-monospace, monospace; font-size: 0.86rem; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 640px) { .row { grid-template-columns: 1fr; } }
  button.act { background: #1f6feb; color: #fff; border: none; border-radius: 8px; padding: 9px 18px; cursor: pointer; font: inherit; margin-top: 14px; }
  button.act:disabled { opacity: 0.5; cursor: default; }
  button.ghost { background: #161b22; color: #8b949e; border: 1px solid #30363d; border-radius: 8px; padding: 4px 12px; cursor: pointer; font: inherit; font-size: 0.8rem; }
  .msg { margin-top: 10px; font-size: 0.88rem; border-radius: 8px; padding: 10px 12px; display: none; }
  .msg.ok { display: block; background: #12261a; border: 1px solid #1f4030; color: #7ee2a8; }
  .msg.err { display: block; background: #2d1215; border: 1px solid #58272c; color: #ff9b9b; }
  .msg .hint { color: #8b949e; margin-top: 4px; }
  .msg code.ecode { color: #d2a8ff; font-size: 0.78rem; }
  .filehead { display: flex; align-items: center; gap: 8px; margin: 18px 0 6px; }
  .filehead code { font-size: 0.85rem; color: #7ee2a8; margin-right: auto; }
  pre { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 12px; overflow-x: auto; font-size: 0.82rem; margin: 0; }
  .checks { list-style: none; margin: 16px 0 0; padding: 0; }
  .checks li { display: flex; gap: 10px; padding: 10px 0; border-top: 1px solid #21262d; align-items: baseline; }
  .checks .dot { flex: none; width: 10px; height: 10px; border-radius: 999px; margin-top: 5px; }
  .checks .pass { background: #3fb950; }
  .checks .fail { background: #f85149; }
  .checks .hint { display: block; color: #8b949e; font-size: 0.82rem; }
  .checks .url { display: block; color: #484f58; font-family: ui-monospace, monospace; font-size: 0.75rem; }
  .storeinfo { color: #8b949e; font-size: 0.85rem; margin-top: 12px; }
  .foot { color: #484f58; font-size: 0.8rem; margin-top: 28px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <h1 data-i18n="title"></h1>
    <div class="lang"><button data-lang="es" data-on>ES</button> <button data-lang="en">EN</button></div>
  </div>
  <p class="sub" data-i18n="subtitle"></p>

  <div class="tabs">
    <button data-tab="setup" data-on data-i18n="tabSetup"></button>
    <button data-tab="verify" data-i18n="tabVerify"></button>
  </div>

  <div id="tab-setup">
    <div class="card">
      <h2><span class="step">1</span><span data-i18n="s1Title"></span></h2>
      <div class="row">
        <div><label for="siteUrl" data-i18n="s1Url"></label>
          <input id="siteUrl" type="url" data-i18n-ph="s1UrlPh" autocomplete="url"></div>
        <div><label for="displayName" data-i18n="s1Name"></label>
          <input id="displayName" type="text" data-i18n-ph="s1NamePh"></div>
      </div>
      <label for="platform" data-i18n="s1Platform"></label>
      <select id="platform">
        <option value="woocommerce" data-i18n="s1Woo"></option>
        <option value="generic" data-i18n="s1Generic"></option>
      </select>
    </div>

    <div class="card">
      <h2><span class="step">2</span><span data-i18n="s2Title"></span></h2>
      <p class="note" data-i18n="s2Note"></p>
      <label for="payTo" data-i18n="s2Addr"></label>
      <input id="payTo" class="mono" type="text" placeholder="G..." spellcheck="false" autocomplete="off">
      <button class="act" id="btn-wallet" data-i18n="s2Check"></button>
      <div class="msg" id="msg-wallet"></div>
    </div>

    <div class="card" id="card-woo">
      <h2><span class="step">3</span><span data-i18n="s3Title"></span></h2>
      <p class="note" data-i18n="s3Note"></p>
      <p class="note" data-i18n="s3Where"></p>
      <label for="wooBaseUrl" data-i18n="s3BaseUrl"></label>
      <input id="wooBaseUrl" type="url" data-i18n-ph="s1UrlPh">
      <div class="row">
        <div><label for="wooCk" data-i18n="s3Ck"></label>
          <input id="wooCk" class="mono" type="text" placeholder="ck_..." spellcheck="false" autocomplete="off"></div>
        <div><label for="wooCs" data-i18n="s3Cs"></label>
          <input id="wooCs" class="mono" type="password" placeholder="cs_..." spellcheck="false" autocomplete="off"></div>
      </div>
      <button class="act" id="btn-woo" data-i18n="s3Check"></button>
      <div class="msg" id="msg-woo"></div>
    </div>

    <div class="card">
      <h2><span class="step">4</span><span data-i18n="s4Title"></span></h2>
      <p class="note" data-i18n="s4Note"></p>
      <button class="act" id="btn-generate" data-i18n="s4Generate"></button>
      <div class="msg" id="msg-generate"></div>
      <div id="output" hidden>
        <div class="filehead"><code id="fn-config"></code>
          <button class="ghost" data-copy="config" data-i18n="s4Copy"></button>
          <button class="ghost" data-dl="config" data-i18n="s4Download"></button></div>
        <pre id="pre-config"></pre>
        <div class="filehead"><code>.env</code>
          <button class="ghost" data-copy="env" data-i18n="s4Copy"></button>
          <button class="ghost" data-dl="env" data-i18n="s4Download"></button></div>
        <pre id="pre-env"></pre>
        <h2 style="margin-top:22px" data-i18n="s4ProxyTitle"></h2>
        <p class="note" data-i18n="s4ProxyNote"></p>
        <div class="filehead"><code>nginx</code><button class="ghost" data-copy="nginx" data-i18n="s4Copy"></button></div>
        <pre id="pre-nginx"></pre>
        <div class="filehead"><code>Caddy</code><button class="ghost" data-copy="caddy" data-i18n="s4Copy"></button></div>
        <pre id="pre-caddy"></pre>
        <h2 style="margin-top:22px" data-i18n="s4CmdTitle"></h2>
        <p class="note" data-i18n="s4CmdNote"></p>
        <div class="filehead"><code>shell</code><button class="ghost" data-copy="commands" data-i18n="s4Copy"></button></div>
        <pre id="pre-commands"></pre>
      </div>
    </div>
  </div>

  <div id="tab-verify" hidden>
    <div class="card">
      <h2 data-i18n="vTitle"></h2>
      <p class="note" data-i18n="vNote"></p>
      <label for="verifyDomain" data-i18n="vDomain"></label>
      <input id="verifyDomain" type="text" data-i18n-ph="vDomainPh" spellcheck="false">
      <button class="act" id="btn-verify" data-i18n="vRun"></button>
      <div class="msg" id="msg-verify"></div>
      <div class="storeinfo" id="verify-store"></div>
      <ul class="checks" id="verify-checks"></ul>
    </div>
  </div>

  <p class="foot" data-i18n="footer"></p>
</div>
<script>
"use strict";
const I18N = ${JSON.stringify(STRINGS)};
let lang = "es";
const $ = (id) => document.getElementById(id);
const t = (key) => I18N[lang][key] || key;

function setLang(next) {
  lang = next;
  document.documentElement.lang = next;
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll(".lang button").forEach((b) => {
    if (b.dataset.lang === next) b.setAttribute("data-on", ""); else b.removeAttribute("data-on");
  });
}
document.querySelectorAll(".lang button").forEach((b) =>
  b.addEventListener("click", () => setLang(b.dataset.lang)));

document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tabs button").forEach((x) => x.removeAttribute("data-on"));
  b.setAttribute("data-on", "");
  $("tab-setup").hidden = b.dataset.tab !== "setup";
  $("tab-verify").hidden = b.dataset.tab !== "verify";
}));

$("platform").addEventListener("change", () => {
  $("card-woo").hidden = $("platform").value !== "woocommerce";
});
$("siteUrl").addEventListener("change", () => {
  if (!$("wooBaseUrl").value) $("wooBaseUrl").value = $("siteUrl").value;
});

// --- messages -------------------------------------------------------------
function clearMsg(el) { el.className = "msg"; el.textContent = ""; }
function showOk(el, text) { el.className = "msg ok"; el.textContent = text; }
function showErr(el, error) {
  el.className = "msg err";
  el.textContent = "";
  const code = document.createElement("code");
  code.className = "ecode";
  code.textContent = error.code || "ERROR";
  const msg = document.createElement("div");
  msg.textContent = error.message || t("errNetwork");
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = error.hint || "";
  el.append(code, msg, hint);
}

async function api(path, options) {
  let res;
  try { res = await fetch(path, options); }
  catch { return { ok: false, error: { message: t("errNetwork") } }; }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: body.error || { message: t("errNetwork") } };
  return { ok: true, body };
}
const post = (path, payload) => api(path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

// --- step 2: wallet -------------------------------------------------------
$("btn-wallet").addEventListener("click", async () => {
  clearMsg($("msg-wallet"));
  const r = await post("/api/validate-wallet", { address: $("payTo").value });
  if (r.ok) showOk($("msg-wallet"), t("s2Ok")); else showErr($("msg-wallet"), r.error);
});
// Refuse a pasted secret instantly, before it even travels to the wizard server.
$("payTo").addEventListener("input", () => {
  if ($("payTo").value.trim().startsWith("S")) $("btn-wallet").click();
});

// --- step 3: woo ----------------------------------------------------------
$("btn-woo").addEventListener("click", async () => {
  const btn = $("btn-woo");
  clearMsg($("msg-woo"));
  btn.disabled = true; btn.textContent = t("s3Checking");
  const r = await post("/api/validate-woo", {
    baseUrl: $("wooBaseUrl").value || $("siteUrl").value,
    consumerKey: $("wooCk").value.trim(),
    consumerSecret: $("wooCs").value.trim(),
  });
  btn.disabled = false; btn.textContent = t("s3Check");
  if (r.ok) showOk($("msg-woo"), t("s3Ok")); else showErr($("msg-woo"), r.error);
});

// --- step 4: generate -----------------------------------------------------
let generated = null;
$("btn-generate").addEventListener("click", async () => {
  clearMsg($("msg-generate"));
  const platform = $("platform").value;
  const payload = {
    siteUrl: $("siteUrl").value.trim(),
    displayName: $("displayName").value.trim(),
    payTo: $("payTo").value.trim(),
    platform: platform,
  };
  if (platform === "woocommerce") {
    if ($("wooBaseUrl").value.trim()) payload.wooBaseUrl = $("wooBaseUrl").value.trim();
    if ($("wooCk").value.trim()) payload.wooConsumerKey = $("wooCk").value.trim();
    if ($("wooCs").value.trim()) payload.wooConsumerSecret = $("wooCs").value.trim();
  }
  const r = await post("/api/generate", payload);
  if (!r.ok) { $("output").hidden = true; showErr($("msg-generate"), r.error); return; }
  generated = r.body;
  $("fn-config").textContent = generated.files.config.filename;
  $("pre-config").textContent = generated.files.config.content;
  $("pre-env").textContent = generated.files.env.content;
  $("pre-nginx").textContent = generated.proxy.nginx;
  $("pre-caddy").textContent = generated.proxy.caddy;
  $("pre-commands").textContent = generated.commands.join("\\n");
  $("output").hidden = false;
});

function textFor(kind) {
  if (!generated) return "";
  if (kind === "config") return generated.files.config.content;
  if (kind === "env") return generated.files.env.content;
  if (kind === "nginx") return generated.proxy.nginx;
  if (kind === "caddy") return generated.proxy.caddy;
  return generated.commands.join("\\n");
}
document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(textFor(b.dataset.copy)); } catch { return; }
  const old = b.textContent;
  b.textContent = t("s4Copied");
  setTimeout(() => { b.textContent = old; }, 1200);
}));
document.querySelectorAll("[data-dl]").forEach((b) => b.addEventListener("click", () => {
  if (!generated) return;
  const file = b.dataset.dl === "config" ? generated.files.config : generated.files.env;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([file.content], { type: "text/plain" }));
  a.download = file.filename;
  a.click();
  URL.revokeObjectURL(a.href);
}));

// --- verify ---------------------------------------------------------------
const CHECK_LABELS = { health: "checkHealth", openapi: "checkOpenapi", ucp: "checkUcp", llms: "checkLlms" };
$("btn-verify").addEventListener("click", async () => {
  const btn = $("btn-verify");
  clearMsg($("msg-verify"));
  $("verify-checks").textContent = "";
  $("verify-store").textContent = "";
  btn.disabled = true; btn.textContent = t("vRunning");
  const r = await api("/api/verify?domain=" + encodeURIComponent($("verifyDomain").value.trim()));
  btn.disabled = false; btn.textContent = t("vRun");
  if (!r.ok) { showErr($("msg-verify"), r.error); return; }
  const result = r.body;
  if (result.ok) showOk($("msg-verify"), t("vAllOk"));
  else showErr($("msg-verify"), { code: "CHECKS_FAILED", message: t("vSomeFail"), hint: "" });
  if (result.store && result.store.name) {
    $("verify-store").textContent = t("vStore") + ": " + result.store.name +
      (result.store.network ? " · " + t("vNetwork") + " " + result.store.network : "") +
      (result.store.asset ? " · " + result.store.asset : "");
  }
  for (const check of result.checks) {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "dot " + (check.ok ? "pass" : "fail");
    const body = document.createElement("div");
    const label = document.createElement("span");
    label.textContent = t(CHECK_LABELS[check.id] || check.id) + (check.status ? " · " + check.status : "");
    const url = document.createElement("span");
    url.className = "url";
    url.textContent = check.url;
    body.append(label, url);
    if (!check.ok && check.hint) {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = check.hint;
      body.append(hint);
    }
    li.append(dot, body);
    $("verify-checks").append(li);
  }
});

setLang("es");
</script>
</body>
</html>`;
}
