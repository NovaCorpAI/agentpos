import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { resolveConfig } from "../config.js";
import {
  FAMILY_ADDRESS_CHECKS,
  registerChainProfile,
  resetChainProfilesForTests,
  usdcOnChain,
} from "../chain.js";
import { AgentPOSError } from "../errors.js";
import { usdc } from "../money.js";
import {
  assertNetworkAllowed,
  buildRouteConfig,
  checkNetworkFacilitators,
  createResourceServer,
  healthyOnly,
} from "./x402.js";
import type { FacilitatorClient, SchemeNetworkServer } from "./x402.js";

const ARC_TESTNET = "eip155:5042002";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const MERCHANT_EVM = "0x1111111111111111111111111111111111111111";

const stubFacilitator = {
  verify: async () => ({ isValid: true }),
  settle: async () => ({ success: true, transaction: "0x", network: ARC_TESTNET }),
  getSupported: async () => ({ kinds: [], extensions: [], signers: {} }),
} as unknown as FacilitatorClient;

const stubScheme = { scheme: "exact" } as unknown as SchemeNetworkServer;

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof AgentPOSError ? err.code : "NOT_AGENTPOS_ERROR";
  }
  return undefined;
}

beforeEach(() =>
  registerChainProfile({
    caip2: ARC_TESTNET,
    family: "eip155",
    label: "Arc testnet",
    testnet: true,
    usdcDecimals: 6,
    isValidAddress: FAMILY_ADDRESS_CHECKS.eip155,
  }),
);
afterEach(() => resetChainProfilesForTests());

describe("x402 on more than one network", () => {
  const cfg = resolveConfig();
  const terms = { payTo: Keypair.random().publicKey(), amount: usdc("1.5"), reference: "cart_1" };

  it("keeps Stellar as the first option and adds the extra network with its own unit", () => {
    const route = buildRouteConfig(cfg, terms, [
      {
        network: ARC_TESTNET,
        payTo: MERCHANT_EVM,
        asset: ARC_USDC,
        amount: usdcOnChain(terms.amount, ARC_TESTNET),
      },
    ]);
    const accepts = route.accepts as Array<{ network: string; price: { amount: string } }>;
    expect(accepts.map((a) => a.network)).toEqual([cfg.caip2, ARC_TESTNET]);
    expect(accepts[0]?.price.amount).toBe("15000000");
    expect(accepts[1]?.price.amount).toBe("1500000");
  });

  it("refuses a Stellar-unit amount on a 6-decimal network", () => {
    expect(
      codeOf(() =>
        buildRouteConfig(cfg, terms, [
          {
            network: ARC_TESTNET,
            payTo: MERCHANT_EVM,
            asset: ARC_USDC,
            amount: { minor: 15_000_000n, currency: "USDC", decimals: 7 },
          },
        ]),
      ),
    ).toBe("INVALID_AMOUNT");
  });

  it("refuses a receiving address that does not belong to that network", () => {
    expect(
      codeOf(() =>
        buildRouteConfig(cfg, terms, [
          {
            network: ARC_TESTNET,
            payTo: terms.payTo,
            asset: ARC_USDC,
            amount: usdcOnChain(terms.amount, ARC_TESTNET),
          },
        ]),
      ),
    ).toBe("ADDRESS_INVALID");
  });

  it("wires a rail's scheme and facilitator only for registered networks", () => {
    expect(() =>
      createResourceServer(cfg, stubFacilitator, [
        { network: ARC_TESTNET, server: stubScheme, facilitator: stubFacilitator },
      ]),
    ).not.toThrow();
    expect(
      codeOf(() =>
        createResourceServer(cfg, stubFacilitator, [
          { network: "eip155:8453", server: stubScheme, facilitator: stubFacilitator },
        ]),
      ),
    ).toBe("CHAIN_UNKNOWN");
  });
});

