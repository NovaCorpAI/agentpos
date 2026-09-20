/**
 * The outbound guard. Nothing here touches the network or DNS: the resolver and the fetch are
 * stubs, which is also the point (a test that needs the internet is a test that cannot prove
 * the internet is unreachable).
 */
import { describe, expect, it } from "vitest";
import { AgentPOSError } from "@agentpos/core";
import { assertPublicUrl, createGuardedFetch, ipRefusalReason } from "./ssrf.js";
import type { HostResolver } from "./ssrf.js";

/** A public address, the one every documentation example uses. */
const PUBLIC_IP = "93.184.216.34";
const publicResolver: HostResolver = async () => [PUBLIC_IP];
/** The resolver a DNS-rebinding attempt would hit: a public name pointing inside. */
const rebindResolver: HostResolver = async (hostname) =>
  hostname === "shop.example" ? [PUBLIC_IP] : ["10.1.2.3"];

async function refusalOf(promise: Promise<unknown>): Promise<AgentPOSError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AgentPOSError);
    return err as AgentPOSError;
  }
  throw new Error("expected a refusal, got a result");
}

function reasonOf(err: AgentPOSError): string {
  return String((err.details as { reason?: string } | undefined)?.reason);
}

// ---------------------------------------------------------------------------
describe("ipRefusalReason", () => {
  const blocked: Array<[string, string]> = [
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["0.0.0.0", "this-network"],
    ["10.0.0.5", "private"],
    ["10.255.255.255", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "link-local"],
    ["100.64.0.1", "carrier-nat"],
    ["192.0.0.1", "reserved"],
    ["198.18.0.1", "benchmark"],
    ["203.0.113.7", "documentation"],
    ["224.0.0.1", "multicast-or-reserved"],
    ["255.255.255.255", "multicast-or-reserved"],
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fc00::1", "unique-local"],
    ["fd12:3456:789a::1", "unique-local"],
    ["fe80::1", "link-local"],
    ["fe80::1%eth0", "link-local"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
    // IPv4 wearing an IPv6 costume: mapped, NAT64 and the deprecated compatible form.
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:10.0.0.1", "private"],
    ["::ffff:169.254.169.254", "link-local"],
    ["64:ff9b::192.168.0.1", "private"],
    ["::192.168.0.1", "ipv4-compatible"],
    ["not-an-address", "unparseable"],
  ];
  for (const [address, reason] of blocked) {
    it(`refuses ${address} as ${reason}`, () => {
      expect(ipRefusalReason(address)).toBe(reason);
    });
  }

  const allowed = [
    "93.184.216.34",
    "1.1.1.1",
    "172.32.0.1",
    "100.63.255.255",
    "2606:4700::1111",
    "::ffff:93.184.216.34",
  ];
  for (const address of allowed) {
    it(`allows the public address ${address}`, () => {
      expect(ipRefusalReason(address)).toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
describe("assertPublicUrl", () => {
  it("accepts an ordinary https store", async () => {
    const url = await assertPublicUrl("https://shop.example/agentpos/health", publicResolver);
    expect(url.host).toBe("shop.example");
  });

  it("refuses a hostname that resolves to a private address", async () => {
    const err = await refusalOf(assertPublicUrl("https://intranet.example", rebindResolver));
    expect(reasonOf(err)).toBe("private");
    expect(err.message).toContain("no es pública");
    expect(err.code).toBe("CONFIG_INVALID");
  });

  it("refuses localhost by the address it resolves to", async () => {
    const err = await refusalOf(
      assertPublicUrl("http://localhost/agentpos/health", async () => ["127.0.0.1"]),
    );
    expect(reasonOf(err)).toBe("loopback");
  });

  it("refuses every literal in the blocked families", async () => {
    for (const host of [
      "127.0.0.1",
      "10.0.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "[::1]",
      "[fc00::1]",
      "[::ffff:127.0.0.1]",
    ]) {
      const err = await refusalOf(assertPublicUrl(`http://${host}/`, publicResolver));
      expect(err.message).toContain("no es pública");
    }
  });

  it("refuses anything that is not http or https", async () => {
    for (const url of ["file:///etc/passwd", "ftp://shop.example/x", "gopher://shop.example"]) {
      const err = await refusalOf(assertPublicUrl(url, publicResolver));
      expect(reasonOf(err)).toBe("scheme");
    }
  });

  it("refuses a non-standard port and accepts the four allowed ones", async () => {
    const err = await refusalOf(assertPublicUrl("http://shop.example:22/", publicResolver));
    expect(reasonOf(err)).toBe("port");
    expect(
      (await refusalOf(assertPublicUrl("http://shop.example:6379/", publicResolver))).message,
    ).toContain("puerto");
    for (const port of ["80", "443", "8080", "8443"]) {
      await expect(
        assertPublicUrl(`https://shop.example:${port}/`, publicResolver),
      ).resolves.toBeInstanceOf(URL);
    }
    await expect(assertPublicUrl("https://shop.example/", publicResolver)).resolves.toBeInstanceOf(
      URL,
    );
  });

  it("refuses credentials smuggled into the URL", async () => {
    const err = await refusalOf(assertPublicUrl("https://user:pass@shop.example/", publicResolver));
    expect(reasonOf(err)).toBe("credentials");
  });

  it("reports a DNS failure as a plain error, not as a refusal", async () => {
    const failing: HostResolver = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(assertPublicUrl("https://no-such.example/", failing)).rejects.toThrow(
      /DNS lookup failed/,
    );
    await expect(assertPublicUrl("https://no-such.example/", failing)).rejects.not.toBeInstanceOf(
      AgentPOSError,
    );
    await expect(assertPublicUrl("https://empty.example/", async () => [])).rejects.toThrow(
      /returned nothing/,
    );
  });
});

// ---------------------------------------------------------------------------
describe("createGuardedFetch", () => {
  it("passes an ordinary request through and returns the body", async () => {
    const guarded = createGuardedFetch({
      resolve: publicResolver,
      fetchImpl: (async () => new Response("hola", { status: 200 })) as typeof globalThis.fetch,
    });
    const res = await guarded("https://shop.example/llms.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hola");
  });

  it("never calls the inner fetch for a private address", async () => {
    let calls = 0;
    const guarded = createGuardedFetch({
      resolve: publicResolver,
      fetchImpl: (async () => {
        calls += 1;
        return new Response("secret", { status: 200 });
      }) as typeof globalThis.fetch,
    });
    await refusalOf(guarded("http://169.254.169.254/latest/meta-data/"));
    expect(calls).toBe(0);
  });

  it("follows a same-host redirect", async () => {
    const seen: string[] = [];
    const guarded = createGuardedFetch({
      resolve: publicResolver,
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        seen.push(url);
        return url.endsWith("/moved")
          ? new Response(null, { status: 302, headers: { location: "/final" } })
          : new Response("done", { status: 200 });
      }) as typeof globalThis.fetch,
    });
    expect(await (await guarded("https://shop.example/moved")).text()).toBe("done");
    expect(seen).toEqual(["https://shop.example/moved", "https://shop.example/final"]);
  });

  it("refuses a redirect that leaves the host, public or private", async () => {
    const targets = ["http://169.254.169.254/latest/meta-data/", "https://evil.example/x"];
    for (const location of targets) {
      let calls = 0;
      const guarded = createGuardedFetch({
        resolve: publicResolver,
        fetchImpl: (async () => {
          calls += 1;
          return new Response(null, { status: 302, headers: { location } });
        }) as typeof globalThis.fetch,
      });
      const err = await refusalOf(guarded("https://shop.example/start"));
      expect(reasonOf(err)).toBe("redirect-off-host");
      // The second hop was never made.
      expect(calls).toBe(1);
    }
  });

  it("stops a redirect loop", async () => {
    const guarded = createGuardedFetch({
      resolve: publicResolver,
      maxRedirects: 2,
      fetchImpl: (async () =>
        new Response(null, {
          status: 307,
          headers: { location: "/again" },
        })) as typeof globalThis.fetch,
    });
    expect(reasonOf(await refusalOf(guarded("https://shop.example/again")))).toBe(
      "too-many-redirects",
    );
  });

  it("caps the response size", async () => {
    const guarded = createGuardedFetch({
      resolve: publicResolver,
      maxBytes: 1024,
      fetchImpl: (async () =>
        new Response("x".repeat(4096), { status: 200 })) as typeof globalThis.fetch,
    });
    expect(reasonOf(await refusalOf(guarded("https://shop.example/huge")))).toBe(
      "response-too-large",
    );
  });

  it("caps how many requests one instance may make", async () => {
    let calls = 0;
    const guarded = createGuardedFetch({
      resolve: publicResolver,
      maxRequests: 2,
      fetchImpl: (async () => {
        calls += 1;
        return new Response("ok", { status: 200 });
      }) as typeof globalThis.fetch,
    });
    await guarded("https://shop.example/1");
    await guarded("https://shop.example/2");
    expect(reasonOf(await refusalOf(guarded("https://shop.example/3")))).toBe("too-many-requests");
    expect(calls).toBe(2);
  });
});
