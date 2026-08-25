#!/usr/bin/env node
// node:sqlite prints an ExperimentalWarning on Node 22/24; re-exec once with it silenced so the
// CLI output stays clean for merchants. Everything else is unchanged.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
if (process.execArgv.some((a) => a.startsWith("--no-warnings"))) {
  await import(cli);
} else {
  const result = spawnSync(
    process.execPath,
    ["--no-warnings=ExperimentalWarning", cli, ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}
