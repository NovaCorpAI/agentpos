/**
 * The shapes of the three things that can get an owner back into their own space: the
 * printable recovery codes, the six-digit WhatsApp code and the operator's one-time token.
 *
 * Why this file exists on its own: every one of these is a secret that is shown once and
 * then only ever compared against a scrypt hash, so the generation rules (alphabet, length,
 * entropy source) are worth reading in one place. Everything here comes from
 * `crypto.randomBytes`; nothing here is ever logged.
 */
import { randomBytes } from "node:crypto";

/**
 * 32 symbols, so one random byte maps to one symbol with no bias (`byte & 31`), and none of
 * them can be misread: no I, no O, no 0, no 1. A code is meant to be copied off a screen
 * onto paper and typed back months later.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** How many codes a set has. Ten is enough for years of the rare case this is for. */
export const RECOVERY_CODE_COUNT = 10;

const GROUPS = 3;
const GROUP_LENGTH = 4;
const CODE_LENGTH = GROUPS * GROUP_LENGTH;

/** One code, e.g. `ABCD-EFGH-JKLM`: 12 symbols out of 32, 60 bits. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let group = "";
    for (let i = 0; i < GROUP_LENGTH; i++) {
      const byte = bytes[g * GROUP_LENGTH + i] ?? 0;
      group += ALPHABET[byte & 31] ?? "A";
    }
    groups.push(group);
  }
  return groups.join("-");
}

/** A fresh set. Generating a set always replaces the previous one, never extends it. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => generateRecoveryCode());
}

/**
 * What the owner typed reduced to the canonical `ABCD-EFGH-JKLM`, or "" when it cannot be a
 * code at all. Spaces, dashes and lower case are forgiven because a code travels through
 * paper and phone keyboards; an out-of-alphabet symbol is not, since it can only be a typo.
 */
export function normalizeRecoveryCode(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length !== CODE_LENGTH) return "";
  for (const ch of cleaned) if (!ALPHABET.includes(ch)) return "";
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    groups.push(cleaned.slice(g * GROUP_LENGTH, (g + 1) * GROUP_LENGTH));
  }
  return groups.join("-");
}

/** True for the six digits of a WhatsApp code, which `/recuperar` tells apart from a code. */
export function isWhatsAppCode(raw: string): boolean {
  return /^\d{6}$/.test(raw.replace(/[\s-]/g, ""));
}

export function normalizeWhatsAppCode(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}

/** Six digits, uniform, from randomBytes. Short-lived and attempt-capped by the caller. */
export function generateWhatsAppCode(): string {
  // Rejection sampling on a 32-bit draw: the tiny bias of a plain modulo is free to avoid.
  const limit = 1_000_000;
  const max = Math.floor(0xffffffff / limit) * limit;
  for (;;) {
    const n = randomBytes(4).readUInt32BE(0);
    if (n < max) return String(n % limit).padStart(6, "0");
  }
}

/** The operator's URL token: 32 random bytes, hex, single use, fifteen minutes. */
export function generateOperatorToken(): string {
  return randomBytes(32).toString("hex");
}

/** True for something shaped like an operator token, before any database work is done. */
export function isOperatorToken(raw: string): boolean {
  return /^[0-9a-f]{64}$/.test(raw.trim());
}
