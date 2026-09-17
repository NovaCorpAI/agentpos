/**
 * Reverse-proxy configuration for the sidecar, printed by `agentpos serve`.
 *
 * The sidecar answers on four paths and nothing else (see app.ts): three fixed documents at the
 * site ROOT, because that is where the ecosystem's crawlers look for them, plus everything under
 * the configured base path. A proxy rule that forwards only the base path leaves the store
 * undiscoverable, which is the single most common reason an install looks dead.
 *
 * Two details every snippet honours, because the sidecar depends on them:
 *  - the client IP must survive the hop (`x-forwarded-for`, `x-real-ip` or `cf-connecting-ip`),
 *    otherwise every agent shares one rate-limit bucket;
 *  - the original Host must survive it too, so links the store prints match the public domain.
 */

export const PROXY_TARGETS = ["nginx", "caddy", "apache", "cloudflare"] as const;
export type ProxyTarget = (typeof PROXY_TARGETS)[number];

export interface ProxyInput {
  /** The store's public URL, exactly as configured (`siteUrl`). */
  siteUrl: string;
  /** AgentPOS path prefix, leading slash, no trailing slash (e.g. `/agentpos`). */
  basePath: string;
  /** Where the web server reaches the sidecar, e.g. `http://127.0.0.1:8402`. */
  upstream: string;
}

/**
 * Every path the sidecar serves, in the order the snippets list them. The first three are served
 * at the site root; the last one is a prefix and carries the whole API.
 */
export function agentposProxyPaths(basePath: string): string[] {
  return ["/.well-known/ucp", "/openapi.json", "/llms.txt", `${basePath}/`];
}

function hostOf(siteUrl: string): string {
  try {
    return new URL(siteUrl).host;
  } catch {
    return siteUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

function nginx({ basePath, upstream }: ProxyInput): string {
  const headers = [
    "proxy_set_header Host $host;",
    "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "proxy_set_header X-Forwarded-Proto $scheme;",
  ];
  // `=` is an exact match (the three root documents); the base path is a prefix, so it carries
  // the whole API with one rule.
  const matchers = [
    "= /.well-known/ucp",
    "= /openapi.json",
    "= /llms.txt",
    `${basePath}/`,
  ];
  const width = Math.max(...matchers.map((m) => m.length));
  return [
    "# nginx: paste inside the server { } block that already serves your site.",
    "# Reload with: nginx -t && systemctl reload nginx",
    ...matchers.map(
      (m) => `location ${m.padEnd(width)} { proxy_pass ${upstream}; ${headers.join(" ")} }`,
    ),
  ].join("\n");
}

function caddy(input: ProxyInput): string {
  const { basePath, upstream } = input;
  return [
    "# Caddy: inside your site block. Caddy already forwards Host and X-Forwarded-*.",
    "# Reload with: caddy reload --config /etc/caddy/Caddyfile",
    `${hostOf(input.siteUrl)} {`,
    "  handle /.well-known/ucp {",
    `    reverse_proxy ${upstream}`,
    "  }",
    "  handle /openapi.json {",
    `    reverse_proxy ${upstream}`,
    "  }",
    "  handle /llms.txt {",
    `    reverse_proxy ${upstream}`,
    "  }",
    `  handle ${basePath}/* {`,
    `    reverse_proxy ${upstream}`,
    "  }",
    "  # Everything else keeps going to your existing site:",
    "  # handle { reverse_proxy http://127.0.0.1:80 }",
    "}",
  ].join("\n");
}

function apache({ basePath, upstream }: ProxyInput): string {
  const target = upstream.replace(/\/+$/, "");
  const pass = (path: string) => [
    `ProxyPass        ${path} ${target}${path}`,
    `ProxyPassReverse ${path} ${target}${path}`,
  ];
  return [
    "# Apache: inside your <VirtualHost *:443>. Needs mod_proxy and mod_proxy_http:",
    "#   a2enmod proxy proxy_http && systemctl reload apache2",
    "# ProxyPreserveHost keeps the public Host; mod_proxy adds X-Forwarded-For itself.",
    "ProxyPreserveHost On",
    ...pass("/.well-known/ucp"),
    ...pass("/openapi.json"),
    ...pass("/llms.txt"),
    ...pass(`${basePath}/`),
  ].join("\n");
}

function cloudflare(input: ProxyInput): string {
  const { basePath, upstream } = input;
  const host = hostOf(input.siteUrl);
  const rule = (path: string) =>
    ["  - hostname: " + host, `    path: ${path}`, `    service: ${upstream}`];
  return [
    "# Cloudflare only needs configuring when it is the thing reaching your box, i.e. a",
    "# Cloudflare Tunnel. If Cloudflare merely fronts your own web server, change nothing here:",
    "# configure that server (nginx, Apache or Caddy) and Cloudflare passes these paths through.",
    "#",
    "# Cloudflare Tunnel: ~/.cloudflared/config.yml, then `cloudflared tunnel run <name>`.",
    "# `path` is a regular expression, and the first matching rule wins, so order matters.",
    "tunnel: <your-tunnel-id>",
    "credentials-file: /root/.cloudflared/<your-tunnel-id>.json",
    "ingress:",
    ...rule("^/\\.well-known/ucp$"),
    ...rule("^/openapi\\.json$"),
    ...rule("^/llms\\.txt$"),
    ...rule(`^${basePath}/`),
    "  # Everything else: your existing site (last rule, no hostname, is the catch-all).",
    "  - service: http://127.0.0.1:80",
  ].join("\n");
}

const BUILDERS: Record<ProxyTarget, (input: ProxyInput) => string> = {
  nginx,
  caddy,
  apache,
  cloudflare,
};

/** Human label for each target, used as the heading when the CLI prints them. */
export const PROXY_LABELS: Record<ProxyTarget, string> = {
  nginx: "nginx",
  caddy: "Caddy",
  apache: "Apache (httpd)",
  cloudflare: "Cloudflare Tunnel",
};

/** Ready-to-paste configuration for one proxy. */
export function proxySnippet(target: ProxyTarget, input: ProxyInput): string {
  return BUILDERS[target](input);
}

/** All four, in a stable order, for the default `agentpos serve` output. */
export function proxySnippets(input: ProxyInput): Array<{
  target: ProxyTarget;
  label: string;
  snippet: string;
}> {
  return PROXY_TARGETS.map((target) => ({
    target,
    label: PROXY_LABELS[target],
    snippet: proxySnippet(target, input),
  }));
}
