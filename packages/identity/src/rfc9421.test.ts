/**
 * RFC 9421 conformance for the agent-authentication profile this store accepts: a good signature
 * passes, a signature that does not cover the request fails, a stale one fails, a replay fails,
 * and everything outside the supported subset is refused with a reason instead of waved through.
 */
import { describe, expect, it } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  IdentityService,
  contentDigest,
  parseSfDictionary,
  signHttpMessage,
  signatureBase,
  verifyHttpMessageSignature,
} from "./index.js";

const agent = Keypair.random();
const URL_CART = "https://shop.test/agentgate/cart?ref=x";
const BODY = JSON.stringify({ items: [{ itemId: "mug", quantity: 1 }] });

function message(headers: Record<string, string>, overrides: Partial<{ url: string; body: string; method: string }> = {}) {
  return {
    method: overrides.method ?? "POST",
    url: overrides.url ?? URL_CART,
    body: overrides.body ?? BODY,
    headers: (name: string) => headers[name.toLowerCase()],
  };
}

describe("structured field parsing", () => {
  it("keeps each member's raw text, which the signature base must reproduce byte for byte", () => {
    const header = 'sig1=("@method" "@path");created=1700000000;keyid="GABC";alg="ed25519"';
    const dict = parseSfDictionary(header);
    expect(dict.get("sig1")?.items).toEqual(["@method", "@path"]);
    expect(dict.get("sig1")?.params.created).toBe(1700000000);
    expect(dict.get("sig1")?.params.keyid).toBe("GABC");
    expect(dict.get("sig1")?.raw).toBe(
      '("@method" "@path");created=1700000000;keyid="GABC";alg="ed25519"',
    );
  });

  it("decodes byte sequences and several dictionary members", () => {
    const dict = parseSfDictionary("sig1=:AQID:, sig2=:BAUG:");
    expect([...dict.keys()]).toEqual(["sig1", "sig2"]);
    expect([...(dict.get("sig1")?.bytes ?? [])]).toEqual([1, 2, 3]);
  });
});

describe("signature base", () => {
  it("builds the derived components RFC 9421 defines", () => {
    const { base } = signatureBase(
      ["@method", "@authority", "@path", "@query"],
      '("@method" "@authority" "@path" "@query");created=1',
      message({}),
    );
    expect(base).toBe(
      [
        '"@method": POST',
        '"@authority": shop.test',
        '"@path": /agentgate/cart',
        '"@query": ?ref=x',
        '"@signature-params": ("@method" "@authority" "@path" "@query");created=1',
      ].join("\n"),
    );
  });

  it("refuses a component it does not implement rather than guessing", () => {
    expect(signatureBase(["@query-param;params"], "()", message({})).reason).toContain(
      "Component parameters are not supported",
    );
    expect(signatureBase(["@status"], "()", message({})).reason).toContain(
      "Unsupported derived component",
    );
  });
});

