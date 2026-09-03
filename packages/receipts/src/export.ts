/**
 * Audit trail export (M4). What a merchant hands to an accountant, a bank or a court: the
 * receipts for a period, the verification verdict, and a summary that does not require reading
 * JSON to understand.
 *
 * The export carries the verification result rather than asserting the trail is good. An export
 * that quietly hid a broken link would be worse than no export at all.
 */
import { formatUsdc, usdcFromMinor } from "@agentpos/core";
import type { Receipt, ReceiptEvent } from "./types.js";
import { verifyChain } from "./verify.js";
import type { VerificationResult } from "./verify.js";

export interface AuditTrail {
  v: string;
  store: { name: string; url: string; signer: string } | undefined;
  period: { from: string | undefined; to: string | undefined };
  generatedAt: string;
  /** Verification of exactly the receipts in this export. */
  verification: VerificationResult;
  summary: {
    receipts: number;
    firstSeq: number | undefined;
    lastSeq: number | undefined;
    events: Record<string, number>;
    settled: { orders: number; totalMinor: string; total: string };
    held: number;
    denied: number;
    /** Distinct authenticated agent keys that appear in the period. */
    agents: number;
  };
  receipts: Receipt[];
}

export interface ExportOptions {
  from?: string;
  to?: string;
  limit?: number;
}

export interface AuditSource {
  list(options?: ExportOptions): Receipt[];
}

export function exportAuditTrail(source: AuditSource, options: ExportOptions = {}): AuditTrail {
  const receipts = source.list(options);
  const events: Record<string, number> = {};
  let settledOrders = 0;
  let settledTotal = 0n;
  let held = 0;
  let denied = 0;
  const agents = new Set<string>();

  for (const r of receipts) {
    const event: ReceiptEvent = r.body.event;
    events[event] = (events[event] ?? 0) + 1;
    if (event === "order.settled") {
      settledOrders += 1;
      settledTotal += BigInt(r.body.payment?.amountMinor ?? r.body.terms?.totalMinor ?? "0");
    }
    if (event === "order.held") held += 1;
    if (event === "policy.denied") denied += 1;
    if (r.body.agent?.agentKey) agents.add(r.body.agent.agentKey);
  }

  const first = receipts[0];
  const last = receipts[receipts.length - 1];
  return {
    v: "agentpos-audit-1",
    store: first?.body.store,
    period: { from: options.from, to: options.to },
    generatedAt: new Date().toISOString(),
    verification: verifyChain(receipts),
    summary: {
      receipts: receipts.length,
      firstSeq: first?.body.seq,
      lastSeq: last?.body.seq,
      events,
      settled: {
        orders: settledOrders,
        totalMinor: settledTotal.toString(),
        total: formatUsdc(usdcFromMinor(settledTotal)),
      },
      held,
      denied,
      agents: agents.size,
    },
    receipts,
  };
}

/** The same trail as text, for a human who will not open a JSON file. */
export function formatAuditTrail(trail: AuditTrail): string {
  const lines: string[] = [];
  const period =
    trail.period.from || trail.period.to
      ? `${trail.period.from ?? "start"} to ${trail.period.to ?? "now"}`
      : "all receipts";
  lines.push(`AgentPOS audit trail: ${trail.store?.name ?? "unknown store"} (${period})`);
  if (trail.store) lines.push(`Store signing key: ${trail.store.signer}`);
  lines.push(
    `Receipts: ${trail.summary.receipts}` +
      (trail.summary.firstSeq
        ? ` (chain positions ${trail.summary.firstSeq} to ${trail.summary.lastSeq})`
        : ""),
  );
  lines.push(
    trail.verification.valid
      ? "Verification: PASS. Every receipt is signed by the store key, and the chain is unbroken."
      : `Verification: FAIL, ${trail.verification.issues.length} issue(s):`,
  );
  for (const issue of trail.verification.issues)
    lines.push(`  - [${issue.code}] ${issue.message}${issue.seq ? ` (receipt #${issue.seq})` : ""}`);
  lines.push("");
  lines.push(
    `Settled orders: ${trail.summary.settled.orders} for ${trail.summary.settled.total} USDC`,
  );
  lines.push(`Orders held for review: ${trail.summary.held}`);
  lines.push(`Sales refused by policy: ${trail.summary.denied}`);
  lines.push(`Distinct identified agents: ${trail.summary.agents}`);
  lines.push("");
  for (const r of trail.receipts) {
    const total = r.body.terms ? `${formatUsdc(usdcFromMinor(BigInt(r.body.terms.totalMinor)))} USDC` : "";
    const who = r.body.agent?.agentKey ? ` agent ${r.body.agent.agentKey.slice(0, 8)}...` : "";
    const tx = r.body.payment ? ` tx ${r.body.payment.txHash}` : "";
    lines.push(
      `#${r.body.seq} ${r.body.at} ${r.body.event}${r.body.order ? ` order ${r.body.order.id}` : ""} ${total}${who}${tx}`,
    );
  }
  return lines.join("\n");
}
