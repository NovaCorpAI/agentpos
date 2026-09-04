/**
 * The generated config must be valid by construction: whatever this module emits, the sidecar's
 * own `siteConfigSchema` accepts. And the .env must mirror the onboarding guide, with the Woo
 * keys the merchant typed (or placeholders) and testnet as the default network.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { AgentPOSError } from "@agentpos/core";
import { siteConfigSchema } from "@agentpos/site";
import { generateFiles } from "./generate.js";

const payTo = Keypair.random().publicKey();

const wooRequest = {
  siteUrl: "https://shop.example",
  displayName: "Faro Store",
  payTo,
  platform: "woocommerce" as const,
  wooBaseUrl: "https://wp.shop.example",
  wooConsumerKey: "ck_abc123",
  wooConsumerSecret: "cs_def456",
};

describe("generateFiles", () => {
  it("emits a config that siteConfigSchema accepts, with the fields the merchant gave", () => {
    const out = generateFiles(wooRequest);
    expect(out.files.config.filename).toBe("agentpos.config.json");
    const parsed = siteConfigSchema.parse(JSON.parse(out.files.config.content));
    expect(parsed.siteUrl).toBe("https://shop.example");
    expect(parsed.displayName).toBe("Faro Store");
    expect(parsed.payTo).toBe(payTo);
    expect(parsed.platform).toBe("woocommerce");
    expect(parsed.woocommerce?.baseUrl).toBe("https://wp.shop.example");
    // Defaults applied by the schema, proving the sidecar can run this file as-is.
    expect(parsed.basePath).toBe("/agentpos");
  });

  it("puts the typed Woo keys into .env (returned to the merchant, stored nowhere)", () => {
    const env = generateFiles(wooRequest).files.env.content;
    expect(env).toContain("AGENTPOS_WOO_CONSUMER_KEY=ck_abc123");
    expect(env).toContain("AGENTPOS_WOO_CONSUMER_SECRET=cs_def456");
    expect(env).toContain("AGENTPOS_NETWORK=testnet");
    expect(env).toContain("AGENTPOS_FACILITATOR_API_KEY=");
    // Mainnet only as a commented, deliberate step.
    expect(env).toContain("# AGENTPOS_NETWORK=mainnet");
    expect(env).not.toMatch(/^AGENTPOS_NETWORK=mainnet/m);
  });

  it("uses placeholders when the keys were not typed, and defaults wooBaseUrl to siteUrl", () => {
    const out = generateFiles({
      siteUrl: "https://shop.example",
      displayName: "Faro Store",
      payTo,
      platform: "woocommerce",
    });
    expect(out.files.env.content).toContain("AGENTPOS_WOO_CONSUMER_KEY=ck_...");
    const config = JSON.parse(out.files.config.content) as { woocommerce: { baseUrl: string } };
    expect(config.woocommerce.baseUrl).toBe("https://shop.example");
  });

  it("omits the Woo block entirely for the custom-hook platform", () => {
    const out = generateFiles({
      siteUrl: "https://shop.example",
      displayName: "Faro Store",
      payTo,
      platform: "generic",
    });
    expect(out.files.config.content).not.toContain("woocommerce");
    expect(out.files.env.content).not.toContain("AGENTPOS_WOO");
    expect(siteConfigSchema.parse(JSON.parse(out.files.config.content)).platform).toBe("generic");
  });

  it("refuses a secret key as payTo with SECRET_IN_CONFIG, before anything is generated", () => {
    expect(() => generateFiles({ ...wooRequest, payTo: Keypair.random().secret() })).toThrowError(
      expect.objectContaining({ code: "SECRET_IN_CONFIG" }) as AgentPOSError,
    );
  });

  it("mirrors the onboarding guide: proxy snippets and the four next commands", () => {
    const out = generateFiles(wooRequest);
    for (const path of ["/.well-known/ucp", "/agentpos/", "/openapi.json", "/llms.txt"]) {
      expect(out.proxy.nginx).toContain(path);
    }
    expect(out.proxy.nginx).toContain("proxy_pass http://127.0.0.1:8402");
    expect(out.proxy.caddy).toContain("reverse_proxy http://127.0.0.1:8402");
    expect(out.commands).toEqual([
      "npx agentpos scan",
      "npx agentpos confirm",
      "npx agentpos publish",
      "npx agentpos serve",
    ]);
  });
});
