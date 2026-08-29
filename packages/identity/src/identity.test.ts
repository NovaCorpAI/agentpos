/**
 * M3 acceptance criteria: valid signatures pass, foreign ones fail, out-of-window timestamps
 * fail, replayed nonces fail, revocation is immediate, and verified-only refuses anonymous
 * wallets with an actionable message.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { AgentGateError, createMemoryLogger } from "@agentgate/core";
import {
  AGENT_ATTESTATION_HEADER,
  AGENT_ID_HEADER,
  AGENT_NONCE_HEADER,
  AGENT_SIGNATURE_HEADER,
  REQUEST_WINDOW_SECONDS,
  encodeAttestation,
  signAttestation,
  signRequest,
  verifyAttestation,
} from "./index.js";
import { IdentityService } from "./service.js";
import type { IdentityMode } from "./service.js";
import type { SignedAttestation } from "./attestation.js";

const owner = Keypair.random();
const agent = Keypair.random();
const stranger = Keypair.random();

const request = { method: "POST", path: "/agentgate/cart", body: JSON.stringify({ items: [] }) };

function attestation(over: Partial<Parameters<typeof signAttestation>[1]> = {}): SignedAttestation {
  return signAttestation(owner.secret(), {
    v: "agentgate-attestation-1",
    agent: agent.publicKey(),
    owner: owner.publicKey(),
    name: "Ada's shopping agent",
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...over,
  });
}

function headersOf(map: Record<string, string>) {
  return (name: string) => map[name.toLowerCase()];
}

function service(mode: IdentityMode = "identified", over: { siteHost?: string } = {}) {
  const logger = createMemoryLogger();
  return {
    svc: new IdentityService({ mode, logger, ...(over.siteHost ? { siteHost: over.siteHost } : {}) }),
    logger,
  };
}

describe("agent request signatures", () => {
  it("accepts a correctly signed request and records who signed it", () => {
    const { svc } = service();
    const identity = svc.authenticate(headersOf(signRequest(agent.secret(), request)), request);
    expect(identity).toMatchObject({ authenticated: true, agentKey: agent.publicKey(), attested: false });
  });

  it("rejects a signature made by another key", () => {
    const { svc } = service();
    const headers = signRequest(stranger.secret(), request);
    headers[AGENT_ID_HEADER] = agent.publicKey(); // claim to be the agent, sign as the stranger
    try {
      svc.authenticate(headersOf(headers), request);
      expect.unreachable();
    } catch (err) {
      expect((err as AgentGateError).code).toBe("AGENT_SIGNATURE_INVALID");
    }
  });

  it("rejects a signature bound to a different request", () => {
    const { svc } = service();
    const headers = signRequest(agent.secret(), request);
    const tampered = { ...request, body: JSON.stringify({ items: [{ itemId: "free-mug" }] }) };
    expect(() => svc.authenticate(headersOf(headers), tampered)).toThrowError(/does not match this request/);
    expect(() => svc.authenticate(headersOf(headers), { ...request, path: "/agentgate/checkout" })).toThrowError(AgentGateError);
    expect(() => svc.authenticate(headersOf(headers), { ...request, method: "GET" })).toThrowError(AgentGateError);
  });

  it("rejects timestamps outside the window", () => {
    const { svc } = service();
    const stale = String(Math.floor(Date.now() / 1000) - REQUEST_WINDOW_SECONDS - 5);
    const headers = signRequest(agent.secret(), { ...request, timestamp: stale });
    try {
      svc.authenticate(headersOf(headers), request);
      expect.unreachable();
    } catch (err) {
      expect((err as AgentGateError).code).toBe("AGENT_TIMESTAMP_OUT_OF_WINDOW");
    }
  });

  it("refuses a replayed nonce, and only spends it on valid signatures", () => {
    const { svc } = service();
    const headers = signRequest(agent.secret(), request);
    expect(svc.authenticate(headersOf(headers), request).authenticated).toBe(true);
    try {
      svc.authenticate(headersOf(headers), request);
      expect.unreachable();
    } catch (err) {
      expect((err as AgentGateError).code).toBe("AGENT_NONCE_REUSED");
    }
    // A bad signature must not burn the nonce it claimed.
    const fresh = signRequest(agent.secret(), request);
    const forged = { ...fresh, [AGENT_SIGNATURE_HEADER]: signRequest(stranger.secret(), request)[AGENT_SIGNATURE_HEADER] };
    expect(() => svc.authenticate(headersOf(forged), request)).toThrowError(AgentGateError);
    expect(svc.authenticate(headersOf(fresh), request).authenticated).toBe(true);
  });

  it("rejects incomplete header sets", () => {
    const { svc } = service();
    const headers = signRequest(agent.secret(), request);
    delete (headers as Record<string, string>)[AGENT_NONCE_HEADER];
    expect(() => svc.authenticate(headersOf(headers), request)).toThrowError(/Incomplete agent signature/);
  });
});

describe("owner attestations", () => {
  it("verifies a well-formed attestation and refuses tampering", () => {
    const signed = attestation();
    expect(verifyAttestation(signed, { agentKey: agent.publicKey() }).valid).toBe(true);
    // change a field after signing
    const tampered = { ...signed, attestation: { ...signed.attestation, agent: stranger.publicKey() } };
    expect(verifyAttestation(tampered).valid).toBe(false);
    // an attestation about another agent does not authorize this one
    expect(verifyAttestation(signed, { agentKey: stranger.publicKey() }).reason).toMatch(/different agent/);
  });

  it("refuses expired or not-yet-valid attestations", () => {
    const expired = attestation({ issuedAt: new Date(Date.now() - 7200_000).toISOString(), expiresAt: new Date(Date.now() - 3600_000).toISOString() });
    expect(verifyAttestation(expired).reason).toMatch(/expired/);
    const future = attestation({ issuedAt: new Date(Date.now() + 3600_000).toISOString(), expiresAt: new Date(Date.now() + 7200_000).toISOString() });
    expect(verifyAttestation(future).reason).toMatch(/not yet valid/);
  });

  it("honours the site scope the owner set", () => {
    const scoped = attestation({ scope: { sites: ["shop.example"] } });
    expect(verifyAttestation(scoped, { siteHost: "shop.example" }).valid).toBe(true);
    expect(verifyAttestation(scoped, { siteHost: "other.example" }).reason).toMatch(/does not cover/);
  });

  it("refuses to sign an attestation with a key that is not the owner", () => {
    expect(() =>
      signAttestation(stranger.secret(), {
        v: "agentgate-attestation-1",
        agent: agent.publicKey(),
        owner: owner.publicKey(),
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      }),
    ).toThrowError(/not the attested owner/);
  });
});

describe("identity modes", () => {
  it("open lets anonymous wallets through", () => {
    const { svc } = service("open");
    expect(svc.authenticate(headersOf({}), request)).toMatchObject({ authenticated: false, attested: false });
  });

  it("identified allows anonymous but still enforces any signature that is sent", () => {
    const { svc } = service("identified");
    expect(svc.authenticate(headersOf({}), request).authenticated).toBe(false);
    const forged = { ...signRequest(agent.secret(), request), [AGENT_SIGNATURE_HEADER]: "AAAA" };
    expect(() => svc.authenticate(headersOf(forged), request)).toThrowError(AgentGateError);
  });

  it("verified-only refuses anonymous wallets with an actionable message", () => {
    const { svc } = service("verified-only");
    try {
      svc.authenticate(headersOf({}), request);
      expect.unreachable();
    } catch (err) {
      const e = err as AgentGateError;
      expect(e.code).toBe("AGENT_IDENTITY_REQUIRED");
      expect(e.hint).toContain(AGENT_ATTESTATION_HEADER);
    }
  });

  it("verified-only refuses a signed agent with no attestation, and accepts one with it", () => {
    const { svc } = service("verified-only");
    const bare = signRequest(agent.secret(), request);
    try {
      svc.authenticate(headersOf(bare), request);
      expect.unreachable();
    } catch (err) {
      expect((err as AgentGateError).code).toBe("AGENT_ATTESTATION_INVALID");
    }
    const withAttestation = { ...signRequest(agent.secret(), request), [AGENT_ATTESTATION_HEADER]: encodeAttestation(attestation()) };
    const identity = svc.authenticate(headersOf(withAttestation), request);
    expect(identity).toMatchObject({ authenticated: true, attested: true, owner: owner.publicKey(), name: "Ada's shopping agent" });
  });

  it("registers an agent on first valid attestation and remembers it afterwards", () => {
    const { svc } = service("verified-only");
    svc.authenticate(headersOf({ ...signRequest(agent.secret(), request), [AGENT_ATTESTATION_HEADER]: encodeAttestation(attestation()) }), request);
    expect(svc.list().map((r) => r.agentKey)).toEqual([agent.publicKey()]);
    // later requests need no attestation header: the registry carries it
    const identity = svc.authenticate(headersOf(signRequest(agent.secret(), request)), request);
    expect(identity.attested).toBe(true);
  });
});

describe("registry and revocation", () => {
  it("revokes immediately: the very next request is refused", () => {
    const { svc } = service("identified");
    svc.register(attestation());
    expect(svc.authenticate(headersOf(signRequest(agent.secret(), request)), request).authenticated).toBe(true);

    svc.revoke(agent.publicKey(), "Owner reported the key as compromised");
    try {
      svc.authenticate(headersOf(signRequest(agent.secret(), request)), request);
      expect.unreachable();
    } catch (err) {
      const e = err as AgentGateError;
      expect(e.code).toBe("AGENT_REVOKED");
      expect(e.hint).toMatch(/compromised/);
    }
    expect(svc.list({ status: "active" })).toHaveLength(0);
  });

  it("refuses to register an invalid attestation and to revoke an unknown agent", () => {
    const { svc } = service();
    const tampered = { ...attestation(), signature: Buffer.from("nope").toString("base64") };
    expect(() => svc.register(tampered)).toThrowError(/Cannot register/);
    expect(() => svc.revoke(stranger.publicKey())).toThrowError(/Unknown agent/);
  });

  it("sweeps spent nonces once their window passes", () => {
    const { svc } = service();
    svc.authenticate(headersOf(signRequest(agent.secret(), request)), request);
    expect(svc.sweepNonces(new Date())).toBe(0);
    expect(svc.sweepNonces(new Date(Date.now() + (REQUEST_WINDOW_SECONDS + 5) * 1000))).toBe(1);
  });
});
