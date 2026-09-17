/**
 * The proxy snippets `agentpos serve` prints (GAP 3). The contract that matters is coverage: a
 * snippet that forgets one of the four paths leaves the store undiscoverable, which is exactly
 * the failure these are meant to prevent.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { resolveConfig } from "@agentpos/core";
import { createAgentPOSApp } from "./app.js";
import { parseSiteConfig } from "./config.js";
import { SiteStorage } from "./storage.js";
import { stubFacilitator } from "./test-utils.js";
import { PROXY_TARGETS, agentposProxyPaths, proxySnippet, proxySnippets } from "./proxy.js";

const input = {
  siteUrl: "https://shop.test",
  basePath: "/agentpos",
  upstream: "http://127.0.0.1:8402",
};

describe("proxy snippets", () => {
  it("covers every AgentPOS path and the sidecar upstream, for all four servers", () => {
    const blocks = proxySnippets(input);
    expect(blocks.map((b) => b.target)).toEqual([...PROXY_TARGETS]);
    for (const { target, snippet } of blocks) {
      for (const path of ["/.well-known/ucp", "/openapi.json", "/llms.txt", "/agentpos/"]) {
        // Cloudflare's ingress paths are regular expressions, so the dots are escaped there.
        const needle = target === "cloudflare" ? path.replace(/\./g, "\\.") : path;
        expect(snippet, `${target} is missing ${path}`).toContain(needle);
      }
      expect(snippet).toContain(input.upstream);
      expect(snippet.length).toBeGreaterThan(0);
    }
  });

  it("writes each server in its own syntax", () => {
    expect(proxySnippet("nginx", input)).toContain("proxy_pass http://127.0.0.1:8402;");
    expect(proxySnippet("nginx", input)).toContain("X-Forwarded-For $proxy_add_x_forwarded_for");
    expect(proxySnippet("caddy", input)).toContain("reverse_proxy http://127.0.0.1:8402");
    expect(proxySnippet("caddy", input)).toContain("shop.test {");
    expect(proxySnippet("apache", input)).toContain("ProxyPreserveHost On");
    expect(proxySnippet("apache", input)).toContain(
      "ProxyPass        /llms.txt http://127.0.0.1:8402/llms.txt",
    );
    expect(proxySnippet("cloudflare", input)).toContain("ingress:");
    expect(proxySnippet("cloudflare", input)).toContain("hostname: shop.test");
  });

  it("follows the configured base path and port", () => {
    const custom = {
      siteUrl: "https://tienda.example/",
      basePath: "/tienda-agentes",
      upstream: "http://10.0.0.5:9999",
    };
    for (const target of PROXY_TARGETS) {
      const snippet = proxySnippet(target, custom);
      expect(snippet).toContain("/tienda-agentes/");
      expect(snippet).toContain("http://10.0.0.5:9999");
      expect(snippet).not.toContain("/agentpos/");
    }
  });

  it("lists exactly the paths the sidecar actually answers", async () => {
    const storage = new SiteStorage(":memory:");
    const gate = createAgentPOSApp({
      site: parseSiteConfig({
        siteUrl: "https://shop.test",
        displayName: "Test Shop",
        payTo: Keypair.random().publicKey(),
        platform: "generic",
      }),
      core: resolveConfig({ network: "testnet" }),
      connector: {
        platform: "generic",
        getAvailability: async () => [],
        createOrder: async () => ({ externalOrderId: "x" }),
      },
      storage,
      facilitator: stubFacilitator(),
    });
    // Root documents plus the base path: every one of them answers, and nothing outside the
    // list needs proxying (the dashboard, catalog, cart and checkout all live under the base).
    for (const path of ["/.well-known/ucp", "/openapi.json", "/llms.txt"]) {
      expect((await gate.fetch(new Request(`https://shop.test${path}`))).status).toBe(200);
    }
    expect(
      (await gate.fetch(new Request("https://shop.test/agentpos/catalog"))).status,
    ).toBe(200);
    expect(agentposProxyPaths("/agentpos")).toEqual([
      "/.well-known/ucp",
      "/openapi.json",
      "/llms.txt",
      "/agentpos/",
    ]);
  });
});
