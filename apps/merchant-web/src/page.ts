/**
 * The installer (conecta.agentposhq.com): one self-contained HTML document, product-grade.
 *
 * Temperament (docs/DISENO.md, surface 2): transformation, momentum, achievement. The merchant
 * is turning an ordinary store into something new, so the page is built around movement:
 *  - Amber accent (`--accent`), the "switch it on" colour, over the dark brand base. One accent
 *    per surface: it is declared once as a token and every rule reads it from there.
 *  - A progress rail that fills, not four equal boxes. A finished step carries a check and a
 *    one-line summary of what it captured, and can be clicked to go back.
 *  - A before/after drawing in the header: the same store dull, then lit with agents buying.
 *    Drawn static by default; it animates only when the visitor allows motion.
 *  - Step 4 is a finish line, not a file dump: the panel key as a certificate, the two files,
 *    and the three places to go next.
 *
 * Constraints, all deliberate:
 *  - Zero external resources: no CDN, no fonts, no framework, no analytics. It works behind any
 *    CSP and leaks nothing about who views it.
 *  - Bilingual, Spanish first (copy tone: docs/onboarding.es.md; Spanish text carries its
 *    accents and uses no em dashes), with an EN toggle. No emojis anywhere.
 *  - Everything the merchant types stays in the browser. The server endpoints act on a request
 *    and forget it; the page repeats that promise in the copy because it is the product's pitch.
 *  - API-derived text goes into the DOM via textContent, never innerHTML. Errors are rendered
 *    as guidance (message plus hint), with the machine-readable code as a discreet footnote.
 */

/**
 * "https://www.mitienda.cl/tienda" plus "WooCommerce" becomes "mitienda.cl, WooCommerce": the
 * one-line summary the progress rail shows under a finished step.
 *
 * Pure and self-contained on purpose: it is unit tested here AND serialized into the page
 * script with `toString()`, so it must not reference anything outside its own body.
 */
export function summarizeStore(siteUrl: string, platformLabel: string): string {
  const raw = String(siteUrl ?? "").trim();
  if (raw === "") return "";
  const host = raw
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .replace(/^www\./i, "");
  if (host === "") return "";
  const label = String(platformLabel ?? "").trim();
  return label === "" ? host : host + ", " + label;
}

/** "GABC...WXYZ" for the rail: enough to recognize the wallet, short enough for one line. */
export function shortAddress(address: string): string {
  const value = String(address ?? "").trim();
  if (value.length <= 14) return value;
  return value.slice(0, 6) + "…" + value.slice(-4);
}

/**
 * The store address field accepts what a merchant actually types ("mitienda.cl"), and this
 * turns it into the absolute URL the config needs. Same serialization trick as above.
 */
