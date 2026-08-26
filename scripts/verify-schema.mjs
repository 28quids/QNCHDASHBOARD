/**
 * Runs the read-only schema check in supabase/checks/0004_precheck.sql and prints the
 * results.
 *
 * `migrate.mjs --status` reports what the runner recorded in `schema_migrations`. This
 * inspects the database itself, so the two can be compared: a migration recorded as
 * applied but with its tables missing means the bookkeeping is lying.
 *
 *   node scripts/verify-schema.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function connectionString() {
  const line = readFileSync(join(ROOT, ".env.local"), "utf8")
    .split("\n")
    .find((candidate) => candidate.trim().startsWith("SUPABASE_DB_URL="));
  if (!line) throw new Error("SUPABASE_DB_URL not found in .env.local");
  return line.trim().slice("SUPABASE_DB_URL=".length).trim();
}

function printTable(rows) {
  if (rows.length === 0) {
    console.log("  (no rows)");
    return;
  }
  const columns = Object.keys(rows[0]);
  const width = Object.fromEntries(
    columns.map((column) => [
      column,
      Math.max(column.length, ...rows.map((row) => String(row[column] ?? "").length)),
    ]),
  );
  const line = (cells) => "  " + columns.map((c, i) => String(cells[i] ?? "").padEnd(width[c])).join("  ");

  console.log(line(columns));
  console.log("  " + columns.map((c) => "-".repeat(width[c])).join("  "));
  for (const row of rows) console.log(line(columns.map((c) => row[c])));
}

const client = new pg.Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  const sql = readFileSync(join(ROOT, "supabase", "checks", "0004_precheck.sql"), "utf8");
  const results = await client.query(sql);
  const sets = Array.isArray(results) ? results : [results];

  const missing = [];
  sets.forEach((set, index) => {
    console.log(`\n--- result set ${index + 1} ---`);
    printTable(set.rows);
    for (const row of set.rows) {
      if (row.state === "MISSING") missing.push(row.table_name ?? row.column_ref);
    }
  });

  console.log("");
  if (missing.length > 0) {
    console.log(`INCOMPLETE — ${missing.length} object(s) missing: ${missing.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("All expected tables and columns are present.");
  }
} finally {
  await client.end();
}
