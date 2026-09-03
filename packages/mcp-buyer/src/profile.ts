/**
 * Buyer profiles (SPEC 07): ~/.agentpos/profiles/<name>.json holds wallet reference, mandate,
 * network, optional shipping/contact and known sites. Secrets never live here: the keypair is
 * an encrypted file under ~/.agentpos/keys, unlocked with AGENTPOS_BUYER_PASSPHRASE.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AgentPOSError, addressSchema, buyerContactSchema } from "@agentpos/core";
import { mandateSchema } from "./mandate.js";

export function agentposHome(): string {
  return process.env.AGENTPOS_HOME ?? join(homedir(), ".agentpos");
}

export function profilesDir(): string {
  return join(agentposHome(), "profiles");
}

export const profileSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/),
  network: z.enum(["testnet", "mainnet"]).default("testnet"),
  /** Name of the encrypted key file under ~/.agentpos/keys (without .json). */
  keyFile: z.string().min(1),
  /** Public address, kept for display; the truth is the key file. */
  address: z.string().regex(/^G[A-Z2-7]{55}$/),
  mandate: mandateSchema,
  buyer: buyerContactSchema.optional(),
  shipping: addressSchema.optional(),
  /** Store URLs the agent may search by default. */
  sites: z.array(z.url()).default([]),
  createdAt: z.string(),
});

export type ProfileJson = z.input<typeof profileSchema>;
export type Profile = z.output<typeof profileSchema>;

export function profilePath(name: string): string {
  return join(profilesDir(), `${name}.json`);
}

export function loadProfile(name: string): Profile {
  const file = profilePath(name);
  if (!existsSync(file)) {
    throw new AgentPOSError("CONFIG_INVALID", `Profile '${name}' not found`, {
      hint: "Run `agentpos-buyer init --profile <name>` to create it.",
      details: { file },
    });
  }
  const parsed = profileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new AgentPOSError("CONFIG_INVALID", `Profile '${name}' is invalid`, {
      hint: "Fix the fields listed in details or recreate the profile.",
      details: { issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

export function saveProfile(profile: Profile): string {
  mkdirSync(profilesDir(), { recursive: true });
  const file = profilePath(profile.name);
  writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export function listProfiles(): Profile[] {
  if (!existsSync(profilesDir())) return [];
  return readdirSync(profilesDir())
    .filter((f) => f.endsWith(".json") && !f.endsWith(".spending.json"))
    .map((f) => loadProfile(f.replace(/\.json$/, "")));
}

// --- out-of-band human approvals -------------------------------------------

function approvalsDir(profile: string): string {
  return join(profilesDir(), `${profile}.approvals`);
}

export interface PendingApproval {
  cartId: string;
  site: string;
  amount: string;
  summary: string;
  requestedAt: string;
  approvedAt?: string;
}

export function requestApproval(profile: string, pending: PendingApproval): void {
  mkdirSync(approvalsDir(profile), { recursive: true });
  const file = join(approvalsDir(profile), `${pending.cartId}.json`);
  if (!existsSync(file)) writeFileSync(file, `${JSON.stringify(pending, null, 2)}\n`);
}

export function getApproval(profile: string, cartId: string): PendingApproval | undefined {
  const file = join(approvalsDir(profile), `${cartId}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as PendingApproval) : undefined;
}

export function approve(profile: string, cartId: string): PendingApproval {
  const pending = getApproval(profile, cartId);
  if (!pending) {
    throw new AgentPOSError("CART_NOT_FOUND", `No pending approval for cart '${cartId}'`, {
      hint: "The agent must call buy first; it records the request when confirmation is required.",
    });
  }
  const approved = { ...pending, approvedAt: new Date().toISOString() };
  writeFileSync(
    join(approvalsDir(profile), `${cartId}.json`),
    `${JSON.stringify(approved, null, 2)}\n`,
  );
  return approved;
}

export function listPending(profile: string): PendingApproval[] {
  const dir = approvalsDir(profile);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as PendingApproval)
    .filter((p) => !p.approvedAt);
}

export function clearApproval(profile: string, cartId: string): void {
  const file = join(approvalsDir(profile), `${cartId}.json`);
  if (existsSync(file)) unlinkSync(file);
}
