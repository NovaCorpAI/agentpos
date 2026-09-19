/**
 * Prints the scrypt hash of a password, so an automated deploy can set
 * BUYER_WEB_OWNER_PASSWORD_HASH without a plaintext password ever reaching an env file,
 * a compose file or the repository.
 *
 *   pnpm --filter @agentpos/buyer-web hash-password      # asks on stdin
 *   echo 'mi contrasena larga' | node dist/auth/hash-cli.js
 *
 * The password is read from stdin (or BUYER_WEB_OWNER_PASSWORD), never from an argument:
 * arguments show up in `ps` and in shell history.
 */
import { MIN_PASSWORD_LENGTH } from "./service.js";
import { hashPassword } from "./scrypt.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const fromEnv = process.env.BUYER_WEB_OWNER_PASSWORD;
  if (process.argv.length > 2) {
    process.stderr.write(
      "Do not pass the password as an argument: it would land in `ps` and in your shell history.\nUse stdin, or BUYER_WEB_OWNER_PASSWORD in the environment.\n",
    );
    process.exit(2);
  }
  let password = fromEnv ?? "";
  if (password.length === 0) {
    if (process.stdin.isTTY) process.stderr.write("Password (it is not echoed back): ");
    password = (await readStdin()).replace(/\r?\n$/, "");
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    process.stderr.write(
      `The password needs at least ${String(MIN_PASSWORD_LENGTH)} characters.\n`,
    );
    process.exit(2);
  }
  process.stdout.write(`${await hashPassword(password)}\n`);
}

await main();
