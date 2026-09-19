/**
 * Local storage on `node:sqlite` (built into Node >= 22.5, zero native dependencies), same
 * pattern as packages/site/src/storage.ts: rows keep a JSON document plus lookup columns.
 *
 * Six tables, six rules:
 *  - profiles: the buyer's mandate and linked wallet PUBLIC address. No secret ever.
 *  - proposals: pending / approved / rejected / expired purchase proposals.
 *  - activity: append-only. This class exposes insert and select for it, nothing else,
 *    so the history a buyer sees is the history that happened.
 *  - owner_account: the one human this space belongs to. Password as a scrypt hash only.
 *  - sessions: server-side login rows. The cookie carries an id, never a claim.
 *  - access_log: append-only. Logins, refusals and approvals, by hash, for the owner to read.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AccessEntry,
  ActivityEntry,
  BuyerWebProfile,
  OwnerAccount,
  Proposal,
  ProposalStatus,
  SessionRecord,
} from "./types.js";

type JsonRow = { json: string };
type ActivityRow = { seq: number; at: string; kind: string; json: string };
type OwnerRow = {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
};
type SessionRow = {
  id: string;
  account_id: string;
  csrf_token: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  ip_hash: string;
  ua_family: string;
};
type AccessRow = {
  seq: number;
  at: string;
  event: string;
  ip_hash: string;
  ua_family: string;
  email_hash: string;
  detail: string;
};

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
      create table if not exists owner_account (id text primary key, email text not null, password_hash text not null, created_at text not null, updated_at text not null);
      create table if not exists sessions (id text primary key, account_id text not null, csrf_token text not null, created_at text not null, expires_at text not null, last_seen_at text not null, ip_hash text not null, ua_family text not null);
      create index if not exists sessions_expires_idx on sessions(expires_at);
      create table if not exists access_log (seq integer primary key autoincrement, at text not null, event text not null, ip_hash text not null, ua_family text not null, email_hash text not null, detail text not null);
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

  // --- owner account ---------------------------------------------------------
  // Single tenant: at most one row, id "owner". Only ever a scrypt hash, never a password.

  getOwner(): OwnerAccount | undefined {
    const row = this.db.prepare("select * from owner_account where id = 'owner'").get() as
      | OwnerRow
      | undefined;
    return row
      ? {
          id: row.id,
          email: row.email,
          passwordHash: row.password_hash,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  saveOwner(account: OwnerAccount): void {
    this.db
      .prepare(
        "insert into owner_account (id, email, password_hash, created_at, updated_at) values (?, ?, ?, ?, ?) on conflict(id) do update set email = excluded.email, password_hash = excluded.password_hash, updated_at = excluded.updated_at",
      )
      .run(
        account.id,
        account.email,
        account.passwordHash,
        account.createdAt,
        account.updatedAt,
      );
  }

  // --- sessions --------------------------------------------------------------

  createSession(session: SessionRecord): void {
    this.db
      .prepare(
        "insert into sessions (id, account_id, csrf_token, created_at, expires_at, last_seen_at, ip_hash, ua_family) values (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        session.id,
        session.accountId,
        session.csrfToken,
        session.createdAt,
        session.expiresAt,
        session.lastSeenAt,
        session.ipHash,
        session.uaFamily,
      );
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.db.prepare("select * from sessions where id = ?").get(id) as
      | SessionRow
      | undefined;
    return row
      ? {
          id: row.id,
          accountId: row.account_id,
          csrfToken: row.csrf_token,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          lastSeenAt: row.last_seen_at,
          ipHash: row.ip_hash,
          uaFamily: row.ua_family,
        }
      : undefined;
  }

  /** Slides the expiry forward on use. */
  touchSession(id: string, expiresAt: string, lastSeenAt: string): void {
    this.db
      .prepare("update sessions set expires_at = ?, last_seen_at = ? where id = ?")
      .run(expiresAt, lastSeenAt, id);
  }

  deleteSession(id: string): void {
    this.db.prepare("delete from sessions where id = ?").run(id);
  }

  /** Every session, gone: what a password change (or a bootstrap that changes it) means. */
  deleteAllSessions(): void {
    this.db.prepare("delete from sessions").run();
  }

  /** Housekeeping: rows past their expiry are of no use to anyone. */
  deleteExpiredSessions(now: string): void {
    this.db.prepare("delete from sessions where expires_at <= ?").run(now);
  }

  // --- access log (append-only) ----------------------------------------------

  appendAccess(entry: Omit<AccessEntry, "seq">): void {
    this.db
      .prepare(
        "insert into access_log (at, event, ip_hash, ua_family, email_hash, detail) values (?, ?, ?, ?, ?, ?)",
      )
      .run(entry.at, entry.event, entry.ipHash, entry.uaFamily, entry.emailHash, entry.detail);
  }

  /** Newest first, capped. */
  listAccess(limit = 40): AccessEntry[] {
    const rows = this.db
      .prepare("select * from access_log order by seq desc limit ?")
      .all(limit) as AccessRow[];
    return rows.map((r) => ({
      seq: r.seq,
      at: r.at,
      event: r.event as AccessEntry["event"],
      ipHash: r.ip_hash,
      uaFamily: r.ua_family,
      emailHash: r.email_hash,
      detail: r.detail,
    }));
  }
}
