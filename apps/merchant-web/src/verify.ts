/**
 * Deployment verification: hits the merchant's domain the same way the reference buying agent
 * does its discovery step (packages/mcp-buyer/src/demo.ts), and renders the result as a
 * checklist. It proves the proxy rules and the store's AgentPOS process are in place without
 * trusting anyone's word, ours included.
 *
 * Hints are merchant-facing: they avoid internal vocabulary ("sidecar"), always say what to do
 * next, and are written in the merchant's language (Spanish, correctly accented, no em dashes),
 * exactly like the outbound guard's refusals in ssrf.ts. What stays untranslated is what a
 * machine reads: the error codes, the check ids, the paths, the env var names and the commands.
 */
import { z } from "zod";
import { AgentPOSError } from "@agentpos/core";

export type VerifyCheckId = "health" | "openapi" | "ucp" | "llms" | "merchantApi";

export const verifyRequestSchema = z.object({
  /** "shop.example" or a full URL; normalized by `normalizeDomain`. */
  domain: z.string().max(255),
  /**
   * The store owner's `MERCHANT_API_TOKEN`, when they also want the panel check. It arrives in
   * a request BODY (never a query string, which servers log), is used for two probes against
   * their own store, and is never stored or logged here.
   */
  merchantApiToken: z.string().trim().min(1).max(512).optional(),
});

export type VerifyRequest = z.infer<typeof verifyRequestSchema>;

export interface VerifyCheck {
  id: VerifyCheckId;
  url: string;
  ok: boolean;
  /** HTTP status when the endpoint answered at all. */
  status?: number;
  /** Actionable next step when the check failed. */
  hint?: string;
}

export interface VerifyResult {
  origin: string;
  ok: boolean;
  /** What the store says about itself, when /health answered with JSON. */
  store?: {
    name?: string;
    network?: string;
    asset?: string;
    facilitatorOk?: boolean;
  };
  checks: VerifyCheck[];
}

const TIMEOUT_MS = 10_000;
const BASE_PATH = "/agentpos";

