/**
 * Append-only spending log per profile (SPEC 02 / SPEC 06 layer D). One JSON line per payment.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { addUsdc, usdcFromMinor } from "@agentpos/core";
import type { UsdcMinor } from "@agentpos/core";
import { profilesDir } from "./profile.js";

export interface SpendingEntry {
  ts: string;
  profile: string;
  site: string;
  cartId: string;
  orderId: string;
  txHash: string;
  network: string;
  asset: string;
  /**
   * In the catalog's unit (USDC, 7 decimals) whatever network paid, so one sum covers every
   * network and the period limit cannot be dodged by spreading payments across them (M2).
   */
  amountMinor: string;
  summary: string;
}

export function spendingLogPath(profile: string): string {
  return join(profilesDir(), `${profile}.spending.jsonl`);
}

export class SpendingLog {
  constructor(private readonly file: string) {}

  static forProfile(profile: string): SpendingLog {
    return new SpendingLog(spendingLogPath(profile));
  }

  append(entry: SpendingEntry): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
  }

  entries(since?: Date): SpendingEntry[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SpendingEntry)
      .filter((e) => !since || new Date(e.ts) >= since);
  }

  totalSince(since: Date): UsdcMinor {
    return this.entries(since).reduce(
      (acc, e) => addUsdc(acc, usdcFromMinor(e.amountMinor)),
      usdcFromMinor(0n),
    );
  }
}
