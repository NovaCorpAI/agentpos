/**
 * The seller's space: one self-contained HTML document, product-grade, in the AgentPOS brand.
 *
 * Design constraints, all deliberate:
 *  - Zero external resources: no CDN, no fonts, no framework, no analytics. It works behind any
 *    CSP and leaks nothing about who views it.
 *  - Bilingual, Spanish first (copy tone: docs/onboarding.es.md; Spanish text uses no em dashes
 *    per project convention), with an EN toggle. No emojis anywhere; sober enterprise tone.
 *  - A guided four-step flow with visible progress: store, wallet, review and download,
 *    install and sell. Every step says what is happening and why it is safe.
 *  - Everything the merchant types stays in the browser. The server endpoints act on a request
 *    and forget it; the page repeats that promise in the copy because it is the product's pitch.
 *  - API-derived text goes into the DOM via textContent, never innerHTML. Errors are rendered
 *    as guidance (message plus hint), with the machine-readable code as a discreet footnote.
 */

const STRINGS = {
  es: {
    brandTag: "Espacio del vendedor",
    strip1: "Cero custodia",
    strip2: "Ninguna orden sin pago liquidado",
    strip3: "Tarifa fija por servicios gestionados, jamás porcentaje de tu venta",
    heroTitle: "Conecta tu tienda en 15 minutos",
    heroSub:
      "Tu tienda pasa a aceptar compras de agentes de IA que pagan en USDC sobre Stellar, y cada orden llega al mismo admin que ya usas. Nada de lo que escribas aquí se guarda en ningún servidor: todo queda en tu navegador y en los archivos que descargas.",
    st1: "Tu tienda",
    st2: "Tu wallet",
    st3: "Revisa y descarga",
    st4: "Instala y vende",
    safeTitle: "Por qué es seguro",
    back: "Volver",
    next1: "Continuar: tu wallet",
    next2: "Continuar: revisa y descarga",
    next3: "Continuar: instala y vende",
    s1Title: "Tu tienda",
    s1Lead:
      "Dinos dónde está tu tienda y cómo se llama: es lo que verán los agentes cuando te compren.",
    s1Url: "URL pública de tu tienda",
    s1UrlPh: "https://mitienda.cl",
    s1Name: "Nombre (lo que verán los agentes)",
    s1NamePh: "Tienda Faro",
    s1Platform: "¿Dónde viven tus órdenes?",
    s1Woo: "WooCommerce (API REST)",
    s1Generic: "Otra plataforma (hook personalizado)",
    wooTitle: "Llaves REST de WooCommerce",
    wooNote:
      "Con estas llaves AgentPOS crea las órdenes en tu admin, igual que una venta normal. Pruébalas aquí para no descubrir un error a mitad de la instalación.",
    wooWhere:
      "Dónde obtenerlas: WP Admin → WooCommerce → Ajustes → Avanzado → API REST → Añadir clave (Lectura/Escritura).",
    wooBaseUrl: "URL del sitio WordPress",
    wooCk: "Consumer key",
    wooCs: "Consumer secret",
    wooCheck: "Probar conexión",
    wooChecking: "Probando...",
    wooOk: "Conexión correcta: la llave funciona y AgentPOS podrá crear órdenes en tu tienda.",
    s1Safe:
      "Tus llaves se usan una sola vez, para probar la conexión contra tu propia tienda, y terminan solo en el archivo .env que descargas en el paso 3. No se guardan ni se registran en ningún servidor nuestro.",
    s2Title: "Tu wallet",
    s2Lead:
      "Aquí llega tu plata: pagos en USDC directo a tu wallet Stellar, sin intermediarios y sin pasar por nosotros.",
    s2Addr: "Dirección pública (empieza con G)",
    s2Check: "Validar dirección",
    s2Ok: "Dirección válida. Los pagos llegarán a esta wallet.",
    s2SafeTitle: "Nunca custodiamos llaves",
    s2Safe:
      "Solo necesitamos tu dirección pública, jamás tu llave secreta. Si pegas una clave que empieza con S, este asistente la rechaza al instante y no la guarda en ninguna parte. Tu saldo queda siempre bajo tu control.",
    s3Title: "Revisa y descarga",
    s3Lead:
      "Revisa tus datos y genera tus dos archivos. Se validan con las mismas reglas que usa tu instalación: si aparecen aquí, el sidecar los acepta.",
    revStore: "Tienda",
    revName: "Nombre",
    revPlatform: "Plataforma",
    revWallet: "Wallet de pagos",
    revEmpty: "sin completar",
    s3Generate: "Generar archivos",
    s3Testnet:
      "Tu configuración parte en testnet, la red de prueba de Stellar: puedes ensayar compras completas sin dinero real. Pasar a mainnet es una decisión tuya, posterior y deliberada, nunca automática.",
    copy: "Copiar",
    copied: "Copiado",
    download: "Descargar",
    s4Title: "Instala y vende",
    s4Lead:
      "Deja los dos archivos en tu servidor, redirige estas rutas al sidecar y ejecuta los comandos. Al terminar, tu tienda ya vende a agentes: compruébalo aquí abajo.",
    s4Pending:
      "Genera tus archivos en el paso 3 y aquí verás las rutas y los comandos listos para copiar.",
    proxyTitle: "Rutas del proxy",
    proxyNote:
      "Tu dominio tiene que redirigir estas rutas al sidecar (puerto 8402). Elige tu servidor:",
    cmdTitle: "Comandos de instalación",
    cmdNote:
      "En tu servidor, en la carpeta donde dejaste los dos archivos. El escáner solo lee tu tienda, tú confirmas cada precio y nada se publica sin tu ok.",
    vTitle: "Comprueba que tu tienda ya vende a agentes",
    vNote:
      "Escribe tu dominio y comprobamos lo mismo que comprueba un agente comprador real: que tu tienda se describe sola y que el sidecar responde. No tienes que confiar en nadie, nosotros incluidos.",
    vDomain: "Tu dominio",
    vDomainPh: "mitienda.cl",
    vRun: "Verificar",
    vRunning: "Verificando...",
    vAllOk: "Tu tienda está lista: los agentes ya pueden encontrarla y comprarte.",
    vSomeFail: "Todavía falta algo. Sigue la pista de cada punto rojo.",
    vStore: "Tienda",
    vNetwork: "red",
    checkHealth: "El sidecar responde (/agentpos/health)",
    checkOpenapi: "Contrato OpenAPI (/openapi.json)",
    checkUcp: "Manifiesto UCP (/.well-known/ucp)",
    checkLlms: "llms.txt (recomendado)",
    errNetwork: "No se pudo contactar al servidor del asistente. ¿Sigue corriendo?",
    errSecretTitle:
      "Eso parece una llave SECRETA, no una dirección pública. No se guardó en ninguna parte; no la vuelvas a pegar.",
    errSecretHint:
      "Pega solo tu dirección PÚBLICA, la que empieza con G. Si alguien más pudo ver esa llave secreta, mueve tus fondos a una wallet nueva ahora.",
    errCodeLabel: "código",
    footer:
      "AgentPOS es open source (Apache-2.0). Este asistente no tiene cuentas ni base de datos; puedes cerrarlo cuando quieras.",
  },
  en: {
    brandTag: "Seller space",
    strip1: "Zero custody",
    strip2: "No order without a settled payment",
    strip3: "Flat fee for managed services, never a percentage of your sale",
    heroTitle: "Connect your store in 15 minutes",
    heroSub:
      "Your store starts accepting purchases from AI agents that pay in USDC on Stellar, and every order lands in the same admin you already use. Nothing you type here is stored on any server: it all stays in your browser and in the files you download.",
    st1: "Your store",
    st2: "Your wallet",
    st3: "Review and download",
    st4: "Install and sell",
    safeTitle: "Why this is safe",
    back: "Back",
    next1: "Continue: your wallet",
    next2: "Continue: review and download",
    next3: "Continue: install and sell",
    s1Title: "Your store",
    s1Lead: "Tell us where your store lives and what it is called: this is what agents will see when they buy from you.",
    s1Url: "Public URL of your store",
    s1UrlPh: "https://myshop.example",
    s1Name: "Name (what agents will see)",
    s1NamePh: "Faro Store",
    s1Platform: "Where do your orders live?",
    s1Woo: "WooCommerce (REST API)",
    s1Generic: "Other platform (custom hook)",
    wooTitle: "WooCommerce REST keys",
    wooNote:
      "With these keys AgentPOS creates orders in your admin, just like a regular sale. Test them here so you do not discover a mistake halfway through the install.",
    wooWhere:
      "Where to get them: WP Admin → WooCommerce → Settings → Advanced → REST API → Add key (Read/Write).",
    wooBaseUrl: "WordPress site URL",
    wooCk: "Consumer key",
    wooCs: "Consumer secret",
    wooCheck: "Test connection",
    wooChecking: "Testing...",
    wooOk: "Connection works: the key is good and AgentPOS will be able to create orders in your store.",
    s1Safe:
      "Your keys are used exactly once, to test the connection against your own store, and end up only in the .env file you download in step 3. They are never stored or logged on any server of ours.",
    s2Title: "Your wallet",
    s2Lead:
      "This is where your money arrives: USDC payments straight to your Stellar wallet, with no intermediaries and without passing through us.",
    s2Addr: "Public address (starts with G)",
    s2Check: "Validate address",
    s2Ok: "Valid address. Payments will arrive at this wallet.",
    s2SafeTitle: "We never hold your keys",
    s2Safe:
      "We only need your public address, never your secret key. If you paste a key that starts with S, this assistant refuses it instantly and stores it nowhere. Your balance stays under your control, always.",
    s3Title: "Review and download",
    s3Lead:
      "Review your details and generate your two files. They are validated with the very rules your install runs: if they show up here, the sidecar accepts them.",
    revStore: "Store",
    revName: "Name",
    revPlatform: "Platform",
    revWallet: "Payout wallet",
    revEmpty: "not set",
    s3Generate: "Generate files",
    s3Testnet:
      "Your configuration starts on testnet, Stellar's test network: you can rehearse complete purchases with no real money. Moving to mainnet is your decision, later and deliberate, never automatic.",
    copy: "Copy",
    copied: "Copied",
    download: "Download",
    s4Title: "Install and sell",
    s4Lead:
      "Put the two files on your server, forward these paths to the sidecar and run the commands. When you are done, your store already sells to agents: prove it below.",
    s4Pending: "Generate your files in step 3 and the paths and commands will appear here, ready to copy.",
    proxyTitle: "Proxy rules",
    proxyNote: "Your domain must forward these paths to the sidecar (port 8402). Pick your server:",
    cmdTitle: "Install commands",
    cmdNote:
      "On your server, in the folder holding the two files. The scanner reads only your store, you confirm every price, and nothing is published without your ok.",
    vTitle: "Prove your store already sells to agents",
    vNote:
      "Type your domain and we check exactly what a real buying agent checks: that your store describes itself and the sidecar answers. You do not have to trust anyone, us included.",
    vDomain: "Your domain",
    vDomainPh: "myshop.example",
    vRun: "Verify",
    vRunning: "Verifying...",
    vAllOk: "Your store is ready: agents can already find it and buy from you.",
    vSomeFail: "Something is still missing. Follow the hint on each red item.",
    vStore: "Store",
    vNetwork: "network",
    checkHealth: "Sidecar answers (/agentpos/health)",
    checkOpenapi: "OpenAPI contract (/openapi.json)",
    checkUcp: "UCP manifest (/.well-known/ucp)",
    checkLlms: "llms.txt (recommended)",
    errNetwork: "Could not reach the wizard server. Is it still running?",
    errSecretTitle:
      "That looks like a SECRET key, not a public address. It was not saved anywhere; do not paste it again.",
    errSecretHint:
      "Paste only your PUBLIC address, the one that starts with G. If anyone else could have seen that secret key, move your funds to a new wallet now.",
    errCodeLabel: "code",
    footer:
      "AgentPOS is open source (Apache-2.0). This assistant has no accounts and no database; close it whenever you want.",
  },
} as const;