describe("guardrail 2 on extra networks", () => {
  const ARC_MAINNET = "eip155:5042";
  beforeEach(() =>
    registerChainProfile({
      caip2: ARC_MAINNET,
      family: "eip155",
      label: "Arc",
      testnet: false,
      usdcDecimals: 6,
      isValidAddress: FAMILY_ADDRESS_CHECKS.eip155,
    }),
  );

  it("never lets a testnet store charge on a mainnet", () => {
    expect(codeOf(() => assertNetworkAllowed(resolveConfig(), ARC_MAINNET))).toBe("CONFIG_INVALID");
  });

  it("never lets a mainnet store charge on a testnet", () => {
    const main = resolveConfig({
      network: "mainnet",
      allowMainnet: true,
      rpcUrl: "https://rpc.example",
    });
    expect(codeOf(() => assertNetworkAllowed(main, ARC_TESTNET))).toBe("CONFIG_INVALID");
  });

  it("keeps a new mainnet locked until its own gate closes, even with the flag", () => {
    const main = resolveConfig({
      network: "mainnet",
      allowMainnet: true,
      rpcUrl: "https://rpc.example",
    });
    expect(codeOf(() => assertNetworkAllowed(main, ARC_MAINNET))).toBe("MAINNET_NOT_CONFIRMED");
    expect(() => assertNetworkAllowed(main, "stellar:pubnet")).not.toThrow();
  });

  it("applies the gate to every entry point", () => {
    const cfg = resolveConfig();
    expect(
      codeOf(() =>
        createResourceServer(cfg, stubFacilitator, [
          { network: ARC_MAINNET, server: stubScheme, facilitator: stubFacilitator },
        ]),
      ),
    ).toBe("CONFIG_INVALID");
    expect(
      codeOf(() =>
        buildRouteConfig(cfg, { payTo: Keypair.random().publicKey(), amount: usdc("1") }, [
          {
            network: ARC_MAINNET,
            payTo: MERCHANT_EVM,
            asset: ARC_USDC,
            amount: usdcOnChain(usdc("1"), ARC_MAINNET),
          },
        ]),
      ),
    ).toBe("CONFIG_INVALID");
  });
});

describe("facilitator health per network", () => {
  const facilitatorWith = (impl: () => Promise<unknown>) =>
    ({ ...stubFacilitator, getSupported: impl }) as unknown as FacilitatorClient;

  it("reports each network on its own and degrades to the healthy ones", async () => {
    registerChainProfile({
      caip2: "eip155:84532",
      family: "eip155",
      label: "Base Sepolia",
      testnet: true,
      usdcDecimals: 6,
      isValidAddress: FAMILY_ADDRESS_CHECKS.eip155,
    });
    const health = await checkNetworkFacilitators(
      [
        {
          network: ARC_TESTNET,
          server: stubScheme,
          facilitator: facilitatorWith(async () => ({
            kinds: [{ x402Version: 2, scheme: "exact", network: ARC_TESTNET }],
          })),
        },
        {
          network: "eip155:84532",
          server: stubScheme,
          facilitator: facilitatorWith(async () => {
            throw new Error("503");
          }),
        },
      ],
      1_000,
    );
    expect(health.map((h) => [h.network, h.ok])).toEqual([
      [ARC_TESTNET, true],
      ["eip155:84532", false],
    ]);
    const options = [{ network: ARC_TESTNET }, { network: "eip155:84532" }];
    expect(healthyOnly(options, health)).toEqual([{ network: ARC_TESTNET }]);
  });

  it("marks a facilitator that does not settle this network as unhealthy, and times out", async () => {
    const [wrongNetwork] = await checkNetworkFacilitators([
      {
        network: ARC_TESTNET,
        server: stubScheme,
        facilitator: facilitatorWith(async () => ({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:1" }],
        })),
      },
    ]);
    expect(wrongNetwork?.supportsNetwork).toBe(false);
    const [slow] = await checkNetworkFacilitators(
      [
        {
          network: ARC_TESTNET,
          server: stubScheme,
          facilitator: facilitatorWith(() => new Promise(() => {})),
        },
      ],
      50,
    );
    expect(slow?.ok).toBe(false);
    expect(slow?.error).toContain("timeout");
  });
});
