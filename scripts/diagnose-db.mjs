/**
 * Works out why a Postgres connection is being refused.
 *
 * "password authentication failed" is ambiguous on Supabase: it is returned both for a
 * genuinely wrong password and for a pooler hostname pointing at the wrong region, because
 * the pooler cannot resolve the tenant and fails the handshake either way.
 *
 * This tries each documented route to the same database and reports what each one says, so
 * the two causes can be told apart. It reads the password from .env.local and never prints
 * it.
 *
 *   node scripts/diagnose-db.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import pg from "pg";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readConnectionString() {
  const line = readFileSync(join(ROOT, ".env.local"), "utf8")
    .split("\n")
    .find((candidate) => candidate.trim().startsWith("SUPABASE_DB_URL="));
  if (!line) throw new Error("SUPABASE_DB_URL not found in .env.local");
  return line.trim().slice("SUPABASE_DB_URL=".length).trim();
}

const configured = new URL(readConnectionString());
const password = decodeURIComponent(configured.password);
const projectRef = decodeURIComponent(configured.username).split(".")[1] ?? "unknown";
const region = configured.hostname.match(/aws-\d+-([a-z0-9-]+)\.pooler/)?.[1] ?? "unknown";

console.log(`project ref : ${projectRef}`);
console.log(`region      : ${region}  (from the pooler hostname)`);
console.log(`password    : ${password.length} characters\n`);

const routes = [
  {
    label: "Session pooler  :5432 (as configured)",
    host: configured.hostname,
    port: 5432,
    user: decodeURIComponent(configured.username),
  },
  {
    label: "Transaction pooler :6543",
    host: configured.hostname,
    port: 6543,
    user: decodeURIComponent(configured.username),
  },
  {
    label: "Direct connection :5432",
    host: `db.${projectRef}.supabase.co`,
    port: 5432,
    user: "postgres",
  },
];

function reachable(host, port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("timeout");
    }, timeoutMs);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve("open");
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      resolve(error.code ?? error.message);
    });
  });
}

for (const route of routes) {
  console.log(route.label);
  const tcp = await reachable(route.host, route.port);
  console.log(`  tcp    : ${tcp}`);

  if (tcp !== "open") {
    console.log("");
    continue;
  }

  const client = new pg.Client({
    host: route.host,
    port: route.port,
    user: route.user,
    password,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  try {
    await client.connect();
    const { rows } = await client.query("select current_user, version()");
    console.log(`  auth   : SUCCESS as ${rows[0].current_user}`);
    console.log(`  server : ${rows[0].version.split(" ").slice(0, 2).join(" ")}`);
    await client.end();
  } catch (error) {
    console.log(`  auth   : ${error.code ?? ""} ${error.message}`.trim());
    try {
      await client.end();
    } catch {
      // The client never connected; nothing to close.
    }
  }
  console.log("");
}
