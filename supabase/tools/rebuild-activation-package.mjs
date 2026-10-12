#!/usr/bin/env node
// Regenerates supabase/PRODUCTION_ACTIVATION_001_002_003.sql from the real
// migration files, so the embedded bodies and their SHA-256 header hashes are
// always in sync with supabase/migrations/.
//
// It keeps the existing package's operator-facing prose (header, PRE-FLIGHT and
// POST-FLIGHT sections) untouched and only replaces the three embedded migration
// bodies and their recorded hashes. Run from the repo root:
//
//   node supabase/tools/rebuild-activation-package.mjs
//
// The output is written in place; review `git diff` before committing.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const PKG = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_001_002_003.sql");

const MIGRATIONS = [
  "001_core_security.sql",
  "002_tenant_isolation_hardening.sql",
  "003_sales_lifecycle.sql",
];

const SEP = "-- " + "=".repeat(74);
const text = readFileSync(PKG, "utf8");

// Start of the separator line that precedes a given marker line.
function sepLineStart(marker) {
  const at = text.indexOf(marker);
  if (at < 0) return -1;
  return text.lastIndexOf("\n", at - 2) + 1;
}

const firstBegin = sepLineStart(`-- BEGIN ${MIGRATIONS[0]}`);
const postFlight = sepLineStart("-- POST-FLIGHT");
if (firstBegin < 0 || postFlight < 0) {
  throw new Error("Could not locate the BEGIN 001 / POST-FLIGHT markers in the package.");
}

const prefix = text.slice(0, firstBegin);
const suffix = text.slice(postFlight);

const blocks = MIGRATIONS.map((name) => {
  const body = readFileSync(path.join(ROOT, "supabase", "migrations", name), "utf8");
  const hash = createHash("sha256").update(body, "utf8").digest("hex");
  return `${SEP}\n-- BEGIN ${name}\n-- SHA-256 (body): ${hash}\n${SEP}\n\n${body}\n`;
});

const out = prefix + blocks.join("") + suffix;
writeFileSync(PKG, out);

for (const name of MIGRATIONS) {
  const body = readFileSync(path.join(ROOT, "supabase", "migrations", name), "utf8");
  const hash = createHash("sha256").update(body, "utf8").digest("hex");
  console.log(`recorded ${hash}  ${name}`);
}
console.log(`wrote ${path.relative(ROOT, PKG)}`);
