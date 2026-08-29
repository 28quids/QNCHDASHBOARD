/**
 * Sets or resets a dashboard user's password.
 *
 * Uses the Supabase admin API with the service-role key, so it works without the old password
 * and without an email round trip. That key bypasses row-level security entirely, which is
 * why this is a local script and not an application route.
 *
 * The password is read from stdin with the terminal echo turned off, never from an argument.
 * An argument would be recorded in shell history and visible to `ps` while the process runs.
 *
 *   node scripts/set-dashboard-password.mjs you@example.com
 *   node scripts/set-dashboard-password.mjs --list
 */

import { createInterface } from "node:readline";
import { createClient } from "@supabase/supabase-js";
import { loadEnvFile, requireEnv } from "./lib/db.mjs";

const MINIMUM_LENGTH = 8;

const argv = process.argv.slice(2);
const listOnly = argv.includes("--list");
const email = argv.find((argument) => argument.includes("@"));

if (!listOnly && !email) {
  console.error("Usage: node scripts/set-dashboard-password.mjs <email>   (or --list)");
  process.exit(1);
}

const env = loadEnvFile();
const client = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL", env),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY", env),
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const { data: userList, error: listError } = await client.auth.admin.listUsers({ perPage: 200 });
if (listError) {
  console.error(`Could not list users: ${listError.message}`);
  process.exit(1);
}

if (listOnly) {
  console.log("--- dashboard accounts ---");
  for (const user of userList.users) {
    const confirmed = user.email_confirmed_at ? "confirmed" : "UNCONFIRMED";
    const seen = user.last_sign_in_at ? new Date(user.last_sign_in_at).toLocaleString("en-GB") : "never signed in";
    console.log(`  ${(user.email ?? "(no email)").padEnd(32)} ${confirmed.padEnd(12)} ${seen}`);
  }
  console.log("\nMembership of the QNCH organisation is separate: npm run grant:access -- --list");
  process.exit(0);
}

const user = userList.users.find((candidate) => candidate.email?.toLowerCase() === email.toLowerCase());
if (!user) {
  console.error(`No account with email ${email}.`);
  console.error(`Existing: ${userList.users.map((candidate) => candidate.email).join(", ") || "(none)"}`);
  console.error("\nCreate one in Supabase: Authentication > Users > Add user.");
  process.exit(1);
}

/**
 * Prompts twice on one readline interface.
 *
 * One interface, not two: closing a readline over stdin consumes the stream, so a second
 * interface never receives input and the process hangs on the confirmation prompt.
 *
 * Echo is suppressed by muting the output stream while a prompt is open, so the password is
 * never displayed. Newlines still pass through, otherwise the prompts would run together.
 */
async function readSecrets(prompts) {
  // Forcing terminal mode on a pipe makes readline wait for input that will never arrive in
  // the form it expects. There is also nothing to hide when stdin is not a terminal, since
  // nothing is being echoed to a screen.
  const interactive = Boolean(process.stdin.isTTY);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: interactive });

  let muted = false;
  const write = rl.output.write.bind(rl.output);
  rl.output.write = (chunk, ...rest) => {
    if (muted && interactive && typeof chunk === "string" && !chunk.includes("\n")) return true;
    return write(chunk, ...rest);
  };

  // Lines are buffered by a listener attached once, rather than by a per-prompt callback.
  // Piped input arrives faster than the prompts are issued, so a listener registered at the
  // second prompt would miss a line that had already been emitted.
  const pending = [];
  const waiting = [];
  rl.on("line", (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else pending.push(line);
  });

  let ended = false;
  rl.on("close", () => {
    ended = true;
    // Unblock anything still waiting, so a truncated stream fails rather than hanging.
    while (waiting.length > 0) waiting.shift()(null);
  });

  const nextLine = () =>
    pending.length > 0
      ? Promise.resolve(pending.shift())
      : ended
        ? Promise.resolve(null)
        : new Promise((resolve) => waiting.push(resolve));

  const answers = [];
  try {
    for (const prompt of prompts) {
      process.stdout.write(prompt);
      muted = true;
      const answer = await nextLine();
      muted = false;
      process.stdout.write("\n");
      if (answer === null) throw new Error("Input ended before every prompt was answered.");
      answers.push(answer);
    }
  } finally {
    rl.output.write = write;
    rl.close();
  }
  return answers;
}

const [password, again] = await readSecrets([`New password for ${user.email}: `, "Confirm: "]);

if (password !== again) {
  console.error("The two entries do not match. Nothing changed.");
  process.exit(1);
}
if (password.length < MINIMUM_LENGTH) {
  console.error(`Too short — use at least ${MINIMUM_LENGTH} characters. Nothing changed.`);
  process.exit(1);
}

const { error } = await client.auth.admin.updateUserById(user.id, {
  password,
  // A user added through the dashboard may never have confirmed their address, and an
  // unconfirmed account cannot sign in with a password however correct it is.
  email_confirm: true,
});

if (error) {
  console.error(`Could not set the password: ${error.message}`);
  process.exit(1);
}

console.log(`\nPassword set for ${user.email}.`);
console.log("Sign in at http://localhost:3000/login after running: npm run dev");