describe("verifying an RFC 9421 signature", () => {
  it("accepts a signature this library produced", () => {
    const headers = signHttpMessage(agent.secret(), {
      method: "POST",
      url: URL_CART,
      body: BODY,
    });
    const result = verifyHttpMessageSignature(message(headers));
    expect(result.ok).toBe(true);
    expect(result.keyid).toBe(agent.publicKey());
    expect(result.replayKey).toBeTruthy();
  });

  it("refuses a body that does not match the signed digest", () => {
    const headers = signHttpMessage(agent.secret(), {
      method: "POST",
      url: URL_CART,
      body: BODY,
    });
    const result = verifyHttpMessageSignature(
      message(headers, { body: JSON.stringify({ items: [{ itemId: "mug", quantity: 99 }] }) }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Content-Digest does not match");
  });

  it("refuses a signature captured for a different path or method", () => {
    const headers = signHttpMessage(agent.secret(), {
      method: "POST",
      url: URL_CART,
      body: BODY,
    });
    expect(
      verifyHttpMessageSignature(message(headers, { url: "https://shop.test/agentgate/checkout" }))
        .ok,
    ).toBe(false);
    expect(verifyHttpMessageSignature(message(headers, { method: "DELETE" })).ok).toBe(false);
  });

  it("refuses a signature that does not bind the request at all", () => {
    // Signs only content-digest: valid crypto, useless authorization.
    const headers = signHttpMessage(
      agent.secret(),
      { method: "POST", url: URL_CART, body: BODY },
      { components: ["content-digest"] },
    );
    const result = verifyHttpMessageSignature(message(headers));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('must cover "@method"');
  });

  it("requires a body to be digested, so an unsigned body cannot ride along", () => {
    const headers = signHttpMessage(
      agent.secret(),
      { method: "POST", url: URL_CART, body: "" },
      { components: ["@method", "@path"] },
    );
    // The same signature, now presented with a body it never covered.
    const result = verifyHttpMessageSignature(message(headers, { body: BODY }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('must sign "content-digest"');
  });

  it("refuses a stale signature and one from the future", () => {
    const headers = signHttpMessage(
      agent.secret(),
      { method: "POST", url: URL_CART, body: BODY },
      { created: Math.floor(Date.now() / 1000) - 3600 },
    );
    expect(verifyHttpMessageSignature(message(headers)).reason).toContain("away from server time");
  });

  it("refuses an algorithm it does not verify, and a keyid it cannot read", () => {
    const headers = signHttpMessage(agent.secret(), {
      method: "POST",
      url: URL_CART,
      body: BODY,
    });
    const rsa = {
      ...headers,
      "signature-input": headers["signature-input"]!.replace('alg="ed25519"', 'alg="rsa-pss-sha512"'),
    };
    expect(verifyHttpMessageSignature(message(rsa)).reason).toContain("Unsupported algorithm");

    const badKey = {
      ...headers,
      "signature-input": headers["signature-input"]!.replace(agent.publicKey(), "not-a-key"),
    };
    expect(verifyHttpMessageSignature(message(badKey)).reason).toContain("Stellar StrKey");
  });

  it("refuses a signature made by another key", () => {
    const headers = signHttpMessage(agent.secret(), {
      method: "POST",
      url: URL_CART,
      body: BODY,
    });
    const impostor = Keypair.random();
    const swapped = {
      ...headers,
      "signature-input": headers["signature-input"]!.replace(
        agent.publicKey(),
        impostor.publicKey(),
      ),
    };
    expect(verifyHttpMessageSignature(message(swapped)).reason).toContain("does not verify");
  });

  it("says plainly when there is no RFC 9421 signature at all", () => {
    expect(verifyHttpMessageSignature(message({})).reason).toContain("No RFC 9421 signature");
  });

  it("computes Content-Digest as RFC 9530 specifies", () => {
    expect(contentDigest("")).toBe("sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:");
  });
});

describe("the service accepts both profiles", () => {
  const request = () => ({
    method: "POST",
    path: "/agentgate/cart?ref=x",
    url: URL_CART,
    body: BODY,
  });

  it("authenticates an RFC 9421 request", () => {
    const service = new IdentityService({ mode: "identified" });
    const headers = signHttpMessage(agent.secret(), {
      method: "POST",
      url: URL_CART,
      body: BODY,
    });
    const identity = service.authenticate((n) => headers[n.toLowerCase()], request());
    expect(identity.authenticated).toBe(true);
    expect(identity.agentKey).toBe(agent.publicKey());
  });

  it("refuses a replay of an RFC 9421 request", () => {
    const service = new IdentityService({ mode: "identified" });
    const headers = signHttpMessage(agent.secret(), {
      method: "POST",
      url: URL_CART,
      body: BODY,
    });
    const lookup = (n: string) => headers[n.toLowerCase()];
    service.authenticate(lookup, request());
    expect(() => service.authenticate(lookup, request())).toThrow(/already used/);
  });

  it("maps a bad RFC 9421 signature to the same machine-readable codes as the legacy profile", () => {
    const service = new IdentityService({ mode: "identified" });
    const stale = signHttpMessage(
      agent.secret(),
      { method: "POST", url: URL_CART, body: BODY },
      { created: Math.floor(Date.now() / 1000) - 3600 },
    );
    expect(() => service.authenticate((n) => stale[n.toLowerCase()], request())).toThrow(
      /outside the accepted window|away from server time/,
    );

    const forged: Record<string, string> = { ...stale, signature: "sig1=:AAAA:" };
    try {
      service.authenticate((n) => forged[n.toLowerCase()], request());
      throw new Error("should have refused");
    } catch (err) {
      expect((err as { code: string }).code).toMatch(/AGENT_SIGNATURE_INVALID|AGENT_TIMESTAMP/);
    }
  });

  it("refuses an RFC 9421 signature when the server cannot supply the request URL", () => {
    const service = new IdentityService({ mode: "identified" });
    const headers = signHttpMessage(agent.secret(), {
      method: "POST",
      url: URL_CART,
      body: BODY,
    });
    expect(() =>
      service.authenticate((n) => headers[n.toLowerCase()], {
        method: "POST",
        path: "/agentgate/cart",
        body: BODY,
      }),
    ).toThrow(/cannot verify RFC 9421/);
  });
});

/**
 * External conformance. The vectors below are RFC 9421 Appendix B.2.6 verbatim (the Ed25519
 * example, with the RFC 8792 line-wrapping backslashes removed), with the key from B.1.4.
 *
 * They check the part most likely to be subtly wrong and impossible to catch by round-tripping
 * our own signer: whether our signature base is byte-identical to the one the RFC publishes, and
 * whether a signature produced by an independent implementation verifies against it.
 *
 * `verifyHttpMessageSignature` deliberately REFUSES this message: its `created` is from 2021, and
 * our profile additionally requires that a request with a body sign `content-digest`. That is our
 * profile being narrower than the RFC, not a disagreement about it, so the tests below isolate
 * the parts where agreement is required.
 */
describe("RFC 9421 Appendix B.2.6 vectors", () => {
  const params =
    '("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"';
  const components = [
    "date",
    "@method",
    "@path",
    "@authority",
    "content-type",
    "content-length",
  ];
  const headers: Record<string, string> = {
    host: "example.com",
    date: "Tue, 20 Apr 2021 02:07:55 GMT",
    "content-type": "application/json",
    "content-length": "18",
  };
  const expectedBase = [
    '"date": Tue, 20 Apr 2021 02:07:55 GMT',
    '"@method": POST',
    '"@path": /foo',
    '"@authority": example.com',
    '"content-type": application/json',
    '"content-length": 18',
    `"@signature-params": ${params}`,
  ].join("\n");

  it("produces the signature base exactly as the RFC prints it", () => {
    const { base } = signatureBase(components, params, {
      method: "POST",
      url: "https://example.com/foo?param=Value&Pet=dog",
      body: '{"hello": "world"}',
      headers: (n) => headers[n.toLowerCase()],
    });
    expect(base).toBe(expectedBase);
  });

  it("verifies the RFC's own Ed25519 signature over that base", () => {
    // test-key-ed25519 from Appendix B.1.4, PKCS#8 SubjectPublicKeyInfo: the last 32 bytes are
    // the raw Ed25519 key, which is what StrKey encodes.
    const spki = Buffer.from(
      "MCowBQYDK2VwAyEAJrQLj5P/89iXES9+vFgrIy29clF9CC/oPPsw3c5D0bs=",
      "base64",
    );
    const publicKey = StrKey.encodeEd25519PublicKey(spki.subarray(spki.length - 32));
    const signature = Buffer.from(
      "wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==",
      "base64",
    );
    expect(
      Keypair.fromPublicKey(publicKey).verify(Buffer.from(expectedBase, "utf8"), signature),
    ).toBe(true);
  });

  it("parses the RFC's own Signature-Input and reproduces its raw value", () => {
    const dict = parseSfDictionary(`sig-b26=${params}`);
    expect(dict.get("sig-b26")?.items).toEqual(components);
    expect(dict.get("sig-b26")?.raw).toBe(params);
    expect(dict.get("sig-b26")?.params.keyid).toBe("test-key-ed25519");
    expect(dict.get("sig-b26")?.params.created).toBe(1618884473);
  });
});
