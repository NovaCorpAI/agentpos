import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { buildAcpFeed, fiatToMinorUnits } from "./acp.js";
import {
  schemasDir,
  validateAcpProductsResponse,
  validateUcpBusinessProfile,
} from "./conformance.js";
import { buildUcpProfile } from "./ucp.js";

const profile = buildUcpProfile({
  siteUrl: "https://shop.example",
  basePath: "/agentgate",
  network: "stellar:testnet",
  asset: "USDC",
  assetAddress: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: Keypair.random().publicKey(),
  policies: { shipping: "Ships worldwide", cancellation: "24h" },
});

describe("conformance: UCP business profile", () => {
  it("accepts the official scaffold example (validator sanity check)", () => {
    const scaffold = JSON.parse(
      readFileSync(join(schemasDir(), "ucp", "example.profile_response.json"), "utf8"),
    );
    const result = validateUcpBusinessProfile(scaffold);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("validates the profile we emit", () => {
    const result = validateUcpBusinessProfile(profile);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("uses reverse-domain registry keys and YYYY-MM-DD versions", () => {
    expect(Object.keys(profile.ucp.services)).toEqual(["com.novacorplabs.agentgate"]);
    expect(Object.keys(profile.ucp.payment_handlers)).toEqual(["org.x402.stellar"]);
    expect(profile.ucp.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(profile.ucp.payment_handlers["org.x402.stellar"]?.[0]?.config.checkout).toBe(
      "https://shop.example/agentgate/checkout",
    );
  });

  it("rejects a broken profile", () => {
    const broken = JSON.parse(JSON.stringify(profile)) as { ucp: Record<string, unknown> };
    delete broken.ucp.payment_handlers;
    (broken.ucp as { version: string }).version = "v1";
    const result = validateUcpBusinessProfile(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("conformance: ACP product feed", () => {
  it("accepts the official example response (validator sanity check)", () => {
    const examples = JSON.parse(
      readFileSync(join(schemasDir(), "acp", "examples.feed.json"), "utf8"),
    ) as Record<string, unknown>;
    const result = validateAcpProductsResponse(examples.get_products_response);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("validates the feed we emit, with fiat prices in minor units", () => {
    const feed = buildAcpFeed([
      {
        id: "mug",
        title: "Ceramic Mug",
        description: "350 ml",
        url: "https://shop.example/mug",
        imageUrl: "https://shop.example/mug.jpg",
        priceSrc: { amount: "9.90", currency: "USD" },
        available: true,
      },
      {
        id: "ebook",
        title: "E-book",
        description: "",
        url: "https://shop.example/ebook",
        available: false,
      },
    ]);
    expect(feed.products[0]?.variants[0]?.price).toEqual({ amount: 990, currency: "USD" });
    expect(feed.products[1]?.variants[0]?.availability.status).toBe("out_of_stock");
    const result = validateAcpProductsResponse(feed);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("converts fiat to ISO minor units without floats", () => {
    expect(fiatToMinorUnits({ amount: "1,234.5", currency: "USD" })).toEqual({
      amount: 123450,
      currency: "USD",
    });
    expect(fiatToMinorUnits({ amount: "1500", currency: "JPY" })).toEqual({
      amount: 1500,
      currency: "JPY",
    });
    expect(fiatToMinorUnits({ amount: "9.999", currency: "USD" })).toEqual({
      amount: 999,
      currency: "USD",
    });
    expect(fiatToMinorUnits({ amount: "1.5", currency: "KWD" })).toEqual({
      amount: 1500,
      currency: "KWD",
    });
    expect(() => fiatToMinorUnits({ amount: "1", currency: "USDC" })).toThrow(/ISO 4217/);
  });
});
