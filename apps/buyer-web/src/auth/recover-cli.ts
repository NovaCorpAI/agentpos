/**
 * Last resort: prints a one-time recovery URL for whoever can already run commands on the
 * box this space lives on.
 *
 *   node dist/auth/recover-cli.js https://agente.example
 *   pnpm --filter @agentpos/buyer-web recover-url      # local, uses BUYER_WEB_PORT
 *
 * When to reach for it: the owner lost the password AND has no recovery codes AND the
 * WhatsApp channel is not configured (or the phone is gone too). It replaces "edit the env
 * vars and restart" as the documented way back in: it does not touch the account, it does
 * not close anyone's session, and it works without a rebuild.
 *
 * What it is, said plainly in the output too: a link that bypasses the password. It is
 * single use, it expires in fifteen minutes, only its scrypt hash is stored, and issuing it
 * lands in the access log the owner reads on /activity. The URL is printed to stdout and
 * nowhere else: it never reaches the structured log.
 */
import { AuthService } from "./service.js";
import { configFromEnv } from "../config.js";
import { BuyerWebStorage } from "../storage.js";

function baseUrl(config: { port: number }): string {
  const fromArgv = process.argv[2];
  const raw = (fromArgv ?? process.env.BUYER_WEB_PUBLIC_URL ?? "").trim();
  if (raw.length === 0) return `http://localhost:${String(config.port)}`;
  try {
    return new URL(raw).origin;
  } catch {
    process.stderr.write(
      `'${raw}' is not a URL. Pass the public origin, e.g. https://agente.example, or set BUYER_WEB_PUBLIC_URL.\n`,
    );
    process.exit(2);
  }
}

async function main(): Promise<void> {
  const config = configFromEnv();
  const origin = baseUrl(config);
  const storage = new BuyerWebStorage(config.dbFile);
  const auth = new AuthService({ storage });
  if (!auth.hasOwner()) {
    process.stderr.write(
      `No owner account exists in ${config.dbFile} yet, so there is nothing to recover.\nCreate it at ${origin}/setup, or with BUYER_WEB_OWNER_EMAIL + BUYER_WEB_OWNER_PASSWORD_HASH.\n`,
    );
    storage.close();
    process.exit(2);
  }
  const { token, expiresAt } = await auth.issueOperatorToken();
  storage.close();
  process.stdout.write(
    [
      "",
      "One-time recovery URL (open it in a browser):",
      "",
      `  ${origin}/recuperar/operador?t=${token}`,
      "",
      `It expires at ${expiresAt} (15 minutes) and works exactly once.`,
      "",
      "Read this before you use it:",
      "  - This link BYPASSES the password. Anyone holding it can set a new one.",
      "  - Issuing it and using it are both written to the access log the owner reads",
      "    on /activity, with the time and the origin. That is on purpose.",
      "  - Setting the new password closes every open session, including any that are not",
      "    the owner's.",
      "  - Only its scrypt hash is stored here. Nobody can read the link back out of the",
      "    database, so if you lose it, run this again and the old one stops working.",
      "  - Prefer a recovery code (/cuenta -> Generar códigos nuevos) next time: it needs",
      "    nobody with a shell on this server.",
      "",
    ].join("\n"),
  );
}

await main();
