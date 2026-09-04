/**
 * Deployment verification: hits the merchant's domain the same way the reference buying agent
 * does its discovery step (packages/mcp-buyer/src/demo.ts), and renders the result as a
 * checklist. It proves the proxy rules and the sidecar are in place without trusting anyone's
 * word, ours included.
 */
import { AgentPOSError } from "@agentpos/core";

export type VerifyCheckId = "health" | "openapi" | "ucp" | "llms";

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
): Promise<{ res?: Response; error?: string }> {
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/json, */*" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { res };
  } catch (err) {
    return { error: String(err) };
  }
}

const UNREACHABLE_HINT =
  "The URL did not answer. Check the domain, that the site is online, and the proxy rules (step 5 of the onboarding guide).";

/** Runs the four discovery checks against the domain. Never throws for a failing store. */
export async function verifyDeployment(
  domain: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<VerifyResult> {
  const origin = normalizeDomain(domain);
  const targets: Array<{ id: VerifyCheckId; url: string; hint: string }> = [
    {
      id: "health",
      url: `${origin}${BASE_PATH}/health`,
      hint: `The sidecar did not answer at ${BASE_PATH}/health. Is \`npx agentpos serve\` running, and does your proxy forward ${BASE_PATH}/ to it?`,
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
          // The sidecar answered: the proxy is fine, the store itself reports a problem.
          hint =
            body.facilitator?.ok === false
              ? "The sidecar answers but cannot reach its facilitator. Check AGENTPOS_FACILITATOR_URL and AGENTPOS_FACILITATOR_API_KEY in .env."
              : "The sidecar answers but reports a problem (see `npx agentpos status`).";
        }
      } else if (res.ok) {
        ok = false;
        hint =
          "Something answered at /agentpos/health but not with the sidecar's JSON. Check the proxy forwards to the sidecar port (8402 by default).";
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

  // llms.txt is recommended, not required: the store is "ready" on the first three.
  const required = checks.filter((c) => c.id !== "llms");
  return {
    origin,
    ok: required.every((c) => c.ok),
    ...(store !== undefined ? { store } : {}),
    checks,
  };
}
