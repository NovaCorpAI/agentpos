/**
 * Same-origin fetcher with robots.txt respect and soft rate limiting.
 * Guardrail 8: the scanner only ever reads the site it is installed on.
 */
import { AgentPOSError } from "@agentpos/core";

export interface SiteFetcherOptions {
  baseUrl: string;
  fetchImpl?: typeof globalThis.fetch;
  /** Minimum milliseconds between requests. */
  minIntervalMs?: number;
  userAgent?: string;
  timeoutMs?: number;
}

export class SiteFetcher {
  readonly origin: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly minInterval: number;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private lastRequestAt = 0;
  private disallow: string[] | undefined;

  constructor(options: SiteFetcherOptions) {
    this.origin = new URL(options.baseUrl).origin;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.minInterval = options.minIntervalMs ?? 200;
    this.userAgent =
      options.userAgent ?? "AgentPOS-Scanner/0.1 (+https://github.com/NovaCorpAI/agentpos)";
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  isSameOrigin(url: string): boolean {
    try {
      return new URL(url, this.origin).origin === this.origin;
    } catch {
      return false;
    }
  }

  private async loadRobots(): Promise<string[]> {
    if (this.disallow) return this.disallow;
    this.disallow = [];
    try {
      const res = await this.rawFetch(`${this.origin}/robots.txt`);
      if (!res.ok) return this.disallow;
      const text = await res.text();
      let applies = false;
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, "").trim();
        if (!line) continue;
        const [key, ...rest] = line.split(":");
        const value = rest.join(":").trim();
        const k = key?.trim().toLowerCase();
        if (k === "user-agent")
          applies = value === "*" || value.toLowerCase().includes("agentpos");
        else if (applies && k === "disallow" && value) this.disallow.push(value);
      }
    } catch {
      /* no robots.txt: everything allowed */
    }
    return this.disallow;
  }

  async isAllowed(url: string): Promise<boolean> {
    const path = new URL(url, this.origin).pathname;
    const rules = await this.loadRobots();
    return !rules.some((rule) => path.startsWith(rule));
  }

  private async rawFetch(url: string): Promise<Response> {
    const wait = this.lastRequestAt + this.minInterval - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
    return this.fetchImpl(url, {
      headers: {
        "user-agent": this.userAgent,
        accept: "text/html,application/xml,application/json;q=0.9,*/*;q=0.5",
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: "follow",
    });
  }

  /** Fetches a same-origin URL as text, or undefined if disallowed / not found. */
  async text(url: string): Promise<string | undefined> {
    const absolute = new URL(url, this.origin).toString();
    if (!this.isSameOrigin(absolute)) {
      throw new AgentPOSError(
        "CONFIG_INVALID",
        "Scanner refuses to fetch outside the site origin",
        {
          hint: `Only ${this.origin} may be scanned (guardrail 8).`,
          details: { url: absolute },
        },
      );
    }
    if (!(await this.isAllowed(absolute))) return undefined;
    try {
      const res = await this.rawFetch(absolute);
      if (!res.ok) return undefined;
      return await res.text();
    } catch {
      return undefined;
    }
  }
}