export function normalizeStoreUrl(raw: string): string {
  const value = String(raw ?? "").trim();
  if (value === "") return "";
  if (/^https?:\/\//i.test(value)) return value;
  return "https://" + value;
}

const STRINGS = {
  es: {
    brandTag: "Instalador",
    strip1: "Cero custodia",
    strip2: "Ninguna orden sin pago liquidado",
    strip3: "Tarifa fija por servicios gestionados, jamás porcentaje de tu venta",
    heroTitle: "Enciende tu tienda en 15 minutos",
    heroSub:
      "Tu tienda pasa a aceptar compras de agentes de IA que pagan en USDC sobre Stellar, y cada orden llega al mismo admin que ya usas. Nada de lo que escribas aquí se guarda en ningún servidor: todo queda en tu navegador y en los archivos que descargas.",
    baTitle: "Tu tienda hoy y tu tienda con AgentPOS",
    baDesc:
      "A la izquierda, tu tienda apagada para los agentes: pasan cerca y no pueden comprar. A la derecha, la misma tienda encendida: tres agentes le compran y el pago en USDC entra directo a tu wallet.",
    baBefore: "tu tienda hoy",
    baAfter: "tu tienda con AgentPOS",
    progressLabel: "Tu avance",
    st1: "Tu tienda",
    st2: "Tu wallet",
    st3: "Tus archivos",
    st4: "Listo para vender",
    sumTodo: "pendiente",
    sumFiles: "dos archivos listos",
    sumCheckTodo: "por comprobar",
    sumCheckOk: "tienda comprobada",
    safeTitle: "Por qué es seguro",
    back: "Volver",
    next1: "Continuar: tu wallet",
    next2: "Continuar: tus archivos",
    next3: "Terminar: listo para vender",
    s1Title: "Tu tienda",
    s1Lead:
      "Dinos dónde está tu tienda y cómo se llama: es lo que verán los agentes cuando te compren.",
    s1Url: "La dirección de tu tienda",
    s1UrlPh: "mitienda.cl",
    s1UrlNote: "Escríbela como se la dirías a un cliente. Nosotros le agregamos el https.",
    s1Name: "El nombre que verán los agentes",
    s1NamePh: "Almacén Aromo",
    s1Platform: "¿Dónde se registran tus órdenes hoy?",
    s1Woo: "WooCommerce (API REST)",
    s1Generic: "Otra plataforma (hook propio)",
    s1WooShort: "WooCommerce",
    s1GenericShort: "hook propio",
    wooTitle: "Las llaves de tu WooCommerce",
    wooWhat:
      "Estas dos llaves le permiten a AgentPOS una sola cosa: crear la orden en tu tienda cuando un agente paga. Nada más.",
    wooHowTitle: "Cómo las obtengo",
    wooHow1: "Entra a tu WordPress como administrador.",
    wooHow2: "En el menú de la izquierda: WooCommerce, después Ajustes.",
    wooHow3: "Arriba, pestaña Avanzado, después API REST.",
    wooHow4: "Botón Añadir clave.",
    wooHow5:
      "Descripción: AgentPOS. Usuario: tu cuenta de administrador. Permisos: Lectura/escritura.",
    wooHow6: "Botón Generar clave API.",
    wooHow7:
      "Copia las dos llaves que aparecen (una empieza con ck_ y la otra con cs_) y pégalas aquí abajo. WooCommerce las muestra una sola vez.",
    wooNote:
      "Pruébalas aquí para no descubrir un error a mitad de la instalación. La prueba va contra tu propia tienda.",
    wooBaseUrl: "La dirección de tu WordPress",
    wooBaseUrlNote: "Déjala igual si tu tienda y tu WordPress viven en la misma dirección.",
    wooCk: "Clave de cliente (ck_...)",
    wooCs: "Clave secreta de cliente (cs_...)",
    wooCheck: "Probar la conexión",
    wooChecking: "Probando...",
    wooOk: "Conexión correcta: la llave funciona y AgentPOS podrá crear órdenes en tu tienda.",
    s1Safe:
      "Tus llaves se usan una sola vez, para probar la conexión contra tu propia tienda, y terminan solo en el archivo .env que descargas en el paso 3. No se guardan ni se registran en ningún servidor nuestro.",
    s2Title: "Tu wallet",
    s2Lead:
      "Aquí llega tu plata: pagos en USDC directo a tu wallet Stellar, sin intermediarios y sin pasar por nosotros.",
    s2Addr: "La dirección pública de tu wallet (empieza con G)",
    s2Check: "Validar la dirección",
    s2Ok: "Dirección válida. Los pagos llegarán a esta wallet.",
    s2SafeTitle: "Nunca custodiamos llaves",
    s2Safe:
      "Solo necesitamos tu dirección pública, jamás tu llave secreta. Si pegas una clave que empieza con S, este asistente la rechaza al instante y no la guarda en ninguna parte. Tu saldo queda siempre bajo tu control.",
    s3Title: "Revisa y genera tus archivos",
    s3Lead:
      "Revisa tus datos y genera tus dos archivos. Se validan con las mismas reglas que usa tu instalación: si aparecen aquí, AgentPOS los acepta tal cual.",
    revStore: "Tienda",
    revName: "Nombre",
    revPlatform: "Plataforma",
    revWallet: "Wallet de pagos",
    revEmpty: "sin completar",
    s3Generate: "Generar mis archivos",
    s3Testnet:
      "Tu configuración parte en testnet, la red de prueba de Stellar: puedes ensayar compras completas sin dinero real. Pasar a mainnet es una decisión tuya, posterior y deliberada, nunca automática.",
    copy: "Copiar",
    copied: "Copiado",
    download: "Descargar",
    s4Title: "Listo: tu tienda ya puede vender a agentes",
    s4Lead:
      "Esto es lo que te llevas. Guarda la llave de tu panel, deja los dos archivos en tu servidor y comprueba el resultado aquí mismo.",
    s4Pending:
      "Genera tus archivos en el paso 3 y aquí aparecen tu llave, tus dos archivos y los comandos, listos para copiar.",
    filesTitle: "Tus dos archivos",
    filesNote:
      "Van juntos, en la misma carpeta desde donde vas a ejecutar AgentPOS en tu servidor. El .env lleva tus llaves: trátalo como una contraseña y no lo subas a un repositorio.",
    installTitle: "Déjalo corriendo en tu servidor",
    proxyTitle: "Rutas del proxy",
    proxyNote:
      "Tu dominio tiene que redirigir estas rutas a AgentPOS en tu servidor (puerto 8402). Copia el bloque del servidor que uses.",
    cmdTitle: "Comandos de instalación",
    cmdNote:
      "En tu servidor, en la carpeta donde dejaste los dos archivos. El escáner solo lee tu tienda, tú confirmas cada precio y nada se publica sin tu ok.",
    tokenTitle: "La llave de tu panel",
    tokenWhat:
      "Esta es la llave que deja al panel de AgentPOS leer tus órdenes. Ya viene dentro del archivo .env que descargaste en el paso 3, en la línea MERCHANT_API_TOKEN, así que no tienes que inventar nada ni pedirla: cópiala de aquí.",
    tokenReadOnly:
      "Es de solo lectura. Con esta llave se pueden ver tus órdenes, tus comprobantes y tus reglas, y nada más: no puede mover tu dinero, ni cambiar tus precios, ni publicar artículos, ni tocar tu tienda.",
    tokenNext:
      "Siguiente paso: conecta tu tienda al panel en app.agentposhq.com con la dirección de tu tienda y esta llave.",
    tokenLost:
      "Si la pierdes no pasa nada: escribe otra llave cualquiera de 24 caracteres o más en la línea MERCHANT_API_TOKEN de tu archivo .env, reinicia AgentPOS en tu servidor y vuelve a conectar el panel con la nueva. La anterior deja de servir en ese mismo momento.",
    nextTitle: "Tus próximos tres pasos",
    nl1: "Conecta tu panel",
    nl1d: "Tus órdenes, tus pagos y tus comprobantes en un solo lugar.",
    nl2: "Mira una tienda vendiendo",
    nl2d: "La tienda demo, comprable por agentes ahora mismo.",
    nl3: "Documentación",
    nl3d: "La guía completa, el código y la licencia Apache-2.0.",
    vTitle: "Comprueba que tu tienda ya vende a agentes",
    vNote:
      "Escribe tu dominio y comprobamos lo mismo que comprueba un agente comprador real: que tu tienda se describe sola y que AgentPOS responde. No tienes que confiar en nadie, nosotros incluidos.",
    vDomain: "La dirección de tu tienda",
    vDomainPh: "mitienda.cl",
    vToken: "La llave de tu panel (opcional)",
    vTokenNote:
      "Si la pegas aquí, comprobamos también que tu panel puede leer tus órdenes con ella y que sin ella nadie puede. La usamos para esas dos consultas a tu propia tienda y no la guardamos.",
    vRun: "Comprobar",
    vRunning: "Comprobando...",
    vAllOk: "Tu tienda está lista: los agentes ya pueden encontrarla y comprarte.",
    vSomeFail: "Todavía falta algo. Sigue la pista de cada punto rojo.",
    vStore: "Tienda",
    vNetwork: "red",
    checkHealth: "AgentPOS responde en tu tienda (/agentpos/health)",
    checkOpenapi: "Contrato OpenAPI (/openapi.json)",
    checkUcp: "Manifiesto UCP (/.well-known/ucp)",
    checkLlms: "llms.txt (recomendado)",
    checkMerchantApi:
      "Tu panel lee tus órdenes con la llave, y sin la llave nadie las ve (/agentpos/api/merchant/summary)",
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
    brandTag: "Installer",
    strip1: "Zero custody",
    strip2: "No order without a settled payment",
    strip3: "Flat fee for managed services, never a percentage of your sale",
    heroTitle: "Switch your store on in 15 minutes",
    heroSub:
      "Your store starts accepting purchases from AI agents that pay in USDC on Stellar, and every order lands in the same admin you already use. Nothing you type here is stored on any server: it all stays in your browser and in the files you download.",
    baTitle: "Your store today, and your store with AgentPOS",
    baDesc:
      "On the left, your store dark to agents: they pass by and cannot buy. On the right, the same store lit up: three agents buy from it and the USDC payment lands straight in your wallet.",
    baBefore: "your store today",
    baAfter: "your store with AgentPOS",
    progressLabel: "Your progress",
    st1: "Your store",
    st2: "Your wallet",
    st3: "Your files",
    st4: "Ready to sell",
    sumTodo: "pending",
    sumFiles: "two files ready",
    sumCheckTodo: "not checked yet",
    sumCheckOk: "store checked",
    safeTitle: "Why this is safe",
    back: "Back",
    next1: "Continue: your wallet",
    next2: "Continue: your files",
    next3: "Finish: ready to sell",
    s1Title: "Your store",
    s1Lead:
      "Tell us where your store lives and what it is called: this is what agents will see when they buy from you.",
    s1Url: "Your store address",
    s1UrlPh: "myshop.example",
    s1UrlNote: "Type it the way you would tell a customer. We add the https for you.",
    s1Name: "The name agents will see",
    s1NamePh: "Aromo Store",
    s1Platform: "Where do your orders land today?",
    s1Woo: "WooCommerce (REST API)",
    s1Generic: "Another platform (your own hook)",
    s1WooShort: "WooCommerce",
    s1GenericShort: "own hook",
    wooTitle: "Your WooCommerce keys",
    wooWhat:
      "These two keys let AgentPOS do exactly one thing: create the order in your store when an agent pays. Nothing else.",
    wooHowTitle: "How do I get them",
    wooHow1: "Sign in to your WordPress as an administrator.",
    wooHow2: "In the left menu: WooCommerce, then Settings.",
    wooHow3: "At the top, the Advanced tab, then REST API.",
    wooHow4: "Click Add key.",
    wooHow5: "Description: AgentPOS. User: your admin account. Permissions: Read/Write.",
    wooHow6: "Click Generate API key.",
    wooHow7:
      "Copy the two keys it shows (one starts with ck_, the other with cs_) and paste them below. WooCommerce shows them only once.",
    wooNote:
      "Test them here so you do not discover a mistake halfway through the install. The test runs against your own store.",
    wooBaseUrl: "Your WordPress address",
    wooBaseUrlNote: "Leave it as is if your store and your WordPress share the same address.",
    wooCk: "Consumer key (ck_...)",
    wooCs: "Consumer secret (cs_...)",
    wooCheck: "Test the connection",
    wooChecking: "Testing...",
    wooOk:
      "Connection works: the key is good and AgentPOS will be able to create orders in your store.",
    s1Safe:
      "Your keys are used exactly once, to test the connection against your own store, and end up only in the .env file you download in step 3. They are never stored or logged on any server of ours.",
    s2Title: "Your wallet",
    s2Lead:
      "This is where your money arrives: USDC payments straight to your Stellar wallet, with no intermediaries and without passing through us.",
    s2Addr: "Your wallet's public address (starts with G)",
    s2Check: "Validate the address",
    s2Ok: "Valid address. Payments will arrive at this wallet.",
    s2SafeTitle: "We never hold your keys",
    s2Safe:
      "We only need your public address, never your secret key. If you paste a key that starts with S, this assistant refuses it instantly and stores it nowhere. Your balance stays under your control, always.",
    s3Title: "Review and generate your files",
    s3Lead:
      "Review your details and generate your two files. They are validated with the very rules your install runs: if they show up here, AgentPOS accepts them as they are.",
    revStore: "Store",
    revName: "Name",
    revPlatform: "Platform",
    revWallet: "Payout wallet",
    revEmpty: "not set",
    s3Generate: "Generate my files",
    s3Testnet:
      "Your configuration starts on testnet, Stellar's test network: you can rehearse complete purchases with no real money. Moving to mainnet is your decision, later and deliberate, never automatic.",
    copy: "Copy",
    copied: "Copied",
    download: "Download",
    s4Title: "Done: your store can sell to agents",
    s4Lead:
      "This is what you take with you. Keep your panel key, put the two files on your server, and prove the result right here.",
    s4Pending:
      "Generate your files in step 3 and your key, your two files and the commands appear here, ready to copy.",
    filesTitle: "Your two files",
    filesNote:
      "They travel together, in the same folder you will run AgentPOS from on your server. The .env holds your keys: treat it like a password and never push it to a repository.",
    installTitle: "Leave it running on your server",
    proxyTitle: "Proxy rules",
    proxyNote:
      "Your domain must forward these paths to AgentPOS on your server (port 8402). Copy the block for the server you run.",
    cmdTitle: "Install commands",
    cmdNote:
      "On your server, in the folder holding the two files. The scanner reads only your store, you confirm every price, and nothing is published without your ok.",
    tokenTitle: "Your panel key",
    tokenWhat:
      "This is the key that lets the AgentPOS panel read your orders. It is already inside the .env file you downloaded in step 3, on the MERCHANT_API_TOKEN line, so there is nothing to invent and nobody to ask: copy it from here.",
    tokenReadOnly:
      "It is read only. With this key your orders, your receipts and your rules can be read, and nothing else: it cannot move your money, change your prices, publish items or touch your store.",
    tokenNext:
      "Next step: connect your store to the panel at app.agentposhq.com with your store address and this key.",
    tokenLost:
      "If you lose it, no harm done: write any other key of 24 characters or more on the MERCHANT_API_TOKEN line of your .env file, restart AgentPOS on your server, and connect the panel again with the new one. The old one stops working right then.",
    nextTitle: "Your next three steps",
    nl1: "Connect your panel",
    nl1d: "Your orders, your payments and your receipts in one place.",
    nl2: "See a store selling",
    nl2d: "The demo store, buyable by agents right now.",
    nl3: "Documentation",
    nl3d: "The full guide, the code and the Apache-2.0 licence.",
    vTitle: "Prove your store already sells to agents",
    vNote:
      "Type your domain and we check exactly what a real buying agent checks: that your store describes itself and that AgentPOS answers. You do not have to trust anyone, us included.",
    vDomain: "Your store address",
    vDomainPh: "myshop.example",
    vToken: "Your panel key (optional)",
    vTokenNote:
      "Paste it here and we also check that your panel can read your orders with it, and that without it nobody can. We use it for those two calls to your own store and keep no copy.",
    vRun: "Check",
    vRunning: "Checking...",
    vAllOk: "Your store is ready: agents can already find it and buy from you.",
    vSomeFail: "Something is still missing. Follow the hint on each red item.",
    vStore: "Store",
    vNetwork: "network",
    checkHealth: "AgentPOS answers on your store (/agentpos/health)",
    checkOpenapi: "OpenAPI contract (/openapi.json)",
    checkUcp: "UCP manifest (/.well-known/ucp)",
    checkLlms: "llms.txt (recommended)",
    checkMerchantApi:
      "Your panel reads your orders with the key, and without the key nobody does (/agentpos/api/merchant/summary)",
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

/** Where the finish line sends the merchant next. Real, already published addresses. */
const NEXT_LINKS = {
  panel: "https://app.agentposhq.com",
  demo: "https://demo.agentposhq.com",
  docs: "https://github.com/NovaCorpAI/agentpos",
} as const;

export function buildWizardHtml(): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentPOS · Instalador</title>
<style>
  /* One accent per surface (docs/DISENO.md). Amber is declared here, once, and every rule
     below reads it from the token: no accent literal is scattered through the stylesheet. */
  :root {
    color-scheme: dark;
    --accent: #f2a33c;
    --accent-ink: #0b1020;
    --accent-soft: color-mix(in srgb, var(--accent) 12%, transparent);
    --accent-faint: color-mix(in srgb, var(--accent) 7%, transparent);
    --accent-line: color-mix(in srgb, var(--accent) 45%, transparent);
    --accent-dim: color-mix(in srgb, var(--accent) 24%, transparent);
    --bg: #0b1020;
    --surface: #0d1428;
    --surface-2: #101a33;
    --ink: #f4f7ff;
    --ink-dim: #9fb0d0;
    --ink-mute: #6d7ea6;
    --line: rgba(120,150,220,0.16);
    --line-strong: rgba(120,150,220,0.3);
    --ok: #26d0a0;
    --ok-soft: rgba(38,208,160,0.08);
    --ok-line: rgba(38,208,160,0.32);
    --danger: #ff6e82;
    --danger-ink: #ff9b9b;
    --danger-soft: rgba(255,110,130,0.07);
    --danger-line: rgba(255,110,130,0.3);
    --r-card: 10px;
    --r-ctl: 6px;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink-dim); font: 15px/1.55 "Segoe UI", system-ui, sans-serif; }
  h1, h2, h3 { color: var(--ink); }
  .mono, pre, code { font-family: Consolas, "Cascadia Mono", ui-monospace, monospace; }
  a { color: var(--accent); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }

  .bar { display: flex; align-items: center; gap: 14px; padding: 14px 24px; background: var(--surface); border-bottom: 1px solid var(--line); }
  .wordmark { font-weight: 700; letter-spacing: 0.14em; font-size: 1rem; color: var(--ink); }
  .wordmark .pos { color: var(--accent); }
  .space { color: var(--ink-mute); font-size: 0.85rem; border-left: 1px solid var(--line-strong); padding-left: 14px; }
  .bar .lang { margin-left: auto; display: flex; gap: 6px; }
  .lang button { background: none; border: 1px solid var(--line-strong); color: var(--ink-mute); border-radius: var(--r-ctl); padding: 6px 12px; cursor: pointer; font: inherit; font-size: 0.8rem; }
  .lang button[data-on] { color: var(--ink); border-color: var(--accent); }
  .strip { display: flex; flex-wrap: wrap; gap: 4px 10px; padding: 9px 24px; background: var(--surface-2); border-bottom: 1px solid var(--line); color: var(--ink-mute); font-size: 0.8rem; }
  .strip .it + .it::before { content: "·"; color: var(--accent); margin-right: 10px; }

  .wrap { max-width: 980px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 1.8rem; margin: 0 0 10px; letter-spacing: -0.02em; }
  .sub { margin: 0; max-width: 60ch; }

  /* --- before / after ---------------------------------------------------- */
  .hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 28px; align-items: center; margin-bottom: 30px; }
  @media (max-width: 860px) { .hero { grid-template-columns: 1fr; gap: 20px; } }
  .ba { margin: 0; }
  .ba svg { display: block; width: 100%; height: auto; }
  .ba-off { color: var(--ink-mute); opacity: 0.55; }
  .ba-on { color: var(--accent); }
  .ba-node { fill: none; stroke: currentColor; stroke-width: 2; }
  .ba-node-off { stroke-dasharray: 4 4; }
  .ba-fill-accent { fill: var(--accent); }
  .ba-flow { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linecap: round; }
  .ba-tag { fill: var(--accent); font: 600 12px "Segoe UI", system-ui, sans-serif; letter-spacing: 0.08em; }
  .ba-mid { fill: var(--ink-mute); font: 600 11px "Segoe UI", system-ui, sans-serif; letter-spacing: 0.14em; }
  .ba-caps { display: flex; justify-content: space-between; gap: 12px; color: var(--ink-mute); font-size: 0.78rem; letter-spacing: 0.04em; margin-top: 2px; }
  .ba-caps span:last-child { color: var(--accent); }
  /* Static by default, so a visitor who asked for no motion simply gets the finished drawing. */
  @media (prefers-reduced-motion: no-preference) {
    .ba-on { opacity: 0; animation: ba-lit 700ms ease-out 420ms forwards; }
    .ba-flow { stroke-dasharray: 120; stroke-dashoffset: 120; animation: ba-draw 620ms ease-out forwards; }
    .ba-flow.d0 { animation-delay: 60ms; }
    .ba-flow.d1 { animation-delay: 780ms; }
    .ba-flow.d2 { animation-delay: 940ms; }
    .ba-flow.d3 { animation-delay: 1100ms; }
  }
  @keyframes ba-draw { to { stroke-dashoffset: 0; } }
  @keyframes ba-lit { from { opacity: 0; } to { opacity: 1; } }

  /* --- the rail: a line that fills, not four equal boxes ------------------ */
  .rail { position: relative; margin: 0 0 24px; }
  .rail .track { position: absolute; left: 12.5%; right: 12.5%; top: 25px; height: 2px; background: var(--line-strong); border-radius: 2px; }
  .rail .fill { display: block; height: 100%; width: var(--fill, 0%); background: var(--accent); border-radius: 2px; transition: width 320ms ease; }
  .rail ol { list-style: none; display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; margin: 0; padding: 0; }
  .rail button { position: relative; width: 100%; min-height: 44px; display: flex; flex-direction: column; align-items: center; gap: 8px; background: none; border: none; padding: 6px 6px 4px; color: var(--ink-mute); cursor: pointer; font: inherit; text-align: center; }
  .rail .mark { flex: none; position: relative; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 999px; background: var(--bg); border: 2px solid var(--line-strong); color: var(--ink-dim); font-size: 0.84rem; }
  .rail .tick { display: none; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
  .rail .nm { display: block; font-size: 0.86rem; }
  .rail .sum { display: block; font-size: 0.75rem; color: var(--ink-mute); opacity: 0.85; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rail .done .mark { border-color: var(--ok); color: var(--ok); background: var(--bg); }
  .rail .done .num { display: none; }
  .rail .done .tick { display: block; }
  .rail .done .nm { color: var(--ink-dim); }
  .rail .done .sum { color: var(--ok); opacity: 1; }
  /* The current step dominates: bigger marker, amber ring, brighter label. */
  .rail .on .mark { width: 40px; height: 40px; border-color: var(--accent); background: var(--accent); color: var(--accent-ink); font-weight: 700; font-size: 0.95rem; box-shadow: 0 0 0 6px var(--accent-faint); }
  .rail .on .nm { color: var(--ink); font-weight: 600; font-size: 0.95rem; }
  .rail .on .sum { color: var(--accent); opacity: 1; }
  .rail button:hover .nm { color: var(--ink); }
  @media (max-width: 720px) {
    .rail .track { display: none; }
    .rail ol { grid-template-columns: 1fr; }
    .rail li { position: relative; }
    .rail li + li::before { content: ""; position: absolute; left: 25px; top: -6px; width: 2px; height: 12px; background: var(--line-strong); }
    .rail li + li.filled::before { background: var(--accent); }
    .rail button { flex-direction: row; align-items: center; gap: 12px; text-align: left; padding: 6px 4px; }
    .rail .txt { min-width: 0; }
    .rail .on .mark { width: 34px; height: 34px; font-size: 0.86rem; box-shadow: none; }
  }
  @media (prefers-reduced-motion: reduce) { .rail .fill { transition: none; } }

  /* --- cards and forms ---------------------------------------------------- */
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); padding: 22px; margin-bottom: 16px; }
  .card.lead-card { border-color: var(--accent-line); box-shadow: inset 3px 0 0 var(--accent); }
  .card h2 { font-size: 1.15rem; margin: 0 0 4px; }
  .card h3 { font-size: 0.98rem; margin: 0 0 4px; }
  .lead { margin: 2px 0 14px; }
  .note { color: var(--ink-mute); font-size: 0.88rem; margin: 2px 0 14px; }
  .note.tight { margin: 4px 0 0; }
  .subsec { border-top: 1px solid var(--line); margin-top: 20px; padding-top: 18px; }

  label { display: block; color: var(--ink-mute); font-size: 0.82rem; margin: 14px 0 4px; }
  input, select { width: 100%; min-height: 44px; background: var(--bg); color: var(--ink); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); padding: 10px 12px; font: inherit; }
  input::placeholder { color: var(--ink-mute); opacity: 0.6; }
  input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-faint); }
  input.mono { font-size: 0.86rem; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 640px) { .row { grid-template-columns: 1fr; } }

  button.act { background: var(--accent); color: var(--accent-ink); font-weight: 600; border: none; border-radius: var(--r-ctl); padding: 11px 20px; min-height: 44px; cursor: pointer; font: inherit; margin-top: 16px; }
  button.act:hover { filter: brightness(1.08); }
  button.act:disabled { opacity: 0.5; cursor: default; }
  button.ghost { background: transparent; color: var(--ink-dim); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); padding: 6px 12px; min-height: 36px; cursor: pointer; font: inherit; font-size: 0.8rem; }
  button.ghost:hover { border-color: var(--accent); color: var(--ink); }
  .nav { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 4px; }
  .nav .ghost { padding: 10px 16px; min-height: 44px; font-size: 0.88rem; }
  .nav .act { margin-top: 0; }
  .nav .spacer { flex: 1; }

  details.how { border: 1px solid var(--line); border-radius: var(--r-ctl); background: var(--surface-2); padding: 0 14px; margin: 12px 0 4px; }
  details.how > summary { cursor: pointer; padding: 11px 0; color: var(--accent); font-size: 0.88rem; font-weight: 600; list-style-position: inside; }
  details.how[open] > summary { border-bottom: 1px solid var(--line); }
  details.how ol { margin: 12px 0 14px; padding-left: 20px; color: var(--ink-dim); font-size: 0.88rem; }
  details.how li { margin-bottom: 6px; }

  .safe { border: 1px solid var(--ok-line); background: var(--ok-soft); border-radius: var(--r-ctl); padding: 12px 14px; margin-top: 18px; font-size: 0.86rem; }
  .safe .safe-t { color: var(--ok); font-weight: 600; font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px; }

  .msg { margin-top: 10px; font-size: 0.88rem; border-radius: var(--r-ctl); padding: 10px 12px; display: none; }
  .msg.ok { display: block; background: var(--ok-soft); border: 1px solid var(--ok-line); color: var(--ok); }
  .msg.err { display: block; background: var(--danger-soft); border: 1px solid var(--danger-line); color: var(--danger-ink); }
  .msg .hint { color: var(--ink-dim); margin-top: 4px; }
  .msg .ecode { color: var(--ink-mute); font-size: 0.72rem; margin-top: 6px; }

  .review { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px 16px; margin: 0 0 6px; }
  @media (max-width: 640px) { .review { grid-template-columns: 1fr; } }
  .review > div { background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-ctl); padding: 10px 12px; }
  .review dt { color: var(--ink-mute); font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.06em; }
  .review dd { margin: 3px 0 0; color: var(--ink); font-size: 0.88rem; overflow-wrap: anywhere; }

  .filehead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 18px 0 6px; }
  .filehead code { font-size: 0.85rem; color: var(--ok); margin-right: auto; }
  pre { background: var(--bg); border: 1px solid var(--line); border-radius: var(--r-ctl); padding: 12px; overflow-x: auto; font-size: 0.82rem; margin: 0; color: var(--ink-dim); }

  /* --- the finish line ---------------------------------------------------- */
  .finish h2 { font-size: 1.45rem; letter-spacing: -0.02em; line-height: 1.25; }
  .cert { border: 1px solid var(--accent-line); background: var(--accent-faint); border-radius: var(--r-card); padding: 16px; margin: 18px 0 6px; }
  .cert-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .cert-t { color: var(--accent); font-weight: 600; font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.1em; margin-right: auto; }
  .cert pre { background: var(--bg); border: 1px solid var(--accent-dim); color: var(--ink); font-size: 0.88rem; margin-top: 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .cert .note { margin: 10px 0 0; }
  .takes { display: grid; gap: 10px; margin-top: 12px; }
  .take { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-ctl); padding: 10px 12px; }
  .take code { color: var(--ok); font-size: 0.86rem; margin-right: auto; }
  .nextlinks { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 12px; }
  @media (max-width: 720px) { .nextlinks { grid-template-columns: 1fr; } }
  .nl { display: block; text-decoration: none; background: var(--surface-2); border: 1px solid var(--line); border-left: 2px solid var(--accent); border-radius: var(--r-ctl); padding: 12px 14px; }
  .nl:hover { border-color: var(--accent-line); border-left-color: var(--accent); }
  .nl-t { display: block; color: var(--ink); font-weight: 600; font-size: 0.92rem; }
  .nl-d { display: block; color: var(--ink-mute); font-size: 0.8rem; margin-top: 3px; }

  .checks { list-style: none; margin: 16px 0 0; padding: 0; }
  .checks li { display: flex; gap: 10px; padding: 10px 0; border-top: 1px solid var(--line); align-items: baseline; }
  .checks .dot { flex: none; width: 10px; height: 10px; border-radius: 999px; margin-top: 5px; }
  .checks .pass { background: var(--ok); }
  .checks .fail { background: var(--danger); }
  .checks .hint { display: block; color: var(--ink-mute); font-size: 0.82rem; }
  .checks .url { display: block; color: var(--ink-mute); opacity: 0.7; font-family: Consolas, "Cascadia Mono", ui-monospace, monospace; font-size: 0.75rem; }
  .nextstep { border-left: 2px solid var(--accent); padding-left: 12px; color: var(--ink); font-size: 0.92rem; margin: 16px 0 10px; }
  .storeinfo { color: var(--ink-dim); font-size: 0.85rem; margin-top: 12px; }
  .foot { color: var(--ink-mute); font-size: 0.8rem; margin-top: 28px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<header class="bar">
  <span class="wordmark">AGENT<span class="pos">POS</span></span>
  <span class="space" data-i18n="brandTag"></span>
  <div class="lang"><button data-lang="es" data-on>ES</button><button data-lang="en">EN</button></div>
</header>
<div class="strip">
  <span class="it" data-i18n="strip1"></span>
  <span class="it" data-i18n="strip2"></span>
  <span class="it" data-i18n="strip3"></span>
</div>

<div class="wrap">
  <div class="hero">
    <div>
      <h1 data-i18n="heroTitle"></h1>
      <p class="sub" data-i18n="heroSub"></p>
    </div>
    <figure class="ba">
      <svg viewBox="0 0 680 200" role="img" aria-labelledby="ba-title ba-desc">
        <title id="ba-title" data-i18n="baTitle"></title>
        <desc id="ba-desc" data-i18n="baDesc"></desc>
        <defs>
          <g id="ba-store" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round">
            <path d="M0 30 L82 4 L164 30"></path>
            <rect x="10" y="30" width="144" height="92" rx="5"></rect>
            <rect x="66" y="76" width="32" height="46" rx="3" stroke-width="2"></rect>
            <rect x="24" y="48" width="30" height="22" rx="3" stroke-width="2"></rect>
            <rect x="110" y="48" width="30" height="22" rx="3" stroke-width="2"></rect>
          </g>
          <g id="ba-agent">
            <rect class="ba-node" x="0" y="0" width="38" height="28" rx="9"></rect>
            <circle class="ba-node" cx="11" cy="14" r="3.2"></circle>
            <path class="ba-node" d="M20 14 H29"></path>
          </g>
          <marker id="ba-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path class="ba-fill-accent" d="M0 0 L10 5 L0 10 Z"></path>
          </marker>
        </defs>

        <g class="ba-off">
          <use href="#ba-store" x="24" y="34"></use>
          <g class="ba-node-off">
            <use href="#ba-agent" x="222" y="30"></use>
            <use href="#ba-agent" x="222" y="82"></use>
            <use href="#ba-agent" x="222" y="134"></use>
          </g>
        </g>

        <text class="ba-mid" x="340" y="88" text-anchor="middle">AGENTPOS</text>
        <path class="ba-flow d0" d="M306 104 H374" marker-end="url(#ba-head)"></path>

        <g class="ba-on">
          <use href="#ba-store" x="396" y="34"></use>
          <rect x="424" y="0" width="64" height="22" rx="11" fill="none" stroke="currentColor" stroke-width="1.6"></rect>
          <text class="ba-tag" x="456" y="15" text-anchor="middle">USDC</text>
          <use href="#ba-agent" x="600" y="30"></use>
          <use href="#ba-agent" x="600" y="82"></use>
          <use href="#ba-agent" x="600" y="134"></use>
          <path class="ba-flow d1" d="M596 44 C 570 44, 580 74, 566 80"></path>
          <path class="ba-flow d2" d="M596 96 H 566"></path>
          <path class="ba-flow d3" d="M596 148 C 570 148, 580 118, 566 112"></path>
        </g>
      </svg>
      <figcaption class="ba-caps">
        <span data-i18n="baBefore"></span>
        <span data-i18n="baAfter"></span>
      </figcaption>
    </figure>
  </div>

  <nav class="rail" id="rail" aria-label="Tu avance">
    <div class="track"><span class="fill" id="rail-fill"></span></div>
    <ol>
      <li><button data-step="1" class="on" aria-current="step">
        <span class="mark"><span class="num">1</span><svg class="tick" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.4 L6.4 11.8 L13 4.6"></path></svg></span>
        <span class="txt"><span class="nm" data-i18n="st1"></span><span class="sum" data-sum="1"></span></span>
      </button></li>
      <li><button data-step="2">
        <span class="mark"><span class="num">2</span><svg class="tick" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.4 L6.4 11.8 L13 4.6"></path></svg></span>
        <span class="txt"><span class="nm" data-i18n="st2"></span><span class="sum" data-sum="2"></span></span>
      </button></li>
      <li><button data-step="3">
        <span class="mark"><span class="num">3</span><svg class="tick" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.4 L6.4 11.8 L13 4.6"></path></svg></span>
        <span class="txt"><span class="nm" data-i18n="st3"></span><span class="sum" data-sum="3"></span></span>
      </button></li>
      <li><button data-step="4">
        <span class="mark"><span class="num">4</span><svg class="tick" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.4 L6.4 11.8 L13 4.6"></path></svg></span>
        <span class="txt"><span class="nm" data-i18n="st4"></span><span class="sum" data-sum="4"></span></span>
      </button></li>
    </ol>
  </nav>

  <section id="panel-1">
    <div class="card lead-card">
      <h2 data-i18n="s1Title"></h2>
      <p class="lead" data-i18n="s1Lead"></p>
      <div class="row">
        <div><label for="siteUrl" data-i18n="s1Url"></label>
          <input id="siteUrl" type="text" inputmode="url" data-i18n-ph="s1UrlPh" autocomplete="url" spellcheck="false" aria-describedby="siteUrl-note">
          <p class="note tight" id="siteUrl-note" data-i18n="s1UrlNote"></p></div>
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
        <p class="note" data-i18n="wooWhat"></p>
        <details class="how">
          <summary data-i18n="wooHowTitle"></summary>
          <ol>
            <li data-i18n="wooHow1"></li>
            <li data-i18n="wooHow2"></li>
            <li data-i18n="wooHow3"></li>
            <li data-i18n="wooHow4"></li>
            <li data-i18n="wooHow5"></li>
            <li data-i18n="wooHow6"></li>
            <li data-i18n="wooHow7"></li>
          </ol>
        </details>
        <label for="wooBaseUrl" data-i18n="wooBaseUrl"></label>
        <input id="wooBaseUrl" type="text" inputmode="url" data-i18n-ph="s1UrlPh" spellcheck="false" aria-describedby="wooBaseUrl-note">
        <p class="note tight" id="wooBaseUrl-note" data-i18n="wooBaseUrlNote"></p>
        <div class="row">
          <div><label for="wooCk" data-i18n="wooCk"></label>
            <input id="wooCk" class="mono" type="text" placeholder="ck_..." spellcheck="false" autocomplete="off"></div>
          <div><label for="wooCs" data-i18n="wooCs"></label>
            <input id="wooCs" class="mono" type="password" placeholder="cs_..." spellcheck="false" autocomplete="off"></div>
        </div>
        <p class="note tight" data-i18n="wooNote"></p>
        <button class="act" id="btn-woo" data-i18n="wooCheck"></button>
        <div class="msg" id="msg-woo" role="status"></div>
      </div>
      <div class="safe"><div class="safe-t" data-i18n="safeTitle"></div><span data-i18n="s1Safe"></span></div>
    </div>
    <div class="nav"><span class="spacer"></span><button class="act" data-go="2" data-i18n="next1"></button></div>
  </section>

  <section id="panel-2" hidden>
    <div class="card lead-card">
      <h2 data-i18n="s2Title"></h2>
      <p class="lead" data-i18n="s2Lead"></p>
      <label for="payTo" data-i18n="s2Addr"></label>
      <input id="payTo" class="mono" type="text" placeholder="G..." spellcheck="false" autocomplete="off">
      <button class="act" id="btn-wallet" data-i18n="s2Check"></button>
      <div class="msg" id="msg-wallet" role="status"></div>
      <div class="safe"><div class="safe-t" data-i18n="s2SafeTitle"></div><span data-i18n="s2Safe"></span></div>
    </div>
    <div class="nav"><button class="ghost" data-go="1" data-i18n="back"></button><button class="act" data-go="3" data-i18n="next2"></button></div>
  </section>

  <section id="panel-3" hidden>
    <div class="card lead-card">
      <h2 data-i18n="s3Title"></h2>
      <p class="lead" data-i18n="s3Lead"></p>
      <dl class="review">
        <div><dt data-i18n="revStore"></dt><dd id="rev-site" class="mono"></dd></div>
        <div><dt data-i18n="revName"></dt><dd id="rev-name"></dd></div>
        <div><dt data-i18n="revPlatform"></dt><dd id="rev-platform"></dd></div>
        <div><dt data-i18n="revWallet"></dt><dd id="rev-wallet" class="mono"></dd></div>
      </dl>
      <button class="act" id="btn-generate" data-i18n="s3Generate"></button>
      <div class="msg" id="msg-generate" role="status"></div>
      <div id="output" hidden>
        <div class="filehead"><code class="fn-config"></code>
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
    <div class="card lead-card finish">
      <h2 data-i18n="s4Title"></h2>
      <p class="lead" data-i18n="s4Lead"></p>
      <p class="note" id="install-pending" data-i18n="s4Pending"></p>
      <div id="output-finish" hidden>
        <div class="cert">
          <div class="cert-head">
            <span class="cert-t" data-i18n="tokenTitle"></span>
            <button class="ghost" data-copy="token" data-i18n="copy"></button>
          </div>
          <pre id="pre-token"></pre>
          <p class="note" data-i18n="tokenReadOnly"></p>
        </div>
        <p class="note" data-i18n="tokenWhat"></p>
        <p class="nextstep" data-i18n="tokenNext"></p>
        <p class="note" data-i18n="tokenLost"></p>

        <div class="subsec">
          <h3 data-i18n="filesTitle"></h3>
          <p class="note" data-i18n="filesNote"></p>
          <div class="takes">
            <div class="take"><code class="fn-config"></code>
              <button class="ghost" data-copy="config" data-i18n="copy"></button>
              <button class="ghost" data-dl="config" data-i18n="download"></button></div>
            <div class="take"><code>.env</code>
              <button class="ghost" data-copy="env" data-i18n="copy"></button>
              <button class="ghost" data-dl="env" data-i18n="download"></button></div>
          </div>
        </div>

        <div class="subsec">
          <h3 data-i18n="nextTitle"></h3>
          <div class="nextlinks">
            <a class="nl" href="${NEXT_LINKS.panel}" target="_blank" rel="noopener noreferrer">
              <span class="nl-t" data-i18n="nl1"></span><span class="nl-d" data-i18n="nl1d"></span></a>
            <a class="nl" href="${NEXT_LINKS.demo}" target="_blank" rel="noopener noreferrer">
              <span class="nl-t" data-i18n="nl2"></span><span class="nl-d" data-i18n="nl2d"></span></a>
            <a class="nl" href="${NEXT_LINKS.docs}" target="_blank" rel="noopener noreferrer">
              <span class="nl-t" data-i18n="nl3"></span><span class="nl-d" data-i18n="nl3d"></span></a>
          </div>
        </div>
      </div>
    </div>

    <div class="card" id="card-install" hidden>
      <h2 data-i18n="installTitle"></h2>
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

    <div class="card">
      <h2 data-i18n="vTitle"></h2>
      <p class="lead" data-i18n="vNote"></p>
      <label for="verifyDomain" data-i18n="vDomain"></label>
      <input id="verifyDomain" type="text" inputmode="url" data-i18n-ph="vDomainPh" spellcheck="false">
      <label for="verifyToken" data-i18n="vToken"></label>
      <input id="verifyToken" class="mono" type="text" spellcheck="false" autocomplete="off" aria-describedby="verifyToken-note">
      <p class="note tight" id="verifyToken-note" data-i18n="vTokenNote"></p>
      <button class="act" id="btn-verify" data-i18n="vRun"></button>
      <div class="msg" id="msg-verify" role="status"></div>
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

// Shared with the server module, serialized here so the rail and the page agree on every
// summary line without shipping a framework or duplicating the logic by hand.
${summarizeStore.toString()}
${shortAddress.toString()}
${normalizeStoreUrl.toString()}

function setLang(next) {
  lang = next;
  document.documentElement.lang = next;
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll(".lang button").forEach((b) => {
    if (b.dataset.lang === next) b.setAttribute("data-on", ""); else b.removeAttribute("data-on");
  });
  $("rail").setAttribute("aria-label", t("progressLabel"));
  refreshRail();
}
document.querySelectorAll(".lang button").forEach((b) =>
  b.addEventListener("click", () => setLang(b.dataset.lang)));

// --- the rail: progress that fills, with what each step captured ----------
let current = 1;
let generated = null;
let verifiedOk = false;

function platformLabel() {
  return $("platform").value === "woocommerce" ? t("s1WooShort") : t("s1GenericShort");
}
function summaryFor(step) {
  if (step === 1) return summarizeStore($("siteUrl").value, platformLabel());
  if (step === 2) return shortAddress($("payTo").value);
  if (step === 3) return generated ? t("sumFiles") : "";
  return verifiedOk ? t("sumCheckOk") : "";
}
function refreshRail() {
  const fill = ((current - 1) / 3) * 100;
  $("rail-fill").parentElement.style.setProperty("--fill", fill + "%");
  document.querySelectorAll(".rail [data-step]").forEach((b) => {
    const s = Number(b.dataset.step);
    // A step is "done" only when it actually captured something: a check mark next to an
    // empty summary would be a lie the merchant can see.
    const summary = summaryFor(s);
    b.classList.toggle("on", s === current);
    b.classList.toggle("done", summary !== "" && s !== current);
    if (s === current) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current");
    if (b.parentElement) b.parentElement.classList.toggle("filled", s <= current);
    const sum = b.querySelector("[data-sum]");
    const pending = s === 4 ? t("sumCheckTodo") : t("sumTodo");
    sum.textContent = summary || pending;
  });
}

function goStep(n) {
  current = n;
  for (let i = 1; i <= 4; i++) $("panel-" + i).hidden = i !== n;
  if (n === 3) renderReview();
  if (n === 4) prefillVerify();
  refreshRail();
  window.scrollTo({ top: 0 });
}
document.querySelectorAll(".rail [data-step]").forEach((b) =>
  b.addEventListener("click", () => goStep(Number(b.dataset.step))));
document.querySelectorAll("[data-go]").forEach((b) =>
  b.addEventListener("click", () => goStep(Number(b.dataset.go))));

function renderReview() {
  const empty = t("revEmpty");
  $("rev-site").textContent = normalizeStoreUrl($("siteUrl").value) || empty;
  $("rev-name").textContent = $("displayName").value.trim() || empty;
  const platform = $("platform");
  $("rev-platform").textContent = platform.options[platform.selectedIndex].textContent;
  $("rev-wallet").textContent = $("payTo").value.trim() || empty;
}
function prefillVerify() {
  // The key never leaves the browser except in the verification call the merchant triggers.
  if (generated && $("verifyToken").value.trim() === "") {
    $("verifyToken").value = generated.merchantApiToken;
  }
  if ($("verifyDomain").value.trim() !== "") return;
  try { $("verifyDomain").value = new URL(normalizeStoreUrl($("siteUrl").value)).host; }
  catch { /* leave empty */ }
}

$("platform").addEventListener("change", () => {
  $("card-woo").hidden = $("platform").value !== "woocommerce";
  refreshRail();
});
$("siteUrl").addEventListener("change", () => {
  $("siteUrl").value = normalizeStoreUrl($("siteUrl").value);
  if (!$("wooBaseUrl").value) $("wooBaseUrl").value = $("siteUrl").value;
  refreshRail();
});
$("wooBaseUrl").addEventListener("change", () => {
  $("wooBaseUrl").value = normalizeStoreUrl($("wooBaseUrl").value);
});
$("payTo").addEventListener("input", refreshRail);

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
    baseUrl: normalizeStoreUrl($("wooBaseUrl").value || $("siteUrl").value),
    consumerKey: $("wooCk").value.trim(),
    consumerSecret: $("wooCs").value.trim(),
  });
  btn.disabled = false; btn.textContent = t("wooCheck");
  if (r.ok) showOk($("msg-woo"), t("wooOk")); else showErr($("msg-woo"), r.error);
});

