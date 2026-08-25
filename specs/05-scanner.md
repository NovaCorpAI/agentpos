# SPEC 05: Scanner del sitio propio (`@agentgate/scanner`)

## Objetivo

Invertir el onboarding: en vez de que el vendedor configure, la librería
LEE su sitio y propone el catálogo agéntico. El humano confirma, nunca
menos. Es el corazón del producto: si el scan es bueno, el onboarding
son 15 minutos; si es malo, es un formulario más.

## Alcance v1

Input: el dominio donde corre la librería (GUARDRAIL 8: jamás terceros).
Fuentes, en orden de confianza:

1. **Connector de plataforma** (si hay credenciales): Shopify Admin API /
   WooCommerce REST devuelven productos, variantes, precios y stock
   estructurados. Es la fuente preferida; el LLM solo redacta
   descripciones para agentes.
2. **Datos estructurados:** sitemap.xml, JSON-LD schema.org (Product,
   Offer, Service), microdata, Open Graph product tags, feeds existentes
   (Google Merchant XML, RSS de productos).
3. **Páginas de producto:** HTML de las URLs del sitemap con patrón de
   producto; extracción con LLM vía core/llm router.
4. **OpenAPI / docs** para sitios que venden servicios o APIs.

Pipeline:

1. Fetch respetando robots.txt del propio sitio y rate limit suave.
2. Normalización a `CatalogItemDraft` (zod) con `source_evidence`: URL,
   selector o línea fuente de cada campo. Extracciones sin evidencia se
   descartan.
3. Redacción para agentes: `description_agent` corta y factual, atributos
   con unidades y formatos explícitos, sin marketing.
4. Precio: se captura el precio fiat y moneda de origen; se SUGIERE USDC
   por tipo de cambio del momento, marcado como sugerencia. El humano lo
   confirma siempre (guardrail 5).
5. Salida: `agentgate.catalog.draft.json` + tabla "esto entendí" con
   confianza por item.

## Sync

Re-scan programado detecta altas/bajas/cambios; produce un draft
diferencial. Con connector, stock y precio vienen de la plataforma en
tiempo real y el scan solo aporta descripciones y atributos.

## Calidad

- Nunca inventar items no presentes en la fuente.
- Eval set: 8 sitios fixture (2 Woo, 2 Shopify, 2 custom con JSON-LD, 1
  custom sin datos estructurados, 1 API con OpenAPI) con ground truth
  anotado. Métricas: precision/recall de items, exactitud de precio y
  atributos. CI: mock LLM en PRs, real en nightly.

## Fase Build (documentar, no construir)

Sincronización de stock bidireccional, variantes complejas (tallas/colores
como matriz), bundles, suscripciones, catálogos >10k items (paginación y
scan incremental).
