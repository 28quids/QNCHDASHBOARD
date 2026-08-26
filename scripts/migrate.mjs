/**
 * Applies the SQL migrations in supabase/migrations to the database in SUPABASE_DB_URL.
 *
 * There is no Supabase CLI, psql or Docker on the development machine, so migrations were
 * previously applied by pasting each file into the dashboard SQL editor by hand. That has
 * no record of what ran, so the only way to know the schema state was to go and look.
 *
 * This runner keeps that record in `public.schema_migrations`, applies only what is
 * outstanding, and does so in filename order.
 *
 *   node scripts/migrate.mjs --status   report what is applied and what is pending
 *   node scripts/migrate.mjs            apply every pending migration
 *
 * Each migration and its bookkeeping row commit together, so a migration can never be
 * recorded as applied unless it actually was, and vice versa.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

/** Minimal .env parser: split on the first `=` only, since base64 values contain padding. */
function loadEnvFile(path) {
  let contents;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const values = {};
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    values[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return values;
}

/**
 * The migration files carry their own `begin;`/`commit;` so they stay safe to paste into
 * the SQL editor by hand. This runner supplies its own transaction covering both the
 * migration and its bookkeeping row, so the file's own wrapper is removed first —
 * otherwise the file's `commit;` would close the transaction early and leave the
 * `schema_migrations` insert running outside it.
 */
function stripOwnTransaction(sql) {
  return sql.replace(/^\s*begin\s*;\s*$/im, "").replace(/^\s*commit\s*;\s*$/im, "");
}

async function main() {
  const statusOnly = process.argv.includes("--status");
  const env = { ...loadEnvFile(join(ROOT, ".env.local")), ...process.env };
  const connectionString = env.SUPABASE_DB_URL;

  if (!connectionString) {
    console.error("SUPABASE_DB_URL is not set. Add it to .env.local — see the comment in that file.");
    process.exit(1);
  }
  if (connectionString.includes("[YOUR-PASSWORD]")) {
    console.error("SUPABASE_DB_URL still contains the [YOUR-PASSWORD] placeholder.");
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString,
    // The Supabase pooler presents a certificate this client has no CA bundle for. The
    // connection is still encrypted; it is not authenticated against a known CA.
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log(`Connected to ${new URL(connectionString).host}\n`);

  try {
    await client.query(`
      create table if not exists public.schema_migrations (
        version text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const applied = new Set(
      (await client.query("select version from public.schema_migrations")).rows.map((row) => row.version),
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort();

    const pending = files.filter((name) => !applied.has(name));

    for (const name of files) {
      console.log(`  ${applied.has(name) ? "applied " : "PENDING "} ${name}`);
    }
    console.log("");

    if (statusOnly) {
      console.log(`${applied.size} applied, ${pending.length} pending.`);
      return;
    }
    if (pending.length === 0) {
      console.log("Nothing to do — the schema is up to date.");
      return;
    }

    for (const name of pending) {
      const sql = stripOwnTransaction(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
      process.stdout.write(`Applying ${name} ... `);
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into public.schema_migrations (version) values ($1)", [name]);
        await client.query("commit");
        console.log("ok");
      } catch (error) {
        await client.query("rollback");
        console.log("FAILED — rolled back, no partial schema left behind\n");
        console.error(`  ${error.message}`);
        if (error.position) console.error(`  at character ${error.position}`);
        if (error.hint) console.error(`  hint: ${error.hint}`);
        console.error(`\nStopped at ${name}. Migrations after it were not attempted.`);
        process.exitCode = 1;
        return;
      }
    }

    console.log(`\nApplied ${pending.length} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
