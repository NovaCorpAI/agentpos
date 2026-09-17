/**
 * Profile loading, including the gentle migration of mandates written before a mode was retired.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Keypair } from "@stellar/stellar-sdk";
import { AgentPOSError } from "@agentpos/core";
import { loadProfile, loadProfileWithWarnings, profilePath, profilesDir } from "./profile.js";

function writeProfile(name: string, allowedSellers: unknown): string {
  mkdirSync(profilesDir(), { recursive: true });
  const file = profilePath(name);
  writeFileSync(
    file,
    JSON.stringify({
      name,
      network: "testnet",
      keyFile: `buyer-${name}`,
      address: Keypair.random().publicKey(),
      mandate: { maxPerTx: "10", maxTotal: "25", allowedSellers },
      sites: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  return file;
}

describe("buyer profiles", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agentpos-profile-"));
    process.env.AGENTPOS_HOME = home;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.AGENTPOS_HOME;
  });

  it("loads a current profile without warnings", () => {
    writeProfile("plain", ["shop.test"]);
    const loaded = loadProfileWithWarnings("plain");
    expect(loaded.profile.mandate.allowedSellers).toEqual(["shop.test"]);
    expect(loaded.warnings).toEqual([]);
  });

  it("loads a verified-only profile as an explicit empty allowlist, and explains it", () => {
    const file = writeProfile("legacy", "verified-only");
    const loaded = loadProfileWithWarnings("legacy");

    // Same behaviour as before (it refuses every site), now for a legible reason.
    expect(loaded.profile.mandate.allowedSellers).toEqual([]);
    expect(loaded.warnings).toHaveLength(1);
    const warning = loaded.warnings[0];
    expect(warning?.code).toBe("MANDATE_MODE_RETIRED");
    expect(warning?.message).toContain("verified-only");
    expect(warning?.hint).toContain('"any"');
    expect(warning?.details).toMatchObject({ file });

    // The file on disk is the human's: nothing rewrote it behind their back.
    expect(loadProfile("legacy").mandate.allowedSellers).toEqual([]);
  });

  it("still refuses a profile that is invalid for other reasons", () => {
    writeProfile("broken", 42);
    expect(() => loadProfile("broken")).toThrow(AgentPOSError);
  });
});
