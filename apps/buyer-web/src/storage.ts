/**
 * Local storage on `node:sqlite` (built into Node >= 22.5, zero native dependencies), same
 * pattern as packages/site/src/storage.ts: rows keep a JSON document plus lookup columns.
 *
 * Three tables, three rules:
 *  - profiles: the buyer's mandate and linked wallet PUBLIC address. No secret ever.
 *  - proposals: pending / approved / rejected / expired purchase proposals.
 *  - activity: append-only. This class exposes insert and select for it, nothing else,
 *    so the history a buyer sees is the history that happened.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ActivityEntry, BuyerWebProfile, Proposal, ProposalStatus } from "./types.js";

type JsonRow = { json: string };
type ActivityRow = { seq: number; at: string; kind: string; json: string };

export class BuyerWebStorage {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    if (file !== ":memory:") this.db.exec("pragma journal_mode = WAL");
    this.db.exec(`
      create table if not exists profiles (id text primary key, json text not null, updated_at text not null);
      create table if not exists proposals (id text primary key, status text not null, json text not null, created_at text not null, updated_at text not null);
      create index if not exists proposals_status_idx on proposals(status);
      create table if not exists activity (seq integer primary key autoincrement, at text not null, kind text not null, json text not null);
    `);
  }

  close(): void {
    this.db.close();
  }

  // --- profile ---------------------------------------------------------------

  getProfile(id = "default"): BuyerWebProfile | undefined {
    const row = this.db.prepare("select json from profiles where id = ?").get(id) as
      JsonRow | undefined;
    return row ? (JSON.parse(row.json) as BuyerWebProfile) : undefined;
  }

  saveProfile(profile: BuyerWebProfile): void {
    this.db
      .prepare(
        "insert into profiles (id, json, updated_at) values (?, ?, ?) on conflict(id) do update set json = excluded.json, updated_at = excluded.updated_at",
      )
      .run(profile.id, JSON.stringify(profile), profile.updatedAt);
  }

  // --- proposals -------------------------------------------------------------

  getProposal(id: string): Proposal | undefined {
    const row = this.db.prepare("select json from proposals where id = ?").get(id) as
      JsonRow | undefined;
    return row ? (JSON.parse(row.json) as Proposal) : undefined;
  }

  saveProposal(proposal: Proposal): void {
    this.db
      .prepare(
        "insert into proposals (id, status, json, created_at, updated_at) values (?, ?, ?, ?, ?) on conflict(id) do update set status = excluded.status, json = excluded.json, updated_at = excluded.updated_at",
      )
      .run(
        proposal.id,
        proposal.status,
        JSON.stringify(proposal),
        proposal.createdAt,
        proposal.decidedAt ?? proposal.createdAt,
      );
  }

  /** Newest first. Without `status`, the full history. */
  listProposals(status?: ProposalStatus): Proposal[] {
    const rows = (
      status
        ? this.db
            .prepare("select json from proposals where status = ? order by created_at desc")
            .all(status)
        : this.db.prepare("select json from proposals order by created_at desc").all()
    ) as JsonRow[];
    return rows.map((r) => JSON.parse(r.json) as Proposal);
  }

  // --- activity (append-only) ------------------------------------------------

  appendActivity(
    kind: ActivityEntry["kind"],
    data: Record<string, unknown>,
    at = new Date().toISOString(),
  ): void {
    this.db
      .prepare("insert into activity (at, kind, json) values (?, ?, ?)")
      .run(at, kind, JSON.stringify(data));
  }

  /** Newest first, capped. */
  listActivity(limit = 200): ActivityEntry[] {
    const rows = this.db
      .prepare("select seq, at, kind, json from activity order by seq desc limit ?")
      .all(limit) as ActivityRow[];
    return rows.map((r) => ({
      seq: r.seq,
      at: r.at,
      kind: r.kind as ActivityEntry["kind"],
      data: JSON.parse(r.json) as Record<string, unknown>,
    }));
  }
}
