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
import { buildRouteConfig, createResourceServer } from "./x402.js";
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
