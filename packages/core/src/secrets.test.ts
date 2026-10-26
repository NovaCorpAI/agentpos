import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { assertNoSecretsInConfig } from "./config.js";
import { AgentPOSError } from "./errors.js";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof AgentPOSError ? err.code : "NOT_AGENTPOS_ERROR";
  }
  return undefined;
}

describe("zero custody at startup", () => {
  it("refuses a Stellar secret seed anywhere in the config", () => {
    expect(
      codeOf(() => assertNoSecretsInConfig({ wallet: { payTo: Keypair.random().secret() } })),
    ).toBe("SECRET_IN_CONFIG");
  });

  it("refuses an EVM private key anywhere in the config, and says where", () => {
    const key = `0x${randomBytes(32).toString("hex")}`;
    try {
      assertNoSecretsInConfig({ rails: [{ arc: { payTo: key } }] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AgentPOSError);
      expect((err as AgentPOSError).code).toBe("SECRET_IN_CONFIG");
      expect((err as AgentPOSError).details).toEqual({ path: "rails[0].arc.payTo" });
    }
  });

  it("accepts public addresses on both families", () => {
    expect(() =>
      assertNoSecretsInConfig({
        stellar: Keypair.random().publicKey(),
        arc: "0x3600000000000000000000000000000000000000",
      }),
    ).not.toThrow();
  });
});
