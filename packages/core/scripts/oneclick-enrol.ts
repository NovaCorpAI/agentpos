/**
 * Oneclick enrolment helper for the Transbank INTEGRATION environment. The one step a script
 * cannot do is the bank's card form, so this does everything around it:
 *
 *   1. starts an inscription at Transbank with a local return URL,
 *   2. opens a page that POSTs the TBK_TOKEN to Transbank's enrolment form (you fill the test card),
 *   3. receives Transbank's redirect back, finishes the inscription and prints the `tbk_user`.
 *
 * With that `tbk_user` the Oneclick charge (the mode in which the agent buys alone) can be
 * exercised live: POST {base}/checkout/card?cart=<id> with { enrolment: { username, tbkUser } }.
 *
 * Public integration credentials from Transbank's docs repo; no money moves. Opt in explicitly:
 *
 *   AGENTPOS_E2E_TRANSBANK=1 pnpm --filter @agentpos/core e2e:transbank:enrol
 *
 * Test card for integration (from the docs): 4051 8856 0044 6623, CVV 123, any future expiry.
 * When the bank simulator asks: RUT 11.111.111-1, password 123.
 */
import { createServer } from "node:http";
import { PROTOCOL_VERSIONS } from "../src/adapter/versions.js";

if (process.env.AGENTPOS_E2E_TRANSBANK !== "1") {
  console.log(
    "oneclick-enrol: skipped (set AGENTPOS_E2E_TRANSBANK=1 to talk to the integration environment)",
  );
  process.exit(0);
}

const HOST = PROTOCOL_VERSIONS.transbank.hosts.integration;
const V = PROTOCOL_VERSIONS.transbank.version;
const PORT = Number(process.env.ONECLICK_ENROL_PORT ?? 8420);
const MALL = process.env.TRANSBANK_ONECLICK_MALL_CODE || "597055555541";
const API_KEY =
  process.env.TRANSBANK_API_KEY ||
  "579B532A7440BB0C9079DED94D31EA1615BACEB56610332264630D42D0A36B1C";
const USERNAME = process.env.ONECLICK_USERNAME || `agentpos-${Date.now().toString(36)}`;
const EMAIL = process.env.ONECLICK_EMAIL || "e2e@agentposhq.com";

const headers = {
  "Tbk-Api-Key-Id": MALL,
  "Tbk-Api-Key-Secret": API_KEY,
  "content-type": "application/json",
};

async function startInscription(): Promise<{ token: string; url: string }> {
  const res = await fetch(`${HOST}/rswebpaytransaction/api/oneclick/v${V}/inscriptions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      username: USERNAME,
      email: EMAIL,
      response_url: `http://localhost:${PORT}/return`,
    }),
  });
  const data = (await res.json()) as {
    token?: string;
    url_webpay?: string;
    error_message?: string;
  };
  if (!res.ok || !data.token || !data.url_webpay) {
    throw new Error(
      `start inscription failed (${res.status}): ${data.error_message ?? JSON.stringify(data)}`,
    );
  }
  return { token: data.token, url: data.url_webpay };
}

async function finishInscription(token: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${HOST}/rswebpaytransaction/api/oneclick/v${V}/inscriptions/${token}`, {
    method: "PUT",
    headers,
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok)
    throw new Error(`finish inscription failed (${res.status}): ${JSON.stringify(data)}`);
  return data;
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="es"><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;line-height:1.5">${body}</body></html>`;
}

const inscription = await startInscription();
console.log(
  `inscription started for username "${USERNAME}" (token ${inscription.token.slice(0, 10)}...)`,
);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname === "/") {
    // Transbank's enrolment form expects the token POSTed as TBK_TOKEN. Auto-submit it.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      page(
        "Inscripción Oneclick",
        `<h1 style="font-size:1.3rem">Inscribiendo la tarjeta de prueba en Transbank (integración)</h1>
<p>Si no avanza solo, pulsa el botón. En el formulario usa la tarjeta <code>4051 8856 0044 6623</code>, CVV <code>123</code>, cualquier vencimiento futuro; en el banco simulado, RUT <code>11.111.111-1</code> y clave <code>123</code>.</p>
<form id="f" method="POST" action="${inscription.url}"><input type="hidden" name="TBK_TOKEN" value="${inscription.token}"><button type="submit">Ir a Transbank</button></form>
<script>document.getElementById("f").submit()</script>`,
      ),
    );
    return;
  }
  if (url.pathname === "/return") {
    let token = url.searchParams.get("TBK_TOKEN") ?? undefined;
    if (req.method === "POST") {
      const raw = await new Promise<string>((resolve) => {
        let s = "";
        req.on("data", (c: Buffer) => (s += c.toString()));
        req.on("end", () => resolve(s));
      });
      token = new URLSearchParams(raw).get("TBK_TOKEN") ?? token;
    }
    if (!token) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(
        page("Sin token", "<p>Transbank volvió sin TBK_TOKEN: la inscripción fue cancelada.</p>"),
      );
      console.error("return without TBK_TOKEN (cancelled)");
      server.close();
      return;
    }
    try {
      const done = await finishInscription(token);
      const ok = done.response_code === 0;
      const tbkUser = (done.tbk_user ?? done.transbank_user) as string | undefined;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        page(
          ok ? "Tarjeta inscrita" : "Inscripción rechazada",
          ok
            ? `<h1 style="font-size:1.3rem">Tarjeta inscrita</h1><p>Puedes cerrar esta página; el <code>tbk_user</code> quedó en la terminal.</p>`
            : `<h1 style="font-size:1.3rem">Inscripción rechazada</h1><pre>${JSON.stringify(done, null, 2)}</pre>`,
        ),
      );
      if (ok && tbkUser) {
        console.log("");
        console.log("ONECLICK ENROLMENT OK");
        console.log(`  username : ${USERNAME}`);
        console.log(`  tbk_user : ${tbkUser}`);
        console.log(
          `  card     : ${String(done.card_type ?? "?")} ${String(done.card_number ?? "")}`,
        );
        console.log("");
        console.log("Charge it with no human step:");
        console.log(
          `  curl -X POST "https://<store>/agentpos/checkout/card?cart=<cartId>" -H "content-type: application/json" -d '{"enrolment":{"username":"${USERNAME}","tbkUser":"${tbkUser}"}}'`,
        );
      } else {
        console.error("enrolment not approved:", JSON.stringify(done));
      }
    } catch (err) {
      res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
      res.end(page("Error", `<pre>${String(err)}</pre>`));
      console.error(String(err));
    }
    server.close();
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`open http://localhost:${PORT}/ in a browser and complete the card form`);
  console.log("(the browser must be on this machine: Transbank redirects to localhost)");
});
