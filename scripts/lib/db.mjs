/**
 * Shared connection handling for the operational scripts.
 *
 * These scripts run outside Next.js, so they cannot use lib/env.ts — that module validates
 * the whole server environment, including secrets a migration has no business needing.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Minimal .env parser: splits on the first `=` only, since base64 values contain padding.
 *
 * The return type is declared because TypeScript would otherwise infer `{}` from the empty
 * case, and every `.mts` script reading an optional variable off it would fail to compile.
 *
 * @param {string} [path]
 * @returns {Record<string, string | undefined>}
 */
export function loadEnvFile(path = join(ROOT, ".env.local")) {
  let contents;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  /** @type {Record<string, string | undefined>} */
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

export function requireEnv(key, env = loadEnvFile()) {
  const value = env[key];
  if (!value) {
    console.error(`${key} is not set in .env.local.`);
    process.exit(1);
  }
  if (value.includes("[YOUR-PASSWORD]")) {
    console.error(`${key} still contains the [YOUR-PASSWORD] placeholder.`);
    process.exit(1);
  }
  return value;
}

/** Connects using SUPABASE_DB_URL. The caller is responsible for calling `end()`. */
export async function connect() {
  const client = new pg.Client({
    connectionString: requireEnv("SUPABASE_DB_URL"),
    // The Supabase pooler presents a certificate this client has no CA bundle for. The
    // connection is still encrypted; it is not authenticated against a known CA.
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

/** Prints rows as an aligned table. */
export function printTable(rows) {
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
