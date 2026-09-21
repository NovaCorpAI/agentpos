/**
 * One-shot WooCommerce credential check: calls the store's own REST API with the keys the
 * merchant typed and reports whether they work. The keys live for the duration of this request
 * and are never stored, logged or forwarded anywhere else.
 *
 * Messages and hints are merchant-facing, so they are written in Spanish (accents included, no
 * em dashes) like the rest of the installer. Codes, statuses and WordPress screen names stay as
 * they are: they are what a machine matches on and what the merchant sees in their own admin.
 */
import { z } from "zod";
import { AgentPOSError } from "@agentpos/core";

export const wooValidationRequestSchema = z.object({
  /** WordPress site URL, e.g. https://store.example */
  baseUrl: z.url().max(2048),
  // Field caps: a WooCommerce key is ~43 characters. Anything near these bounds is not a key,
  // and a public endpoint should say so before it opens a connection on the caller's behalf.
  consumerKey: z.string().trim().min(1).max(256),
  consumerSecret: z.string().trim().min(1).max(256),
});

export type WooValidationRequest = z.infer<typeof wooValidationRequestSchema>;

export interface WooValidationResult {
  ok: true;
  /** How many products the one-item probe saw (0 or 1); proves read access either way. */
  sampleProducts: number;
}

const TIMEOUT_MS = 10_000;

/**
 * GET /wp-json/wc/v3/products?per_page=1 with Basic auth, 10s timeout. Success returns the
 * result; every failure throws a typed `AgentPOSError` whose hint says what to fix.
 */
export async function validateWooCredentials(
  request: WooValidationRequest,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<WooValidationResult> {
  const base = request.baseUrl.replace(/\/+$/, "");
  const url = `${base}/wp-json/wc/v3/products?per_page=1`;
  const auth = Buffer.from(`${request.consumerKey}:${request.consumerSecret}`).toString("base64");

  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { authorization: `Basic ${auth}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // A refusal from the outbound guard (a private address, a bad port, a redirect off the
    // host) is not "the store is down": it is a typed answer the merchant can act on, so it
    // travels as it is instead of being flattened into SITE_UNREACHABLE.
    if (err instanceof AgentPOSError) throw err;
    throw new AgentPOSError("SITE_UNREACHABLE", `No pudimos llegar a ${base}`, {
      hint: "Revisa la dirección de tu tienda (https, sin errores de tipeo) y que el sitio esté en línea. WooCommerce rechaza esta autenticación si el sitio corre en http a secas.",
      retryable: true,
      details: { url, error: String(err) },
    });
  }

  if (res.status === 401 || res.status === 403) {
    throw new AgentPOSError("CONFIG_INVALID", `WooCommerce rechazó las llaves (${res.status})`, {
      hint: "Vuelve a pegar la clave de cliente (ck_...) y la clave secreta (cs_...) tal cual las mostró WooCommerce, y revisa que la clave tenga permisos de Lectura/escritura. Si tu tienda corre en http a secas, WooCommerce rechaza esta autenticación: usa https.",
      details: { status: res.status },
    });
  }
  if (res.status === 404) {
    throw new AgentPOSError("CONFIG_INVALID", "La API REST de WooCommerce no está en esa dirección", {
      hint: "Revisa que la dirección apunte al sitio WordPress mismo, que WooCommerce esté activo y que los enlaces permanentes (permalinks) no estén en Simple (Ajustes > Enlaces permanentes).",
      details: { status: res.status, url },
    });
  }
  if (!res.ok) {
    throw new AgentPOSError("INTERNAL", `WooCommerce respondió ${res.status}`, {
      hint: "Tu tienda respondió, pero no con datos. Revisa los registros de tu servidor; un 5xx suele ser un plugin o el hosting.",
      retryable: res.status >= 500,
      details: { status: res.status },
    });
  }

  const body: unknown = await res.json().catch(() => undefined);
  if (!Array.isArray(body)) {
    throw new AgentPOSError("CONFIG_INVALID", "Esa dirección no respondió como WooCommerce", {
      hint: "La respuesta no era una lista de productos. Revisa que la dirección sea la del sitio WordPress, sin /wp-admin ni rutas de más.",
      details: { url },
    });
  }
  return { ok: true, sampleProducts: body.length };
}