export function buildWizardHtml(): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentPOS · Espacio del vendedor</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b1020; color: #9fb0d0; font: 15px/1.55 "Segoe UI", system-ui, sans-serif; }
  h1, h2, h3 { color: #f4f7ff; }
  .mono, pre, code { font-family: Consolas, "Cascadia Mono", ui-monospace, monospace; }

  .bar { display: flex; align-items: center; gap: 14px; padding: 14px 24px; background: #0d1428; border-bottom: 1px solid rgba(120,150,220,0.15); }
  .wordmark { font-weight: 700; letter-spacing: 0.14em; font-size: 1rem; color: #f4f7ff; }
  .wordmark .pos { color: #7aa2ff; }
  .space { color: #6d7ea6; font-size: 0.85rem; border-left: 1px solid rgba(120,150,220,0.25); padding-left: 14px; }
  .bar .lang { margin-left: auto; }
  .lang button { background: none; border: 1px solid rgba(120,150,220,0.25); color: #6d7ea6; border-radius: 8px; padding: 3px 10px; cursor: pointer; font: inherit; font-size: 0.8rem; }
  .lang button[data-on] { color: #f4f7ff; border-color: #7aa2ff; }
  .strip { display: flex; flex-wrap: wrap; gap: 4px 10px; padding: 9px 24px; background: #101a33; border-bottom: 1px solid rgba(120,150,220,0.15); color: #6d7ea6; font-size: 0.8rem; }
  .strip .it + .it::before { content: "·"; color: #7aa2ff; margin-right: 10px; }

  .wrap { max-width: 920px; margin: 0 auto; padding: 36px 20px 64px; }
  h1 { font-size: 1.7rem; margin: 0 0 8px; letter-spacing: -0.02em; }
  .sub { margin: 0 0 28px; max-width: 72ch; }

  .steps { list-style: none; display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; padding: 0; margin: 0 0 22px; }
  .steps button { width: 100%; display: flex; align-items: center; gap: 10px; background: #0d1428; border: 1px solid rgba(120,150,220,0.15); border-radius: 12px; padding: 10px 12px; color: #6d7ea6; cursor: pointer; font: inherit; font-size: 0.84rem; text-align: left; }
  .steps .n { flex: none; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 999px; border: 1px solid rgba(120,150,220,0.3); color: #9fb0d0; font-size: 0.8rem; }
  .steps button.on { border-color: #7aa2ff; color: #f4f7ff; }
  .steps button.on .n { background: #7aa2ff; border-color: #7aa2ff; color: #0b1020; font-weight: 600; }
  .steps button.done { color: #9fb0d0; }
  .steps button.done .n { background: rgba(38,208,160,0.12); border-color: rgba(38,208,160,0.5); color: #26d0a0; }
  @media (max-width: 720px) { .steps { grid-template-columns: 1fr 1fr; } }

  .card { background: #0d1428; border: 1px solid rgba(120,150,220,0.15); border-radius: 14px; padding: 22px; margin-bottom: 16px; }
  .card h2 { font-size: 1.15rem; margin: 0 0 4px; }
  .card h3 { font-size: 0.98rem; margin: 0 0 4px; }
  .lead { margin: 2px 0 14px; }
  .note { color: #6d7ea6; font-size: 0.88rem; margin: 2px 0 14px; }
  .subsec { border-top: 1px solid rgba(120,150,220,0.15); margin-top: 20px; padding-top: 18px; }

  label { display: block; color: #6d7ea6; font-size: 0.82rem; margin: 12px 0 4px; }
  input, select { width: 100%; background: #0b1020; color: #f4f7ff; border: 1px solid rgba(120,150,220,0.2); border-radius: 9px; padding: 9px 12px; font: inherit; }
  input:focus, select:focus { outline: none; border-color: #7aa2ff; }
  input.mono { font-size: 0.86rem; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 640px) { .row { grid-template-columns: 1fr; } }

  button.act { background: #7aa2ff; color: #0b1020; font-weight: 600; border: none; border-radius: 9px; padding: 9px 18px; cursor: pointer; font: inherit; margin-top: 14px; }
  button.act:hover { filter: brightness(1.08); }
  button.act:disabled { opacity: 0.5; cursor: default; }
  button.ghost { background: transparent; color: #9fb0d0; border: 1px solid rgba(120,150,220,0.25); border-radius: 8px; padding: 4px 12px; cursor: pointer; font: inherit; font-size: 0.8rem; }
  button.ghost:hover { border-color: #7aa2ff; color: #f4f7ff; }
  .nav { display: flex; justify-content: space-between; align-items: center; margin-top: 4px; }
  .nav .ghost { padding: 9px 16px; font-size: 0.88rem; }
  .nav .act { margin-top: 0; }
  .nav .spacer { flex: 1; }

  .safe { border: 1px solid rgba(38,208,160,0.25); background: rgba(38,208,160,0.06); border-radius: 10px; padding: 12px 14px; margin-top: 18px; font-size: 0.86rem; }
  .safe .safe-t { color: #26d0a0; font-weight: 600; font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px; }

  .msg { margin-top: 10px; font-size: 0.88rem; border-radius: 9px; padding: 10px 12px; display: none; }
  .msg.ok { display: block; background: rgba(38,208,160,0.08); border: 1px solid rgba(38,208,160,0.3); color: #26d0a0; }
  .msg.err { display: block; background: rgba(255,110,130,0.07); border: 1px solid rgba(255,110,130,0.3); color: #ff9b9b; }
  .msg .hint { color: #9fb0d0; margin-top: 4px; }
  .msg .ecode { color: #6d7ea6; font-size: 0.72rem; margin-top: 6px; }

  .review { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px 16px; margin: 0 0 6px; }
  @media (max-width: 640px) { .review { grid-template-columns: 1fr; } }
  .review > div { background: #101a33; border: 1px solid rgba(120,150,220,0.15); border-radius: 10px; padding: 10px 12px; }
  .review dt { color: #6d7ea6; font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.06em; }
  .review dd { margin: 3px 0 0; color: #f4f7ff; font-size: 0.88rem; overflow-wrap: anywhere; }

  .filehead { display: flex; align-items: center; gap: 8px; margin: 18px 0 6px; }
  .filehead code { font-size: 0.85rem; color: #26d0a0; margin-right: auto; }
  pre { background: #0b1020; border: 1px solid rgba(120,150,220,0.15); border-radius: 9px; padding: 12px; overflow-x: auto; font-size: 0.82rem; margin: 0; color: #9fb0d0; }

  .checks { list-style: none; margin: 16px 0 0; padding: 0; }
  .checks li { display: flex; gap: 10px; padding: 10px 0; border-top: 1px solid rgba(120,150,220,0.12); align-items: baseline; }
  .checks .dot { flex: none; width: 10px; height: 10px; border-radius: 999px; margin-top: 5px; }
  .checks .pass { background: #26d0a0; }
  .checks .fail { background: #ff6e82; }
  .checks .hint { display: block; color: #6d7ea6; font-size: 0.82rem; }
  .checks .url { display: block; color: #6d7ea6; opacity: 0.7; font-family: Consolas, "Cascadia Mono", ui-monospace, monospace; font-size: 0.75rem; }
  .storeinfo { color: #9fb0d0; font-size: 0.85rem; margin-top: 12px; }
  .foot { color: #6d7ea6; font-size: 0.8rem; margin-top: 28px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<header class="bar">
  <span class="wordmark">AGENT<span class="pos">POS</span></span>
  <span class="space" data-i18n="brandTag"></span>
  <div class="lang"><button data-lang="es" data-on>ES</button> <button data-lang="en">EN</button></div>
</header>
<div class="strip">
  <span class="it" data-i18n="strip1"></span>
  <span class="it" data-i18n="strip2"></span>
  <span class="it" data-i18n="strip3"></span>
</div>

<div class="wrap">
  <h1 data-i18n="heroTitle"></h1>
  <p class="sub" data-i18n="heroSub"></p>

  <ol class="steps">
    <li><button data-step="1" class="on"><span class="n">1</span><span data-i18n="st1"></span></button></li>
    <li><button data-step="2"><span class="n">2</span><span data-i18n="st2"></span></button></li>
    <li><button data-step="3"><span class="n">3</span><span data-i18n="st3"></span></button></li>
    <li><button data-step="4"><span class="n">4</span><span data-i18n="st4"></span></button></li>
  </ol>

  <section id="panel-1">
    <div class="card">
      <h2 data-i18n="s1Title"></h2>
      <p class="lead" data-i18n="s1Lead"></p>
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
      <div class="subsec" id="card-woo">
        <h3 data-i18n="wooTitle"></h3>
        <p class="note" data-i18n="wooNote"></p>
        <p class="note" data-i18n="wooWhere"></p>
        <label for="wooBaseUrl" data-i18n="wooBaseUrl"></label>
        <input id="wooBaseUrl" type="url" data-i18n-ph="s1UrlPh">
        <div class="row">
          <div><label for="wooCk" data-i18n="wooCk"></label>
            <input id="wooCk" class="mono" type="text" placeholder="ck_..." spellcheck="false" autocomplete="off"></div>
          <div><label for="wooCs" data-i18n="wooCs"></label>
            <input id="wooCs" class="mono" type="password" placeholder="cs_..." spellcheck="false" autocomplete="off"></div>
        </div>
        <button class="act" id="btn-woo" data-i18n="wooCheck"></button>
        <div class="msg" id="msg-woo"></div>
      </div>
      <div class="safe"><div class="safe-t" data-i18n="safeTitle"></div><span data-i18n="s1Safe"></span></div>
    </div>
    <div class="nav"><span class="spacer"></span><button class="act" data-go="2" data-i18n="next1"></button></div>
  </section>

  <section id="panel-2" hidden>
    <div class="card">
      <h2 data-i18n="s2Title"></h2>
      <p class="lead" data-i18n="s2Lead"></p>
      <label for="payTo" data-i18n="s2Addr"></label>
      <input id="payTo" class="mono" type="text" placeholder="G..." spellcheck="false" autocomplete="off">
      <button class="act" id="btn-wallet" data-i18n="s2Check"></button>
      <div class="msg" id="msg-wallet"></div>
      <div class="safe"><div class="safe-t" data-i18n="s2SafeTitle"></div><span data-i18n="s2Safe"></span></div>
    </div>
    <div class="nav"><button class="ghost" data-go="1" data-i18n="back"></button><button class="act" data-go="3" data-i18n="next2"></button></div>
  </section>

  <section id="panel-3" hidden>
    <div class="card">
      <h2 data-i18n="s3Title"></h2>
      <p class="lead" data-i18n="s3Lead"></p>
      <dl class="review">
        <div><dt data-i18n="revStore"></dt><dd id="rev-site" class="mono"></dd></div>
        <div><dt data-i18n="revName"></dt><dd id="rev-name"></dd></div>
        <div><dt data-i18n="revPlatform"></dt><dd id="rev-platform"></dd></div>
        <div><dt data-i18n="revWallet"></dt><dd id="rev-wallet" class="mono"></dd></div>
      </dl>
      <button class="act" id="btn-generate" data-i18n="s3Generate"></button>
      <div class="msg" id="msg-generate"></div>
      <div id="output" hidden>
        <div class="filehead"><code id="fn-config"></code>
          <button class="ghost" data-copy="config" data-i18n="copy"></button>
          <button class="ghost" data-dl="config" data-i18n="download"></button></div>
        <pre id="pre-config"></pre>
        <div class="filehead"><code>.env</code>
          <button class="ghost" data-copy="env" data-i18n="copy"></button>
          <button class="ghost" data-dl="env" data-i18n="download"></button></div>
        <pre id="pre-env"></pre>
      </div>
      <div class="safe"><div class="safe-t" data-i18n="safeTitle"></div><span data-i18n="s3Testnet"></span></div>
    </div>
    <div class="nav"><button class="ghost" data-go="2" data-i18n="back"></button><button class="act" data-go="4" data-i18n="next3"></button></div>
  </section>

  <section id="panel-4" hidden>
    <div class="card">
      <h2 data-i18n="s4Title"></h2>
      <p class="lead" data-i18n="s4Lead"></p>
      <p class="note" id="install-pending" data-i18n="s4Pending"></p>
      <div id="output-install" hidden>
        <h3 data-i18n="proxyTitle"></h3>
        <p class="note" data-i18n="proxyNote"></p>
        <div class="filehead"><code>nginx</code><button class="ghost" data-copy="nginx" data-i18n="copy"></button></div>
        <pre id="pre-nginx"></pre>
        <div class="filehead"><code>Caddy</code><button class="ghost" data-copy="caddy" data-i18n="copy"></button></div>
        <pre id="pre-caddy"></pre>
        <div class="subsec">
          <h3 data-i18n="cmdTitle"></h3>
          <p class="note" data-i18n="cmdNote"></p>
          <div class="filehead"><code>shell</code><button class="ghost" data-copy="commands" data-i18n="copy"></button></div>
          <pre id="pre-commands"></pre>
        </div>
      </div>
    </div>
    <div class="card">
      <h2 data-i18n="vTitle"></h2>
      <p class="lead" data-i18n="vNote"></p>
      <label for="verifyDomain" data-i18n="vDomain"></label>
      <input id="verifyDomain" type="text" data-i18n-ph="vDomainPh" spellcheck="false">
      <button class="act" id="btn-verify" data-i18n="vRun"></button>
      <div class="msg" id="msg-verify"></div>
      <div class="storeinfo" id="verify-store"></div>
      <ul class="checks" id="verify-checks"></ul>
    </div>
    <div class="nav"><button class="ghost" data-go="3" data-i18n="back"></button><span class="spacer"></span></div>
  </section>

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

// --- guided steps ---------------------------------------------------------
let current = 1;
function goStep(n) {
  current = n;
  for (let i = 1; i <= 4; i++) $("panel-" + i).hidden = i !== n;
  document.querySelectorAll(".steps [data-step]").forEach((b) => {
    const s = Number(b.dataset.step);
    b.classList.toggle("on", s === n);
    b.classList.toggle("done", s < n);
  });
  if (n === 3) renderReview();
  if (n === 4) prefillVerify();
  window.scrollTo({ top: 0 });
}
document.querySelectorAll(".steps [data-step]").forEach((b) =>
  b.addEventListener("click", () => goStep(Number(b.dataset.step))));
document.querySelectorAll("[data-go]").forEach((b) =>
  b.addEventListener("click", () => goStep(Number(b.dataset.go))));

function renderReview() {
  const empty = t("revEmpty");
  $("rev-site").textContent = $("siteUrl").value.trim() || empty;
  $("rev-name").textContent = $("displayName").value.trim() || empty;
  const platform = $("platform");
  $("rev-platform").textContent = platform.options[platform.selectedIndex].textContent;
  $("rev-wallet").textContent = $("payTo").value.trim() || empty;
}
function prefillVerify() {
  if ($("verifyDomain").value.trim() !== "") return;
  try { $("verifyDomain").value = new URL($("siteUrl").value).host; } catch { /* leave empty */ }
}

$("platform").addEventListener("change", () => {
  $("card-woo").hidden = $("platform").value !== "woocommerce";
});
$("siteUrl").addEventListener("change", () => {
  if (!$("wooBaseUrl").value) $("wooBaseUrl").value = $("siteUrl").value;
});

// --- messages: errors are guidance, the code is a footnote ---------------
function clearMsg(el) { el.className = "msg"; el.textContent = ""; }
function showOk(el, text) { el.className = "msg ok"; el.textContent = text; }
function showErr(el, error) {
  el.className = "msg err";
  el.textContent = "";
  const isSecret = error.code === "SECRET_IN_CONFIG";
  const msg = document.createElement("div");
  msg.textContent = isSecret ? t("errSecretTitle") : (error.message || t("errNetwork"));
  el.append(msg);
  const hintText = isSecret ? t("errSecretHint") : (error.hint || "");
  if (hintText) {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = hintText;
    el.append(hint);
  }
  if (error.code) {
    const code = document.createElement("div");
    code.className = "ecode mono";
    code.textContent = t("errCodeLabel") + " " + error.code;
    el.append(code);
  }
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

// --- step 1: woo probe ----------------------------------------------------
$("btn-woo").addEventListener("click", async () => {
  const btn = $("btn-woo");
  clearMsg($("msg-woo"));
  btn.disabled = true; btn.textContent = t("wooChecking");
  const r = await post("/api/validate-woo", {
    baseUrl: $("wooBaseUrl").value || $("siteUrl").value,
    consumerKey: $("wooCk").value.trim(),
    consumerSecret: $("wooCs").value.trim(),
  });
  btn.disabled = false; btn.textContent = t("wooCheck");
  if (r.ok) showOk($("msg-woo"), t("wooOk")); else showErr($("msg-woo"), r.error);
});

// --- step 3: generate -----------------------------------------------------
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
  if (!r.ok) {
    $("output").hidden = true;
    $("output-install").hidden = true;
    $("install-pending").hidden = false;
    showErr($("msg-generate"), r.error);
    return;
  }
  generated = r.body;
  $("fn-config").textContent = generated.files.config.filename;
  $("pre-config").textContent = generated.files.config.content;
  $("pre-env").textContent = generated.files.env.content;
  $("pre-nginx").textContent = generated.proxy.nginx;
  $("pre-caddy").textContent = generated.proxy.caddy;
  $("pre-commands").textContent = generated.commands.join("\\n");
  $("output").hidden = false;
  $("output-install").hidden = false;
  $("install-pending").hidden = true;
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
  b.textContent = t("copied");
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

// --- step 4: verify -------------------------------------------------------
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
  else showErr($("msg-verify"), { message: t("vSomeFail") });
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
