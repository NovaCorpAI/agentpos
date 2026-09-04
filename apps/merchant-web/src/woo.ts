/**
 * One-shot WooCommerce credential check: calls the store's own REST API with the keys the
 * merchant typed and reports whether they work. The keys live for the duration of this request
 * and are never stored, logged or forwarded anywhere else.
 */
import { z } from "zod";
import { AgentPOSError } from "@agentpos/core";

export const wooValidationRequestSchema = z.object({
  /** WordPress site URL, e.g. https://store.example */
  baseUrl: z.url(),
  consumerKey: z.string().trim().min(1),
  consumerSecret: z.string().trim().min(1),
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
    throw new AgentPOSError("SITE_UNREACHABLE", `Could not reach ${base}`, {
      hint: "Check the store URL (https, no typo) and that the site is online. WooCommerce rejects Basic auth over plain http.",
      retryable: true,
      details: { url, error: String(err) },
    });
  }

  if (res.status === 401 || res.status === 403) {
    throw new AgentPOSError("CONFIG_INVALID", `WooCommerce refused the keys (${res.status})`, {
      hint: "Re-paste the Consumer key (ck_...) and Consumer secret (cs_...) exactly as WooCommerce showed them, and check the key has Read/Write permissions. If the store runs over plain http, WooCommerce refuses Basic auth: use https.",
      details: { status: res.status },
    });
  }
  if (res.status === 404) {
    throw new AgentPOSError("CONFIG_INVALID", "The WooCommerce REST API is not at this URL", {
      hint: "Check the URL points at the WordPress site itself, that WooCommerce is active, and that permalinks are not set to Plain (Settings > Permalinks).",
      details: { status: res.status, url },
    });
  }
  if (!res.ok) {
    throw new AgentPOSError("INTERNAL", `WooCommerce answered ${res.status}`, {
      hint: "The store answered but not with data. Check the server logs of the store; 5xx usually means a plugin or hosting problem.",
      retryable: res.status >= 500,
      details: { status: res.status },
    });
  }

  const body: unknown = await res.json().catch(() => undefined);
  if (!Array.isArray(body)) {
    throw new AgentPOSError("CONFIG_INVALID", "That URL did not answer like WooCommerce", {
      hint: "The response was not a product list. Check the URL is the WordPress site, without /wp-admin or extra paths.",
      details: { url },
    });
  }
  return { ok: true, sampleProducts: body.length };
}