/** Accepts "shop.example" or a full URL; returns a clean https origin (http kept if explicit). */
export function normalizeDomain(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new AgentPOSError("CONFIG_INVALID", "Falta la dirección de tu tienda", {
      hint: "Escribe el dominio de tu tienda, por ejemplo mitienda.cl o https://mitienda.cl.",
    });
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new AgentPOSError("CONFIG_INVALID", `'${trimmed}' no se entiende como una dirección`, {
      hint: "Escribe solo el dominio, por ejemplo mitienda.cl, o la dirección https completa.",
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AgentPOSError("CONFIG_INVALID", `Protocolo no admitido '${url.protocol}'`, {
      hint: "Solo podemos comprobar direcciones http o https.",
    });
  }
  return url.origin;
}

interface HealthBody {
  ok?: boolean;
  name?: string;
  network?: string;
  asset?: string;
  facilitator?: { ok?: boolean };
}

async function probe(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ res?: Response; error?: string }> {
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/json, */*", ...extraHeaders },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { res };
  } catch (err) {
    // The outbound guard refusing an address is not a failing check: it is a typed error for
    // the merchant, so it interrupts the whole checklist instead of showing up as "did not
    // answer" next to a URL we never called.
    if (err instanceof AgentPOSError) throw err;
    return { error: String(err) };
  }
}

const UNREACHABLE_HINT =
  "Esa dirección no respondió. Revisa el dominio, que el sitio esté en línea y las rutas del proxy (paso 5 de la guía de instalación).";

/** Where AgentPOS Cloud reads the store from: the one check that needs the owner's key. */
const MERCHANT_SUMMARY_PATH = `${BASE_PATH}/api/merchant/summary`;

/**
 * The panel check, run only when the merchant supplied their key. Deliberately two probes: WITH
 * the key the store must answer 200, and WITHOUT it the very same URL must answer 401. A store
 * that answers both ways hands every order and buyer email to anyone who asks, so that case
 * fails the checklist loudly instead of passing.
 */
async function merchantApiCheck(
  origin: string,
  token: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<VerifyCheck> {
  const url = `${origin}${MERCHANT_SUMMARY_PATH}`;
  const [authed, anonymous] = await Promise.all([
    probe(fetchImpl, url, { authorization: `Bearer ${token}` }),
    probe(fetchImpl, url),
  ]);
  const res = authed.res;
  if (!res) return { id: "merchantApi", url, ok: false, hint: UNREACHABLE_HINT };
  const base = { id: "merchantApi" as const, url, status: res.status };
  if (res.status === 404) {
    return {
      ...base,
      ok: false,
      hint: "Tu tienda responde, pero todavía no conoce esta dirección: está corriendo una versión antigua de AgentPOS. Actualízala (`npm install -g @agentpos/site@latest`, o reconstruye tu imagen de Docker), vuelve a ejecutar `npx agentpos serve` y comprueba otra vez.",
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ...base,
      ok: false,
      hint: "Tu tienda rechazó esta llave. Revisa que MERCHANT_API_TOKEN, en el .env de tu servidor, sea exactamente la llave que muestra este instalador, y vuelve a iniciar AgentPOS para que lea el cambio.",
    };
  }
  if (!res.ok) {
    return {
      ...base,
      ok: false,
      hint: "Tu tienda respondió con un error. Ejecuta `npx agentpos status` en tu servidor y revisa lo que informa AgentPOS.",
    };
  }
  if (anonymous.res?.status !== 401) {
    return {
      ...base,
      ok: false,
      hint: "Tus órdenes responden SIN la llave, así que cualquiera podría leerlas. Revisa que tu servidor no esté dejando pasar su propio encabezado Authorization, y que MERCHANT_API_TOKEN esté puesto en el .env con el que corre tu tienda.",
    };
  }
  return { ...base, ok: true };
}

/**
 * Runs the four discovery checks against the domain, plus the panel check when the merchant
 * supplied their key. Never throws for a failing store.
 */
export async function verifyDeployment(
  domain: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  merchantApiToken?: string,
): Promise<VerifyResult> {
  const origin = normalizeDomain(domain);
  const targets: Array<{ id: VerifyCheckId; url: string; hint: string }> = [
    {
      id: "health",
      url: `${origin}${BASE_PATH}/health`,
      hint: `AgentPOS no respondió en ${BASE_PATH}/health. ¿Está corriendo \`npx agentpos serve\` en tu servidor, y tu proxy redirige ${BASE_PATH}/ hacia él?`,
    },
    {
      id: "openapi",
      url: `${origin}/openapi.json`,
      hint: "Los agentes buscan /openapi.json antes que nada. Agrega la regla del proxy para esa ruta (paso 5 de la guía de instalación).",
    },
    {
      id: "ucp",
      url: `${origin}/.well-known/ucp`,
      hint: "Falta el manifiesto UCP en /.well-known/ucp. Agrega la regla del proxy para esa ruta (paso 5 de la guía de instalación).",
    },
    {
      id: "llms",
      url: `${origin}/llms.txt`,
      hint: "Opcional pero recomendado: /llms.txt es lo que leen los directorios de x402. Agrega la regla del proxy para esa ruta.",
    },
  ];

  const probes = await Promise.all(targets.map((t) => probe(fetchImpl, t.url)));

  const checks: VerifyCheck[] = [];
  let store: VerifyResult["store"];

  for (const [index, target] of targets.entries()) {
    const { res } = probes[index] as { res?: Response; error?: string };
    if (!res) {
      checks.push({ id: target.id, url: target.url, ok: false, hint: UNREACHABLE_HINT });
      continue;
    }
    let ok = res.ok;
    let hint = ok ? undefined : target.hint;
    if (target.id === "health") {
      const body = (await res.json().catch(() => undefined)) as HealthBody | undefined;
      if (body && typeof body === "object") {
        store = {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.network !== undefined ? { network: body.network } : {}),
          ...(body.asset !== undefined ? { asset: body.asset } : {}),
          ...(body.facilitator?.ok !== undefined ? { facilitatorOk: body.facilitator.ok } : {}),
        };
        if (!res.ok && body.ok === false) {
          // AgentPOS answered: the proxy is fine, the store itself reports a problem.
          hint =
            body.facilitator?.ok === false
              ? "AgentPOS responde, pero no logra llegar al facilitador de pagos. Revisa AGENTPOS_FACILITATOR_URL y AGENTPOS_FACILITATOR_API_KEY en el .env de tu servidor."
              : "AgentPOS responde, pero informa un problema (ejecuta `npx agentpos status` en tu servidor).";
        }
      } else if (res.ok) {
        ok = false;
        hint =
          "Algo respondió en /agentpos/health, pero no era AgentPOS. Revisa que tu proxy redirija esa ruta al puerto de AgentPOS (8402 salvo que lo hayas cambiado).";
      }
    }
    checks.push({
      id: target.id,
      url: target.url,
      ok,
      status: res.status,
      ...(hint !== undefined ? { hint } : {}),
    });
  }

  // Only when the merchant asked for it, and only against their own store.
  if (merchantApiToken !== undefined && merchantApiToken !== "") {
    checks.push(await merchantApiCheck(origin, merchantApiToken, fetchImpl));
  }

  // llms.txt is recommended, not required: the store is "ready" on the first three (plus the
  // panel check, when the merchant supplied a key: they asked for it, so it counts).
  const required = checks.filter((c) => c.id !== "llms");
  return {
    origin,
    ok: required.every((c) => c.ok),
    ...(store !== undefined ? { store } : {}),
    checks,
  };
}
