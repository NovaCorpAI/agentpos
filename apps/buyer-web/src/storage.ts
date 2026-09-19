/**
 * Local storage on `node:sqlite` (built into Node >= 22.5, zero native dependencies), same
 * pattern as packages/site/src/storage.ts: rows keep a JSON document plus lookup columns.
 *
 * Eight tables, eight rules:
 *  - profiles: the buyer's mandate and linked wallet PUBLIC address. No secret ever.
 *  - proposals: pending / approved / rejected / expired purchase proposals.
 *  - activity: append-only. This class exposes insert and select for it, nothing else,
 *    so the history a buyer sees is the history that happened.
 *  - owner_account: the one human this space belongs to. Password as a scrypt hash only.
 *  - sessions: server-side login rows. The cookie carries an id, never a claim.
 *  - access_log: append-only. Logins, refusals and approvals, by hash, for the owner to read.
 *  - recovery_codes: the printable codes, one row each, as scrypt hashes. Spending one is a
 *    single UPDATE guarded by `used_at is null`, so a replayed code loses the race by design.
 *  - recovery_challenges: at most one live WhatsApp code and one live operator token, also
 *    as scrypt hashes, with an expiry and an attempt counter.
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
  RecoveryChallenge,
  RecoveryChallengeKind,
  RecoveryCodeRecord,
  SessionRecord,
  SessionScope,
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
  scope: string;
};
type RecoveryCodeRow = {
  id: number;
  code_hash: string;
  created_at: string;
  used_at: string | null;
};
type RecoveryChallengeRow = {
  kind: string;
  code_hash: string;
  created_at: string;
  expires_at: string;
  attempts: number;
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

/** Anything that is not the string "recovery" is a full session: the safe way round. */
function scopeOf(raw: string): SessionScope {
  return raw === "recovery" ? "recovery" : "full";
}

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
      create table if not exists sessions (id text primary key, account_id text not null, csrf_token text not null, created_at text not null, expires_at text not null, last_seen_at text not null, ip_hash text not null, ua_family text not null, scope text not null default 'full');
      create index if not exists sessions_expires_idx on sessions(expires_at);
      create table if not exists access_log (seq integer primary key autoincrement, at text not null, event text not null, ip_hash text not null, ua_family text not null, email_hash text not null, detail text not null);
      create table if not exists recovery_codes (id integer primary key autoincrement, code_hash text not null, created_at text not null, used_at text);
      create table if not exists recovery_challenges (kind text primary key, code_hash text not null, created_at text not null, expires_at text not null, attempts integer not null default 0);
    `);
    // An installation created before recovery existed has a sessions table without `scope`.
    // Adding it here (rather than recreating the table) keeps the owner logged in across
    // the upgrade; every existing row is a full session, which is exactly the default.
    const columns = this.db.prepare("pragma table_info(sessions)").all() as Array<{
      name: string;
    }>;
    if (!columns.some((c) => c.name === "scope")) {
      this.db.exec("alter table sessions add column scope text not null default 'full'");
    }
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
        "insert into sessions (id, account_id, csrf_token, created_at, expires_at, last_seen_at, ip_hash, ua_family, scope) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        session.scope,
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
          scope: scopeOf(row.scope),
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

  /** Every session, gone: what a recovery (or a bootstrap that changes the owner) means. */
  deleteAllSessions(): void {
    this.db.prepare("delete from sessions").run();
  }

  /**
   * Every session but this one. What changing the password from inside the space means:
   * whoever else was in is out, and the person who just typed their password stays.
   */
  deleteOtherSessions(keepId: string): void {
    this.db.prepare("delete from sessions where id <> ?").run(keepId);
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

  // --- recovery codes --------------------------------------------------------
  // The printable codes. Only ever scrypt hashes here: a stolen database yields nothing a
  // thief could type back, and even the owner cannot read their own codes out of it.

  /** Replaces the whole set. Generating new codes retires every old one, spent or not. */
  replaceRecoveryCodes(hashes: string[], at: string): void {
    this.db.exec("begin");
    try {
      this.db.prepare("delete from recovery_codes").run();
      const insert = this.db.prepare(
        "insert into recovery_codes (code_hash, created_at, used_at) values (?, ?, null)",
      );
      for (const hash of hashes) insert.run(hash, at);
      this.db.exec("commit");
    } catch (err) {
      this.db.exec("rollback");
      throw err;
    }
  }

  /** The codes that can still be spent, oldest first. */
  listUnusedRecoveryCodes(): RecoveryCodeRecord[] {
    const rows = this.db
      .prepare("select * from recovery_codes where used_at is null order by id")
      .all() as RecoveryCodeRow[];
    return rows.map((r) => ({
      id: r.id,
      codeHash: r.code_hash,
      createdAt: r.created_at,
      usedAt: r.used_at ?? undefined,
    }));
  }

  /** How the account page says "you have 8 of 10 left" without showing a single code. */
  countRecoveryCodes(): { total: number; unused: number } {
    const row = this.db
      .prepare(
        "select count(*) as total, sum(case when used_at is null then 1 else 0 end) as unused from recovery_codes",
      )
      .get() as { total: number; unused: number | null };
    return { total: row.total, unused: row.unused ?? 0 };
  }

  /**
   * Spends one code. The `used_at is null` in the WHERE is the whole single-use guarantee:
   * two requests racing with the same code both run this UPDATE, and SQLite lets exactly
   * one of them change a row. The loser gets false and is refused like any wrong code.
   */
  consumeRecoveryCode(id: number, at: string): boolean {
    const result = this.db
      .prepare("update recovery_codes set used_at = ? where id = ? and used_at is null")
      .run(at, id);
    return Number(result.changes) === 1;
  }

  // --- recovery challenges ---------------------------------------------------
  // At most one live WhatsApp code and one live operator token, both as scrypt hashes.

  /** Stores (or replaces) the challenge of this kind. The previous one stops working. */
  putRecoveryChallenge(challenge: RecoveryChallenge): void {
    this.db
      .prepare(
        "insert into recovery_challenges (kind, code_hash, created_at, expires_at, attempts) values (?, ?, ?, ?, ?) on conflict(kind) do update set code_hash = excluded.code_hash, created_at = excluded.created_at, expires_at = excluded.expires_at, attempts = 0",
      )
      .run(
        challenge.kind,
        challenge.codeHash,
        challenge.createdAt,
        challenge.expiresAt,
        challenge.attempts,
      );
  }

  getRecoveryChallenge(kind: RecoveryChallengeKind): RecoveryChallenge | undefined {
    const row = this.db.prepare("select * from recovery_challenges where kind = ?").get(kind) as
      | RecoveryChallengeRow
      | undefined;
    return row
      ? {
          kind: row.kind === "operator" ? "operator" : "whatsapp",
          codeHash: row.code_hash,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          attempts: row.attempts,
        }
      : undefined;
  }

  /** Records a wrong guess and answers how many there have been. */
  bumpRecoveryChallengeAttempts(kind: RecoveryChallengeKind): number {
    this.db
      .prepare("update recovery_challenges set attempts = attempts + 1 where kind = ?")
      .run(kind);
    return this.getRecoveryChallenge(kind)?.attempts ?? 0;
  }

  /**
   * Spends the challenge: the row is gone, so a replay of the same code or URL finds
   * nothing. Atomic for the same reason consumeRecoveryCode is.
   */
  consumeRecoveryChallenge(kind: RecoveryChallengeKind): boolean {
    const result = this.db.prepare("delete from recovery_challenges where kind = ?").run(kind);
    return Number(result.changes) === 1;
  }

  deleteRecoveryChallenge(kind: RecoveryChallengeKind): void {
    this.db.prepare("delete from recovery_challenges where kind = ?").run(kind);
  }
}
