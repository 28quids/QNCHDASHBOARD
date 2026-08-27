/**
 * Grants a Supabase Auth user access to the QNCH organisation.
 *
 * Signing up creates an auth user and, via the trigger in migration 0002, a profile. Neither
 * grants access to anything: every read policy checks `organisation_members`, so a brand new
 * account signs in successfully and then sees nothing. This is the step that connects them.
 *
 * Roles: owner and finance_admin may edit costs, targets and policy; operator and viewer read.
 *
 *   node scripts/grant-access.mjs alfie@example.com            # owner
 *   node scripts/grant-access.mjs someone@example.com viewer
 *   node scripts/grant-access.mjs --list
 */

import { connect, loadEnvFile, printTable, requireEnv } from "./lib/db.mjs";

const ROLES = ["owner", "finance_admin", "operator", "viewer"];

const argv = process.argv.slice(2);
const listOnly = argv.includes("--list");
const [email, role = "owner"] = argv.filter((argument) => !argument.startsWith("--"));

if (!listOnly && !email) {
  console.error("Usage: node scripts/grant-access.mjs <email> [role]   (or --list)");
  process.exit(1);
}
if (!listOnly && !ROLES.includes(role)) {
  console.error(`Unknown role "${role}". Choose one of: ${ROLES.join(", ")}`);
  process.exit(1);
}

const env = loadEnvFile();
const organisationId = requireEnv("ORGANISATION_ID", env);
const client = await connect();

try {
  if (listOnly) {
    const members = await client.query(
      `select u.email, m.role, m.created_at
       from public.organisation_members m
       join auth.users u on u.id = m.user_id
       where m.organisation_id = $1
       order by m.role, u.email`,
      [organisationId],
    );
    console.log("--- members ---");
    printTable(members.rows);
    process.exit(0);
  }

  const user = await client.query("select id from auth.users where lower(email) = lower($1)", [email]);
  if (user.rows.length === 0) {
    console.error(`No auth user with email ${email}.`);
    console.error("Create the account first: Supabase dashboard → Authentication → Users → Add user.");
    process.exit(1);
  }
  const userId = user.rows[0].id;

  await client.query("begin");

  // The trigger creates the profile on signup, but an account created before that migration
  // ran would have none, and organisation_members references profiles rather than auth.users.
  await client.query(
    `insert into public.profiles (id, display_name)
     values ($1, $2)
     on conflict (id) do nothing`,
    [userId, email],
  );

  await client.query(
    `insert into public.organisation_members (organisation_id, user_id, role)
     values ($1, $2, $3)
     on conflict (organisation_id, user_id) do update set role = excluded.role`,
    [organisationId, userId, role],
  );

  await client.query("commit");

  console.log(`${email} is now "${role}" on the QNCH organisation.`);

  const members = await client.query(
    `select u.email, m.role
     from public.organisation_members m
     join auth.users u on u.id = m.user_id
     where m.organisation_id = $1
     order by m.role, u.email`,
    [organisationId],
  );
  console.log("\n--- members ---");
  printTable(members.rows);
} catch (error) {
  await client.query("rollback").catch(() => {});
  console.error(`Failed, rolled back: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
