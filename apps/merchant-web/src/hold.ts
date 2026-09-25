/**
 * The held door: what conecta.agentposhq.com shows while the installer is not yet open to the
 * public. One self-contained page, no assets, no form of its own: it sends people to the
 * waitlist on the landing (one list, one place). Same surface identity as the wizard
 * (docs/DISENO.md, surface 2: amber accent on the dark base), Spanish first, English below.
 */

/** The brand mark, inline: the open A and the agent's dot. */
const MARK = `<svg viewBox="0 0 64 64" width="56" height="56" aria-hidden="true">
<path d="M12 50 L27 14 L42 50" fill="none" stroke="#f4f7ff" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M19 38 H35" fill="none" stroke="#f4f7ff" stroke-width="7.5" stroke-linecap="round" opacity="0.35"/>
<circle cx="50" cy="20" r="7.5" fill="#7aa2ff"/></svg>`;

export const WAITLIST_URL = "https://agentposhq.com/lista";

export function buildHoldingHtml(): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>AgentPOS · Instalador</title>
<style>
  :root { color-scheme: dark; --accent: #f2a33c; --ink: #f4f7ff; --muted: #b7c3e0; --bg: #05070f; }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    font-family: "Segoe UI", system-ui, sans-serif; color: var(--ink); background: var(--bg);
    background-image: radial-gradient(ellipse 60% 50% at 50% 35%, rgba(242,163,60,0.16), transparent 70%);
    display: grid; place-items: center; padding: 24px 16px;
  }
  main { max-width: 34rem; width: 100%; text-align: center; }
  .mark { margin-bottom: 20px; }
  .eyebrow { font-family: Consolas, ui-monospace, monospace; font-size: 12px; letter-spacing: 0.3em; color: var(--muted); text-transform: uppercase; margin: 0 0 12px; }
  h1 { font-size: clamp(1.7rem, 5vw, 2.4rem); line-height: 1.15; margin: 0 0 16px; letter-spacing: -0.01em; }
  h1 b { color: var(--accent); }
  p { color: var(--muted); font-size: 1.05rem; line-height: 1.55; margin: 0 0 14px; }
  .btn {
    display: inline-block; margin: 14px 0 6px; padding: 12px 22px; border-radius: 999px; font-weight: 600;
    background: var(--accent); color: #0b1020; text-decoration: none; min-height: 44px; line-height: 20px;
  }
  .btn:focus-visible { outline: 3px solid var(--ink); outline-offset: 3px; }
  .small { font-size: 0.9rem; }
  .small a { color: var(--ink); }
  hr { border: 0; border-top: 1px solid rgba(183,195,224,0.18); margin: 30px 0 22px; }
  .en { font-size: 0.95rem; }
  .en h2 { font-size: 1.1rem; margin: 0 0 8px; color: var(--ink); }
</style>
</head>
<body>
<main>
  <div class="mark">${MARK}</div>
  <p class="eyebrow">AgentPOS · Instalador</p>
  <h1>El instalador abre <b>en octubre</b>.</h1>
  <p>Estamos conectando las primeras tiendas nosotros mismos, una por una. Deja tu correo y te avisamos el día que puedas hacerlo tú, en cuatro pasos y sin cuenta.</p>
  <a class="btn" href="${WAITLIST_URL}">Súmate a la lista de espera</a>
  <p class="small">¿Tienes una tienda y quieres ir primero? Escríbenos a <a href="mailto:contact@agentposhq.com">contact@agentposhq.com</a>.</p>
  <hr>
  <section class="en" lang="en">
    <h2>The installer opens in October.</h2>
    <p>We are connecting the first stores ourselves. Leave your email and we will tell you the day you can do it on your own, in four steps and with no account. <a href="${WAITLIST_URL}" style="color:var(--ink)">Join the waitlist</a>.</p>
  </section>
</main>
</body>
</html>`;
}
