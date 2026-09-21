/**
 * The installer's identity, asserted on the rendered document: the amber accent lives in one
 * token, the rail says what each step captured, step 4 reads like a finish line, and the
 * Spanish carries its accents. The page ships no framework, so what a test can hold on to is
 * the HTML itself plus the three pure helpers the page script is built from.
 */
import { describe, expect, it } from "vitest";
import { buildWizardHtml, normalizeStoreUrl, shortAddress, summarizeStore } from "./page.js";

const html = buildWizardHtml();

/**
 * Spanish spellings that give away a product written without accents (docs/DISENO.md: "un
 * producto que escribe mal el español pierde autoridad antes de la primera pantalla"). Word
 * boundaries matter: "direcciones" is correct, "direccion" is not.
 */
const UNACCENTED = [
  "contrasena",
  "direccion",
  "maquina",
  "dueno",
  "configuracion",
  "instalacion",
  "verificacion",
  "comprobacion",
  "numero",
  "pagina",
  "sesion",
  "conexion",
  "tambien",
  "aqui",
  "despues",
  "informacion",
  "descripcion",
  "automatico",
  "automatica",
  "rapido",
  "minimo",
  "maximo",
  "ultimo",
  "proximo",
  "proximos",
  "anadir",
  "ademas",
  "credito",
  "boton",
  "linea",
  "ordenes",
  "articulos",
  "guia",
  "asi",
  "codigo",
  "telefono",
  "parametro",
];

