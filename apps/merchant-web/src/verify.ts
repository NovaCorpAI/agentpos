/**
 * Deployment verification: hits the merchant's domain the same way the reference buying agent
 * does its discovery step (packages/mcp-buyer/src/demo.ts), and renders the result as a
 * checklist. It proves the proxy rules and the store's AgentPOS process are in place without
 * trusting anyone's word, ours included.
 *
 * Hints are merchant-facing: they avoid internal vocabulary ("sidecar") and always say what to
 * do next.
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
    throw new AgentPOSError("CONFIG_INVALID", "A domain is required", {
      hint: "Enter your store's domain, e.g. shop.example or https://shop.example.",
    });
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new AgentPOSError("CONFIG_INVALID", `'${trimmed}' is not a valid domain`, {
      hint: "Enter just the domain, e.g. shop.example, or the full https URL.",
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AgentPOSError("CONFIG_INVALID", `Unsupported protocol '${url.protocol}'`, {
      hint: "Only http(s) URLs can be verified.",
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
  "The URL did not answer. Check the domain, that the site is online, and the proxy rules (step 5 of the onboarding guide).";

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
      hint: "Your store answers, but it does not know this address yet: it is running an older version of AgentPOS. Update it (`npm install -g @agentpos/site@latest`, or rebuild your Docker image), start `npx agentpos serve` again, and check once more.",
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ...base,
      ok: false,
      hint: "Your store refused this key. Check that MERCHANT_API_TOKEN in the .env on your server is exactly the key the wizard shows, and start AgentPOS again so it reads the change.",
    };
  }
  if (!res.ok) {
    return {
      ...base,
      ok: false,
      hint: "Your store answered with an error. Run `npx agentpos status` on your server and check what AgentPOS reports.",
    };
  }
  if (anonymous.res?.status !== 401) {
    return {
      ...base,
      ok: false,
      hint: "Your orders answer WITHOUT the key, so anyone could read them. Check that your server is not passing its own Authorization header through, and that MERCHANT_API_TOKEN is set in the .env your store is running.",
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
      hint: `AgentPOS did not answer at ${BASE_PATH}/health. Is \`npx agentpos serve\` running on your server, and does your proxy forward ${BASE_PATH}/ to it?`,
    },
    {
      id: "openapi",
      url: `${origin}/openapi.json`,
      hint: "Agents look for /openapi.json first. Add the proxy rule for it (step 5 of the onboarding guide).",
    },
    {
      id: "ucp",
      url: `${origin}/.well-known/ucp`,
      hint: "The UCP manifest at /.well-known/ucp is missing. Add the proxy rule for it (step 5 of the onboarding guide).",
    },
    {
      id: "llms",
      url: `${origin}/llms.txt`,
      hint: "Optional but recommended: /llms.txt is what the x402 directories read. Add the proxy rule for it.",
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
              ? "AgentPOS answers but cannot reach the payment facilitator. Check AGENTPOS_FACILITATOR_URL and AGENTPOS_FACILITATOR_API_KEY in the .env on your server."
              : "AgentPOS answers but reports a problem (run `npx agentpos status` on your server).";
        }
      } else if (res.ok) {
        ok = false;
        hint =
          "Something answered at /agentpos/health, but it was not AgentPOS. Check that your proxy forwards that path to the AgentPOS port (8402 by default).";
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
