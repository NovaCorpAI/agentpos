/**
 * Re-vendors the official protocol schemas we validate against (guardrail 3, and the G3 task
 * "declare which version the sidecar publishes against").
 *
 * The schemas live in the repo rather than being fetched at runtime, so conformance checks work
 * offline and a spec site going down cannot change what we accept. That only stays honest if
 * re-vendoring is a command rather than a memory, hence this script.
 *
 *   pnpm --filter @agentgate/core vendor:schemas            # check for drift, write nothing
 *   pnpm --filter @agentgate/core vendor:schemas -- --write # update the vendored copies
 *
 * After writing, update PROTOCOL_VERSIONS in src/adapter/versions.ts, run the conformance tests,
 * and record the change in docs/adapter-versions.md.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const write = process.argv.includes("--write");

interface Source {
  name: string;
  /** GitHub repo in owner/name form. */
  repo: string;
  /** Branch or tag to vendor from. Pinned: never "main". */
  ref: string;
  /** Path inside the repo whose subtree we copy. */
  from: string;
  /** Destination under packages/core/schemas. */
  to: string;
  /** Local fixtures under `to` that upstream does not ship and that must not be swept. */
  keep?: string[];
}

const SOURCES: Source[] = [
  {
    name: "UCP",
    repo: "Universal-Commerce-Protocol/ucp",
    ref: "release/2026-08-25",
    from: "source/schemas",
    to: "schemas/ucp",
    // Our own conformance fixture, not part of the upstream schema set.
    keep: ["example.profile_response.json"],
  },
  {
    name: "ACP",
    repo: "agentic-commerce-protocol/agentic-commerce-protocol",
    ref: "main",
    from: "spec/2026-04-17/json-schema",
    to: "schemas/acp",
    keep: ["examples.feed.json"],
  },
];

interface TreeEntry {
  path: string;
  type: string;
}

async function listTree(source: Source): Promise<string[]> {
  const url = `https://api.github.com/repos/${source.repo}/git/trees/${encodeURIComponent(source.ref)}?recursive=1`;
  const res = await fetch(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "agentgate-vendor-schemas" },
  });
  if (!res.ok) throw new Error(`${source.name}: GitHub answered ${res.status} for ${url}`);
  const body = (await res.json()) as { tree?: TreeEntry[]; truncated?: boolean };
  if (body.truncated) throw new Error(`${source.name}: tree truncated; narrow the ref`);
  return (body.tree ?? [])
    .filter((e) => e.type === "blob" && e.path.startsWith(`${source.from}/`) && e.path.endsWith(".json"))
    .map((e) => e.path);
}

async function fetchRaw(source: Source, path: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${source.repo}/${source.ref}/${path}`;
  const res = await fetch(url, { headers: { "user-agent": "agentgate-vendor-schemas" } });
  if (!res.ok) throw new Error(`${source.name}: ${res.status} for ${url}`);
  return res.text();
}

async function vendor(source: Source): Promise<{ changed: string[]; added: string[]; removed: string[] }> {
  const paths = await listTree(source);
  if (paths.length === 0) throw new Error(`${source.name}: no schemas found under ${source.from}`);

  const changed: string[] = [];
  const added: string[] = [];
  const seen = new Set<string>();

  for (const path of paths) {
    const relative = path.slice(source.from.length + 1);
    const dest = join(ROOT, source.to, relative);
    seen.add(dest);
    const incoming = await fetchRaw(source, path);
    const current = existsSync(dest) ? readFileSync(dest, "utf8") : undefined;
    if (current === undefined) added.push(relative);
    else if (current !== incoming) changed.push(relative);
    if (write && current !== incoming) {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, incoming);
    }
  }

  // Files we hold that the upstream release no longer ships: stale copies are worse than
  // missing ones, because they keep validating against a spec nobody publishes.
  const removed: string[] = [];
  const localRoot = join(ROOT, source.to);
  const walk = (dir: string): string[] => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  };
  const keep = new Set((source.keep ?? []).map((f) => join(localRoot, f)));
  for (const file of walk(localRoot)) {
    if (!file.endsWith(".json") || seen.has(file) || keep.has(file)) continue;
    removed.push(file.slice(localRoot.length + 1));
    if (write) rmSync(file);
  }
  return { changed, added, removed };
}

let drift = false;
for (const source of SOURCES) {
  const { changed, added, removed } = await vendor(source);
  const total = changed.length + added.length + removed.length;
  if (total === 0) {
    console.log(`${source.name} @ ${source.ref}: vendored copies match upstream`);
    continue;
  }
  drift = true;
  console.log(`${source.name} @ ${source.ref}: ${total} file(s) differ`);
  for (const f of added) console.log(`  + ${f}`);
  for (const f of changed) console.log(`  ~ ${f}`);
  for (const f of removed) console.log(`  - ${f}`);
}

if (drift && !write) {
  console.log("\nRun with --write to update, then update src/adapter/versions.ts and re-run tests.");
  process.exitCode = 1;
}
