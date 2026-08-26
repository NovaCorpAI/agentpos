/**
 * `pnpm gate:check` (G1): runs every automatable production-gate criterion and prints a
 * green/red report. Manual items must carry evidence links in docs/GATE-G1.md. Exit 1 on any red.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
try {
  process.loadEnvFile(join(root, ".env"));
} catch {
  /* optional */
}

interface Item {
  id: string;
  title: string;
  kind: "auto" | "manual";
  run?: () => Promise<{ ok: boolean; note: string }>;
  evidenceKey?: string;
}

function sh(cmd: string, args: string[], cwd = root): { ok: boolean; out: string } {
  // pnpm is a .cmd shim on Windows and Node >= 20 refuses to spawn it without a shell (EINVAL);
  // its args here never contain spaces. docker gets no shell so paths with spaces stay intact.
  const useShell = process.platform === "win32" && cmd === "pnpm";
  const r = spawnSync(cmd, args, {
    cwd,
    shell: useShell,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
    windowsHide: true,
  });
  return {
    ok: r.status === 0,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`,
  };
}

const gateDoc = existsSync(join(root, "docs", "GATE-G1.md"))
  ? readFileSync(join(root, "docs", "GATE-G1.md"), "utf8")
  : "";
const evidence = (key: string): boolean =>
  new RegExp(`^- \\[x\\] ${key}\\b.*\\((?:https?://|docs/|#)[^)]+\\)`, "m").test(gateDoc);

const items: Item[] = [
  {
    id: "tests",
    title:
      "Unit + gate tests green (payment correctness, replay, re-quote, sad paths, rate limits, load, secrets)",
    kind: "auto",
    run: async () => {
      const r = sh("pnpm", ["test"]);
      const m = r.out.match(/Tests\s+(\d+) passed/g);
      return {
        ok: r.ok,
        note: r.ok
          ? `${m?.length ?? 0} suites passed`
          : r.out
              .split("\n")
              .filter((l) => /FAIL|×|Error/.test(l))
              .slice(0, 5)
              .join(" | "),
      };
    },
  },
  {
    id: "typecheck-lint",
    title: "Typecheck and lint clean",
    kind: "auto",
    run: async () => {
      const t = sh("pnpm", ["typecheck"]);
      const l = sh("pnpm", ["lint"]);
      return {
        ok: t.ok && l.ok,
        note: `${t.ok ? "typecheck ok" : "typecheck FAILED"}, ${l.ok ? "lint ok" : "lint FAILED"}`,
      };
    },
  },
  {
    id: "audit",
    title: "Dependency audit (pnpm audit --prod) with no known vulnerabilities; lockfile committed",
    kind: "auto",
    run: async () => {
      const r = sh("pnpm", ["audit", "--prod"]);
      const lock = existsSync(join(root, "pnpm-lock.yaml"));
      return {
        ok: r.ok && lock,
        note: `${r.ok ? "no known vulnerabilities" : r.out.trim().split("\n").slice(-3).join(" | ")}; lockfile ${lock ? "present" : "MISSING"}`,
      };
    },
  },
  {
    id: "secrets-history",
    title: "Full git history scanned for secrets (gitleaks)",
    kind: "auto",
    run: async () => {
      const docker = sh("docker", ["info"]);
      if (!docker.ok)
        return {
          ok: evidence("secrets-history"),
          note: "docker unavailable; relying on documented evidence",
        };
      const r = sh("docker", [
        "run",
        "--rm",
        "-v",
        `${root}:/repo`,
        "ghcr.io/gitleaks/gitleaks:latest",
        "git",
        "/repo",
        "--config",
        "/repo/.gitleaks.toml",
        "--redact",
        "--exit-code",
        "1",
      ]);
      const ran = /leaks found|no leaks/i.test(r.out);
      if (!ran)
        return {
          ok: evidence("secrets-history"),
          note: `gitleaks did not run (${r.out.trim().split("\n").pop()}); relying on documented evidence`,
        };
      const leaks = /(\d+) leaks? found/i.exec(r.out);
      return {
        ok: r.ok,
        note: r.ok
          ? "no leaks in full history"
          : `LEAKS FOUND (${leaks?.[1] ?? "?"}): rotate before opening the repo`,
      };
    },
  },
  {
    id: "facilitator",
    title: "Facilitator reachable for the configured network with the configured key",
    kind: "auto",
    run: async () => {
      const { checkFacilitator, configFromEnv } = await import("@agentgate/core");
      const cfg = configFromEnv(process.env);
      const h = await checkFacilitator(cfg);
      return {
        ok: h.ok,
        note: `${cfg.facilitatorUrl} -> ${h.status ?? h.error} supports ${cfg.caip2}: ${h.supportsNetwork}`,
      };
    },
  },
  {
    id: "no-secrets-in-config",
    title: "Startup refuses configurations carrying private keys (zero custody)",
    kind: "auto",
    run: async () => {
      const { assertNoSecretsInConfig } = await import("@agentgate/core");
      const { Keypair } = await import("@stellar/stellar-sdk");
      let threw = false;
      try {
        assertNoSecretsInConfig({ payTo: Keypair.random().secret() });
      } catch {
        threw = true;
      }
      return {
        ok: threw,
        note: threw ? "seed in config is rejected" : "seed in config was ACCEPTED",
      };
    },
  },
  {
    id: "runbook",
    title: "Runbook with an action per alert (docs/RUNBOOK.md)",
    kind: "manual",
    evidenceKey: "runbook",
  },
  {
    id: "backup-restore",
    title: "Backup and restore rehearsed on a real data dir",
    kind: "manual",
    evidenceKey: "backup-restore",
  },
  {
    id: "dependency-review",
    title: "Manual review of small/unknown dependencies",
    kind: "manual",
    evidenceKey: "dependency-review",
  },
  {
    id: "e2e-testnet",
    title: "Real testnet e2e (XLM and USDC) passed recently with tx hashes",
    kind: "manual",
    evidenceKey: "e2e-testnet",
  },
];

async function main(): Promise<void> {
  const results: Array<{ id: string; kind: string; ok: boolean; note: string }> = [];
  for (const item of items) {
    let ok = false;
    let note = "";
    if (item.kind === "auto" && item.run) {
      try {
        ({ ok, note } = await item.run());
      } catch (err) {
        note = err instanceof Error ? err.message : String(err);
      }
    } else if (item.evidenceKey) {
      ok = evidence(item.evidenceKey);
      note = ok ? "evidence linked in docs/GATE-G1.md" : "no evidence link in docs/GATE-G1.md";
    }
    results.push({ id: item.id, kind: item.kind, ok, note });
    console.log(
      `${ok ? "[32mPASS[0m" : "[31mFAIL[0m"}  ${item.id.padEnd(22)} ${item.title}\n      ${note}`,
    );
  }
  const green = results.every((r) => r.ok);
  const report = { generatedAt: new Date().toISOString(), green, results };
  writeFileSync(join(root, "docs", "gate-g1.report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `\nGate G1: ${green ? "[32m100% GREEN[0m" : "[31mRED[0m"} (${results.filter((r) => r.ok).length}/${results.length}). Report: docs/gate-g1.report.json`,
  );
  // exitCode (not process.exit) lets Windows close child-process handles cleanly.
  if (!green) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