// ---------------------------------------------------------------------------
describe("the summary helpers the rail is built from", () => {
  it("summarizes a store as host plus platform, the way the rail shows it", () => {
    expect(summarizeStore("https://mitienda.cl", "WooCommerce")).toBe("mitienda.cl, WooCommerce");
    expect(summarizeStore("https://www.mitienda.cl/tienda?x=1", "WooCommerce")).toBe(
      "mitienda.cl, WooCommerce",
    );
    // What a merchant actually types, before the field normalizes it.
    expect(summarizeStore("  mitienda.cl  ", "hook propio")).toBe("mitienda.cl, hook propio");
  });

  it("returns nothing when there is nothing to summarize yet", () => {
    expect(summarizeStore("", "WooCommerce")).toBe("");
    expect(summarizeStore("   ", "WooCommerce")).toBe("");
    expect(summarizeStore("https://", "WooCommerce")).toBe("");
    expect(summarizeStore("mitienda.cl", "")).toBe("mitienda.cl");
  });

  it("shortens a wallet address to something recognizable on one line", () => {
    const address = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
    const short = shortAddress(address);
    expect(short).toBe("GA7QYN…VSGZ");
    expect(short.length).toBeLessThan(14);
    expect(shortAddress("")).toBe("");
    expect(shortAddress("G12345")).toBe("G12345");
  });

  it("accepts the address a merchant types and makes it absolute", () => {
    expect(normalizeStoreUrl("mitienda.cl")).toBe("https://mitienda.cl");
    expect(normalizeStoreUrl("  mitienda.cl/tienda ")).toBe("https://mitienda.cl/tienda");
    expect(normalizeStoreUrl("http://mitienda.cl")).toBe("http://mitienda.cl");
    expect(normalizeStoreUrl("https://mitienda.cl")).toBe("https://mitienda.cl");
    expect(normalizeStoreUrl("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
describe("the progress rail", () => {
  it("gives every step a summary slot and a check mark, not four equal boxes", () => {
    for (const step of [1, 2, 3, 4]) {
      expect(html).toContain(`data-sum="${step}"`);
      expect(html).toContain(`data-step="${step}"`);
    }
    // A line that fills, and a shape (not only a colour) for the finished state.
    expect(html).toContain('<div class="track"><span class="fill" id="rail-fill">');
    expect(html).toContain('class="tick"');
    expect(html).toContain("--fill");
  });

  it("ships the very helpers this file unit tests, so the rail and the tests agree", () => {
    expect(html).toContain("function summarizeStore");
    expect(html).toContain("function shortAddress");
    expect(html).toContain("function normalizeStoreUrl");
  });

  it("names what each finished step captured, in both languages", () => {
    expect(html).toContain('"sumFiles":"dos archivos listos"');
    expect(html).toContain('"sumCheckOk":"tienda comprobada"');
    expect(html).toContain('"sumTodo":"pendiente"');
    expect(html).toContain('"sumFiles":"two files ready"');
    // Short platform labels exist precisely so the summary reads "mitienda.cl, WooCommerce".
    expect(html).toContain('"s1WooShort":"WooCommerce"');
  });
});

// ---------------------------------------------------------------------------
describe("the before and after in the header", () => {
  it("draws the two stores inline, with a described figure and no images", () => {
    expect(html).toContain('<figure class="ba">');
    expect(html).toContain('role="img" aria-labelledby="ba-title ba-desc"');
    expect(html).toContain('data-i18n="baBefore"');
    expect(html).toContain('data-i18n="baAfter"');
    expect(html).toContain('"baBefore":"tu tienda hoy"');
    expect(html).toContain('"baAfter":"tu tienda con AgentPOS"');
    expect(html).not.toMatch(/<img\b/);
  });

  it("is drawn static and only animates when motion is welcome", () => {
    // The finished drawing is the default state; the animation lives inside the opt-in query.
    expect(html).toContain("@media (prefers-reduced-motion: no-preference)");
    const animated = html.slice(html.indexOf("@media (prefers-reduced-motion: no-preference)"));
    expect(animated).toContain("stroke-dashoffset: 120");
    expect(html).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

// ---------------------------------------------------------------------------
describe("step 4, the finish line", () => {
  it("opens with the achievement, not with a list of files", () => {
    expect(html).toContain('"s4Title":"Listo: tu tienda ya puede vender a agentes"');
    expect(html).toContain('"s4Title":"Done: your store can sell to agents"');
  });

  it("presents the panel key as a certificate: amber frame, monospace, copy button", () => {
    expect(html).toContain('<div class="cert">');
    expect(html).toContain('<pre id="pre-token">');
    expect(html).toContain('data-copy="token"');
    expect(html).toContain(".cert { border: 1px solid var(--accent-line)");
    // The read-only promise travels with the key.
    expect(html).toContain("Es de solo lectura");
  });

  it("hands over the two files and the three places to go next", () => {
    expect(html).toContain('"filesTitle":"Tus dos archivos"');
    expect(html).toContain('data-dl="config"');
    expect(html).toContain('data-dl="env"');
    expect(html).toContain('"nextTitle":"Tus próximos tres pasos"');
    expect(html).toContain('href="https://app.agentposhq.com"');
    expect(html).toContain('href="https://demo.agentposhq.com"');
    expect(html).toContain('href="https://github.com/NovaCorpAI/agentpos"');
  });

  it("celebrates soberly: no emojis, no exclamation marks in the headline", () => {
    expect(html).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}]/u);
    expect(html).not.toContain("¡");
  });
});

// ---------------------------------------------------------------------------
describe("the WooCommerce keys step", () => {
  it("explains in one line what the keys let AgentPOS do", () => {
    expect(html).toContain("crear la orden en tu tienda cuando un agente paga. Nada más.");
  });

  it("offers the exact click path, collapsed until it is needed", () => {
    expect(html).toContain('<details class="how">');
    expect(html).toContain('"wooHowTitle":"Cómo las obtengo"');
    expect(html).toContain("WooCommerce, después Ajustes");
    expect(html).toContain("pestaña Avanzado, después API REST");
    expect(html).toContain("Lectura/escritura");
    expect(html).toContain("WooCommerce las muestra una sola vez");
    for (const step of [1, 2, 3, 4, 5, 6, 7]) {
      expect(html).toContain(`data-i18n="wooHow${step}"`);
    }
  });
});

// ---------------------------------------------------------------------------
describe("the language a merchant recognizes", () => {
  it("asks for the store address in merchant words, with the panel's placeholder", () => {
    expect(html).toContain('"s1Url":"La dirección de tu tienda"');
    expect(html).toContain('"s1UrlPh":"mitienda.cl"');
    expect(html).not.toContain("URL pública de tu tienda");
    // Internal jargon: the lighthouse stores are our vocabulary, not the merchant's.
    expect(html).not.toContain("Tienda Faro");
    expect(html).not.toContain("Faro Store");
  });

  it("writes Spanish with its accents", () => {
    const text = html.toLowerCase();
    for (const word of UNACCENTED) {
      expect(new RegExp(`\\b${word}\\b`).test(text), word).toBe(false);
    }
    // ...and the accented spellings are actually there, so the rule above is not vacuous.
    for (const word of ["contraseña", "dirección", "órdenes", "código", "línea", "guía"]) {
      expect(html).toContain(word);
    }
  });

  it("keeps the project's no-em-dash rule", () => {
    expect(html).not.toContain("—");
  });
});

// ---------------------------------------------------------------------------
describe("one accent, declared once", () => {
  it("defines amber as a token and never repeats the literal", () => {
    expect(html).toContain("--accent: #f2a33c");
    expect(html.match(/f2a33c/gi) ?? []).toHaveLength(1);
    // No amber smuggled back in as rgba() or a near-duplicate hex.
    expect(html).not.toMatch(/rgba\(\s*242\s*,\s*163/);
    expect(html.match(/var\(--accent/g)?.length ?? 0).toBeGreaterThan(20);
  });

  it("derives every amber shade from that one token", () => {
    for (const token of ["--accent-soft", "--accent-faint", "--accent-line", "--accent-dim"]) {
      expect(html).toContain(`${token}: color-mix(in srgb, var(--accent)`);
    }
  });
});

// ---------------------------------------------------------------------------
describe("accessible and self-contained", () => {
  it("labels every field it asks the merchant to fill", () => {
    const fields = [...html.matchAll(/<(?:input|select)\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
    const labelled = new Set(
      [...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map((m) => m[1] as string),
    );
    expect(fields.length).toBeGreaterThan(5);
    for (const field of fields) expect(labelled.has(field as string), field).toBe(true);
  });

  it("marks the current step for assistive tech and keeps focus visible", () => {
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('aria-label="Tu avance"');
    expect(html).toContain(":focus-visible { outline: 2px solid var(--accent)");
    expect(html).toContain('role="status"');
  });

  it("still loads nothing from anywhere else", () => {
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toContain("<link");
    expect(html).not.toContain("@import");
    expect(html).not.toContain("https://cdn");
    expect(html).not.toContain("fonts.googleapis");
  });
});