// --- step 3: generate -----------------------------------------------------
$("btn-generate").addEventListener("click", async () => {
  clearMsg($("msg-generate"));
  const platform = $("platform").value;
  const payload = {
    siteUrl: normalizeStoreUrl($("siteUrl").value),
    displayName: $("displayName").value.trim(),
    payTo: $("payTo").value.trim(),
    platform: platform,
  };
  if (platform === "woocommerce") {
    const wooBase = normalizeStoreUrl($("wooBaseUrl").value);
    if (wooBase) payload.wooBaseUrl = wooBase;
    if ($("wooCk").value.trim()) payload.wooConsumerKey = $("wooCk").value.trim();
    if ($("wooCs").value.trim()) payload.wooConsumerSecret = $("wooCs").value.trim();
  }
  const r = await post("/api/generate", payload);
  if (!r.ok) {
    generated = null;
    $("output").hidden = true;
    $("output-finish").hidden = true;
    $("card-install").hidden = true;
    $("install-pending").hidden = false;
    showErr($("msg-generate"), r.error);
    refreshRail();
    return;
  }
  generated = r.body;
  document.querySelectorAll(".fn-config").forEach((el) => {
    el.textContent = generated.files.config.filename;
  });
  $("pre-config").textContent = generated.files.config.content;
  $("pre-env").textContent = generated.files.env.content;
  $("pre-nginx").textContent = generated.proxy.nginx;
  $("pre-caddy").textContent = generated.proxy.caddy;
  $("pre-commands").textContent = generated.commands.join("\\n");
  $("pre-token").textContent = generated.merchantApiToken;
  $("verifyToken").value = generated.merchantApiToken;
  $("output").hidden = false;
  $("output-finish").hidden = false;
  $("card-install").hidden = false;
  $("install-pending").hidden = true;
  refreshRail();
});

