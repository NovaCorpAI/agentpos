#!/usr/bin/env node
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
