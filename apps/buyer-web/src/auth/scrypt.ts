/**
 * Password hashing with node:crypto scrypt. No auth dependency, nothing custom: a unique
 * random salt per account, a constant-time compare, and the parameters stored next to the
 * hash so they can be raised later without invalidating existing hashes.
 *
 * Same format as agentpos-cloud (`src/lib/auth/scrypt.ts`), on purpose: one hash string
 * works in both surfaces and an operator only has to learn one thing.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

/** `scrypt$N$r$p$<salt b64>$<hash b64>`: what a stored or bootstrapped hash looks like. */
export const SCRYPT_HASH_RE = /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEYLEN, { N: n, r, p }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** Hashes a password with a fresh random salt. The plaintext never leaves this call. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, N, R, P);
  return [
    "scrypt",
    String(N),
    String(R),
    String(P),
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

/** Constant-time verify against a stored hash; false for a malformed hash, never throws. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const expected = Buffer.from(hashB64, "base64");
  if (expected.length !== KEYLEN) return false;
  try {
    const actual = await derive(password, Buffer.from(saltB64, "base64"), n, r, p);
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;

/**
 * A real hash of an unknowable password, verified against when the email has no account, so
 * a login against an unknown email costs the same time as one against the owner's. Built on
 * first use: importing this module must not cost a key derivation.
 */
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(32).toString("hex"));
  return dummy;
}