function textFor(kind) {
  if (!generated) return "";
  if (kind === "config") return generated.files.config.content;
  if (kind === "env") return generated.files.env.content;
  if (kind === "nginx") return generated.proxy.nginx;
  if (kind === "caddy") return generated.proxy.caddy;
  if (kind === "token") return generated.merchantApiToken;
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

// --- step 4: the check ----------------------------------------------------
const CHECK_LABELS = {
  health: "checkHealth", openapi: "checkOpenapi", ucp: "checkUcp", llms: "checkLlms",
  merchantApi: "checkMerchantApi",
};
$("btn-verify").addEventListener("click", async () => {
  const btn = $("btn-verify");
  clearMsg($("msg-verify"));
  $("verify-checks").textContent = "";
  $("verify-store").textContent = "";
  btn.disabled = true; btn.textContent = t("vRunning");
  // POST, not a query string: the panel key travels in the body and is never part of a URL.
  const payload = { domain: $("verifyDomain").value.trim() };
  const token = $("verifyToken").value.trim();
  if (token) payload.merchantApiToken = token;
  const r = await post("/api/verify", payload);
  btn.disabled = false; btn.textContent = t("vRun");
  if (!r.ok) { verifiedOk = false; refreshRail(); showErr($("msg-verify"), r.error); return; }
  const result = r.body;
  verifiedOk = result.ok === true;
  refreshRail();
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
