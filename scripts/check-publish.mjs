#!/usr/bin/env node
// Refuses a release whose packages are not ready to be installed from npm.
//
//   node scripts/check-publish.mjs 0.1.0
//
// Every non-private package under packages/ must: carry exactly that version; point
// `repository` at this repo and its own directory (npm provenance checks it); ship `dist`
// (built) or `bin`; have the README that `files` promises; declare `workspace:^` (never
// `workspace:*`) for sibling packages, so a patch release of one does not force the rest;
// and request public access. Each failure is printed; the exit code is the count.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const expected = process.argv[2];
if (!expected || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(expected)) {
  console.error("usage: node scripts/check-publish.mjs <version>");
  process.exit(2);
}
const REPO_URL = "git+https://github.com/NovaCorpAI/agentpos.git";
const failures = [];
const fail = (name, msg) => failures.push(`${name}: ${msg}`);

const dirs = readdirSync("packages").filter((d) => existsSync(join("packages", d, "package.json")));
let checked = 0;
for (const dir of dirs) {
  const root = join("packages", dir);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.private) continue;
  checked += 1;
  const name = pkg.name;
  if (pkg.version !== expected) fail(name, `version ${pkg.version} != ${expected}`);
  if (pkg.repository?.url !== REPO_URL) fail(name, `repository.url must be ${REPO_URL}`);
  if (pkg.repository?.directory !== `packages/${dir}`)
    fail(name, `repository.directory must be packages/${dir}`);
  if (pkg.publishConfig?.access !== "public") fail(name, "publishConfig.access must be public");
  if (pkg.license !== "Apache-2.0") fail(name, "license must be Apache-2.0");
  if (!pkg.engines?.node) fail(name, "engines.node missing");
  const files = pkg.files ?? [];
  if (!files.includes("README.md") || !existsSync(join(root, "README.md")))
    fail(name, "README.md must exist and be in files");
  if (pkg.main) {
    if (!files.includes("dist")) fail(name, "dist not in files");
    if (!existsSync(join(root, pkg.main))) fail(name, `${pkg.main} missing (run pnpm build)`);
    if (pkg.types && !existsSync(join(root, pkg.types))) fail(name, `${pkg.types} missing`);
  }
  for (const [cmd, rel] of Object.entries(pkg.bin ?? {})) {
    if (!files.some((f) => rel.startsWith(`./${f}/`) || rel === `./${f}`))
      fail(name, `bin ${cmd} (${rel}) not covered by files`);
    if (!existsSync(join(root, rel))) fail(name, `bin ${cmd} -> ${rel} missing`);
    else if (!readFileSync(join(root, rel), "utf8").startsWith("#!/usr/bin/env node"))
      fail(name, `bin ${rel} lacks the node shebang`);
  }
  for (const extra of files) {
    if (["dist", "bin", "README.md"].includes(extra)) continue;
    if (!existsSync(join(root, extra))) fail(name, `files entry ${extra} does not exist`);
    else if (
      statSync(join(root, extra)).isDirectory() &&
      readdirSync(join(root, extra)).length === 0
    )
      fail(name, `files entry ${extra} is empty`);
  }
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
      if (String(range).startsWith("workspace:") && range !== "workspace:^")
        fail(name, `${field}.${dep} is ${range}; use workspace:^`);
      if (String(range).startsWith("link:") || String(range).startsWith("file:"))
        fail(name, `${field}.${dep} is ${range}; not publishable`);
    }
  }
}

if (failures.length) {
  console.error(`${failures.length} problem(s) across ${checked} public package(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(Math.min(failures.length, 125));
}
console.log(`ok: ${checked} public packages ready to publish as ${expected}`);
